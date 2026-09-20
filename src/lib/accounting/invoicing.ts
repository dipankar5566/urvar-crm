import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { resolveTaxRate, priceLine, isInterState, resolvePlaceOfSupply, TaxRateError } from "./tax";
import { add, money, mul, round, roundToRupee, roundToScale, sub, sum, toAmountString, type Money } from "./money";
import { logAudit } from "@/lib/audit";
import { syncCustomerOutstanding } from "./receivables";
import { weightedAverageCost } from "./costing";

/**
 * Order -> Invoice conversion, and the posting that follows it.
 *
 * Everything here runs inside one transaction: pricing an invoice with a
 * stale tax rate is a data-integrity bug the same way an unbalanced journal
 * entry is, so create-and-post are atomic, never two steps a caller could
 * interleave with something else.
 */

export class InvoicingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoicingError";
  }
}

export type InvoiceLineInput = {
  orderItemId: string;
  /** Defaults to the order item's remaining uninvoiced quantity. */
  quantity?: string | number;
};

export type CreateInvoiceFromOrderInput = {
  orderId: string;
  invoiceDate: Date;
  dueDate?: Date | null;
  /** Omit to invoice every line's full remaining quantity. */
  lines?: InvoiceLineInput[];
  freightAmount?: string | number;
  discountAmount?: string | number;
  notes?: string | null;
  termsAndConditions?: string | null;
  createdById: string;
};

export type CreateInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string;
  totalAmount: string;
  journalEntryId: string;
  journalEntryNumber: string;
};

type OrderItemRow = {
  id: string;
  productId: string | null;
  description: string;
  unitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  quantityInvoiced: Prisma.Decimal;
};

async function prepareLine(
  tx: Prisma.TransactionClient,
  item: OrderItemRow,
  qty: Money,
  asOf: Date,
  interState: boolean,
) {
  const product = item.productId
    ? await tx.product.findUnique({ where: { id: item.productId }, select: { hsnCode: true, unit: true } })
    : null;
  const hsnCode = product?.hsnCode;
  if (!hsnCode) {
    throw new TaxRateError(
      `"${item.description}" has no HSN code on its product record. An HSN code ` +
        `is required before this line can be invoiced.`,
    );
  }
  const rate = await resolveTaxRate(hsnCode, asOf, tx);
  const priced = priceLine({ quantity: qty, unitPrice: item.unitPrice }, rate, interState);

  // Informational only — never posted to the ledger. This CRM runs periodic
  // costing (see StockValuation), so COGS reaches the P&L at period close,
  // not per invoice; this is purely a margin snapshot for the invoice's own
  // record. Null when the product has no purchase history yet — never
  // defaulted to zero, which would misreport margin as 100%.
  const avgCost = item.productId ? await weightedAverageCost(item.productId, asOf, tx) : null;
  const estimatedUnitCost = avgCost ? roundToScale(avgCost, 4) : null;
  const estimatedCostAmount = estimatedUnitCost ? round(mul(qty, estimatedUnitCost)) : null;

  return { item, qty, hsnCode, unit: product?.unit ?? "unit", priced, estimatedUnitCost, estimatedCostAmount };
}

/**
 * Create a SalesInvoice from an Order (optionally a subset of its lines, for
 * partial invoicing), price every line through the tax engine, and post it —
 * one transaction, one function.
 */
export async function createInvoiceFromOrder(
  input: CreateInvoiceFromOrderInput,
  existingTx?: Prisma.TransactionClient,
): Promise<CreateInvoiceResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<CreateInvoiceResult> => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        customer: true,
        items: { orderBy: { lineNumber: "asc" } },
      },
    });
    if (!order) throw new InvoicingError("Order not found.");
    if (order.status === "CANCELLED") throw new InvoicingError("Cannot invoice a cancelled order.");
    if (order.items.length === 0) {
      throw new InvoicingError(
        "This order has no line items to invoice. Orders created before Phase 2 " +
          "carry only a total and cannot be invoiced until backfilled.",
      );
    }

    const company = await requireCompany(tx);
    const placeOfSupply = resolvePlaceOfSupply(order.customer.state);
    const interState = isInterState(company.state, placeOfSupply);

    const requested = new Map((input.lines ?? []).map((l) => [l.orderItemId, l]));
    const toInvoice = input.lines ? order.items.filter((i) => requested.has(i.id)) : order.items;
    if (toInvoice.length === 0) throw new InvoicingError("No matching order lines to invoice.");

    const prepared: Awaited<ReturnType<typeof prepareLine>>[] = [];
    for (const item of toInvoice) {
      const req = requested.get(item.id);
      const remaining = sub(item.quantity, item.quantityInvoiced);
      const qty = req?.quantity !== undefined ? money(req.quantity) : remaining;

      if (qty.lessThanOrEqualTo(0)) {
        throw new InvoicingError(`Line "${item.description}" has nothing left to invoice.`);
      }
      if (qty.greaterThan(remaining)) {
        throw new InvoicingError(
          `Cannot invoice ${toAmountString(qty)} of "${item.description}" — only ` +
            `${toAmountString(remaining)} remains uninvoiced.`,
        );
      }
      prepared.push(await prepareLine(tx, item, qty, input.invoiceDate, interState));
    }

    const subtotal = round(sum(prepared.map((p) => p.priced.taxableValue)));
    const cgst = round(sum(prepared.map((p) => p.priced.cgstAmount)));
    const sgst = round(sum(prepared.map((p) => p.priced.sgstAmount)));
    const igst = round(sum(prepared.map((p) => p.priced.igstAmount)));
    const cess = round(sum(prepared.map((p) => p.priced.cessAmount)));
    const freight = round(input.freightAmount ?? 0);
    const discount = round(input.discountAmount ?? 0);

    const beforeRounding = add(
      sub(add(subtotal, freight), discount),
      add(add(cgst, sgst), add(igst, cess)),
    );
    const { rounded: totalAmount, adjustment: roundOff } = roundToRupee(beforeRounding);

    const financialYear = financialYearOf(input.invoiceDate, company.fyStartMonth);
    const invoiceNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.SALES_INVOICE,
      financialYear,
      fyStartMonth: company.fyStartMonth,
    });

    const invoice = await tx.salesInvoice.create({
      data: {
        invoiceNumber,
        companyId: company.id,
        customerId: order.customerId,
        orderId: order.id,
        quotationId: order.quotationId,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        placeOfSupply,
        isInterState: interState,
        customerGstin: order.customer.gstNumber,
        sellerGstin: company.gstin,
        sellerState: company.state,
        subtotal,
        discountAmount: discount,
        freightAmount: freight,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        cessAmount: cess,
        roundOff,
        totalAmount,
        status: "POSTED",
        notes: input.notes ?? null,
        termsAndConditions: input.termsAndConditions ?? null,
        createdById: input.createdById,
        items: {
          create: prepared.map((p, i) => ({
            productId: p.item.productId,
            description: p.item.description,
            hsnCode: p.hsnCode,
            unit: p.unit,
            quantity: p.qty,
            unitPrice: p.item.unitPrice,
            discountPercent: 0,
            taxableValue: p.priced.taxableValue,
            taxRatePercent: p.priced.taxRatePercent,
            cgstAmount: p.priced.cgstAmount,
            sgstAmount: p.priced.sgstAmount,
            igstAmount: p.priced.igstAmount,
            cessAmount: p.priced.cessAmount,
            lineTotal: p.priced.lineTotal,
            estimatedUnitCost: p.estimatedUnitCost,
            estimatedCostAmount: p.estimatedCostAmount,
            lineNumber: i + 1,
          })),
        },
      },
    });

    for (const p of prepared) {
      await tx.orderItem.update({
        where: { id: p.item.id },
        data: { quantityInvoiced: add(p.item.quantityInvoiced, p.qty) },
      });
    }

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [
      { accountKey: "AR_TRADE", debit: totalAmount, partyType: "CUSTOMER", partyId: order.customerId },
      { accountKey: "SALES_REVENUE", credit: subtotal },
    ];
    if (freight.greaterThan(0)) lines.push({ accountKey: "FREIGHT_RECOVERED", credit: freight });
    if (discount.greaterThan(0)) lines.push({ accountKey: "DISCOUNT_ALLOWED", debit: discount });
    if (cgst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_CGST", credit: cgst });
    if (sgst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_SGST", credit: sgst });
    if (igst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_IGST", credit: igst });
    if (cess.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_CESS", credit: cess });
    if (!roundOff.isZero()) {
      // roundOff = rounded - exact. AR_TRADE was just debited the ROUNDED
      // total, while SALES_REVENUE + tax only sum to the exact pre-rounding
      // amount — so when rounding UP increased the total (roundOff positive),
      // AR captured more than revenue accounts for, and ROUND_OFF must be
      // CREDITED to make up the difference. Rounding DOWN is the mirror case.
      lines.push(
        roundOff.isPositive()
          ? { accountKey: "ROUND_OFF", credit: roundOff }
          : { accountKey: "ROUND_OFF", debit: roundOff.abs() },
      );
    }

    const posted = await postJournalEntry(
      {
        entryDate: input.invoiceDate,
        narration: `Sales invoice ${invoiceNumber} to ${order.customer.name}`,
        sourceType: "SALES_INVOICE",
        sourceId: invoice.id,
        idempotencyKey: `SALES_INVOICE:${invoice.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: { postedEntryId: posted.entryId, postedAt: new Date() },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "SalesInvoice",
        entityId: invoice.id,
        newValue: { invoiceNumber, orderId: order.id, totalAmount: toAmountString(totalAmount) },
      },
      tx,
    );

    await syncCustomerOutstanding(order.customerId, tx);

    return {
      invoiceId: invoice.id,
      invoiceNumber,
      totalAmount: toAmountString(totalAmount),
      journalEntryId: posted.entryId,
      journalEntryNumber: posted.entryNumber,
    };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelInvoiceInput = {
  invoiceId: string;
  reason: string;
  cancelledById: string;
};

/**
 * Cancel a posted invoice by reversing its journal entry.
 *
 * The invoice row is never deleted and its lines are never edited — only its
 * status changes and a linked reversal appears in the ledger. Refuses once
 * any payment has been allocated: unwind the receipt first, because a
 * cancelled invoice with money still allocated to it is a reconciliation
 * trap, not a convenience.
 */
export async function cancelInvoice(
  input: CancelInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const { reverseJournalEntry } = await import("./posting");

  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const invoice = await tx.salesInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { allocations: true },
    });
    if (!invoice) throw new InvoicingError("Invoice not found.");
    if (invoice.status === "CANCELLED") throw new InvoicingError("Invoice is already cancelled.");
    if (invoice.allocations.length > 0) {
      throw new InvoicingError(
        "This invoice has receipts allocated against it. Unwind the allocation before cancelling.",
      );
    }
    if (!invoice.postedEntryId) {
      throw new InvoicingError("This invoice was never posted — nothing to reverse.");
    }

    await reverseJournalEntry(
      { entryId: invoice.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    // Release the invoiced quantity back onto the order lines it came from,
    // so the order can be re-invoiced.
    if (invoice.orderId) {
      const items = await tx.salesInvoiceItem.findMany({ where: { invoiceId: invoice.id } });
      const orderItems = await tx.orderItem.findMany({ where: { orderId: invoice.orderId } });
      for (const oi of orderItems) {
        const matched = items.find((i) => i.productId === oi.productId && i.description === oi.description);
        if (matched) {
          await tx.orderItem.update({
            where: { id: oi.id },
            data: { quantityInvoiced: sub(oi.quantityInvoiced, matched.quantity) },
          });
        }
      }
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "SalesInvoice",
        entityId: invoice.id,
        oldValue: { status: invoice.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );

    await syncCustomerOutstanding(invoice.customerId, tx);
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
