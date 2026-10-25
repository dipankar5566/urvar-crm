import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { isInterState, priceLine, resolveTaxRate, TaxRateError } from "./tax";
import { add, gt, money, round, sub, sum, toAmountString, type Money } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * Posts an already-captured PurchaseInvoice to the ledger.
 *
 * Deliberately a separate step from creating the invoice. `createPurchaseInvoice`
 * in purchases/actions.ts records what OCR read off a photograph — a misread
 * total should not reach the books unreviewed. A person opens the invoice,
 * checks the numbers, and posts explicitly; only POSTED invoices can be paid.
 *
 * Vyapar parity step 5 (docs/VYAPAR_PARITY_SPEC.md §2.5, G14) added a second
 * posting path. When every line has an `hsnCode` (entered by hand at
 * intake — OCR extracts none), tax is resolved and split line-by-line
 * exactly the way `invoicing.ts` prices a sales line, and that line-summed
 * figure becomes the invoice's authoritative subtotal/tax/total — more
 * accurate than the OCR-read header figure, the same "lines are the source
 * of truth, the header is derived" rule the sales side already follows.
 * When even one line lacks an `hsnCode`, the original header-blended split
 * runs completely unchanged: there is no partial mix of the two on one
 * invoice, and an invoice captured before this shipped keeps posting
 * exactly as it always did.
 */

export class PurchasePostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchasePostingError";
  }
}

export type PostPurchaseInvoiceInput = {
  invoiceId: string;
  postedById: string;
};

export type PostPurchaseInvoiceResult = {
  journalEntryId: string;
  journalEntryNumber: string;
};

export async function postPurchaseInvoice(
  input: PostPurchaseInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<PostPurchaseInvoiceResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostPurchaseInvoiceResult> => {
    const invoice = await tx.purchaseInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { supplier: true, items: true },
    });
    if (!invoice) throw new PurchasePostingError("Purchase invoice not found.");
    if (invoice.status !== "DRAFT") {
      throw new PurchasePostingError(`Only a DRAFT invoice can be posted; this one is ${invoice.status}.`);
    }
    if (!invoice.supplier.state) {
      throw new PurchasePostingError(
        `${invoice.supplier.name} has no state on file. Set it before posting — it decides ` +
          `CGST+SGST vs IGST and is never guessed.`,
      );
    }

    const company = await requireCompany(tx);
    const interState = isInterState(company.state, invoice.supplier.state);

    const lineBased = invoice.items.length > 0 && invoice.items.every((i) => !!i.hsnCode);

    let subtotal: Money;
    let cgst: Money;
    let sgst: Money;
    let igst: Money;
    let cess: Money;
    let total: Money;
    let itemUpdates: { id: string; taxRatePercent: Money; taxableValue: Money; cgstAmount: Money; sgstAmount: Money; igstAmount: Money; cessAmount: Money }[] = [];

    if (lineBased) {
      const priced = await Promise.all(
        invoice.items.map(async (item) => {
          let rate;
          try {
            rate = await resolveTaxRate(item.hsnCode!, invoice.invoiceDate, tx);
          } catch (err) {
            if (err instanceof TaxRateError) throw new PurchasePostingError(err.message);
            throw err;
          }
          const p = priceLine({ quantity: item.quantity, unitPrice: item.unitPrice }, rate, interState);
          return { id: item.id, taxRatePercent: p.taxRatePercent, taxableValue: p.taxableValue, cgstAmount: p.cgstAmount, sgstAmount: p.sgstAmount, igstAmount: p.igstAmount, cessAmount: p.cessAmount };
        }),
      );
      itemUpdates = priced;
      subtotal = round(sum(priced.map((p) => p.taxableValue)));
      cgst = round(sum(priced.map((p) => p.cgstAmount)));
      sgst = round(sum(priced.map((p) => p.sgstAmount)));
      igst = round(sum(priced.map((p) => p.igstAmount)));
      cess = round(sum(priced.map((p) => p.cessAmount)));
      total = round(sum([subtotal, cgst, sgst, igst, cess]));
    } else {
      // The header captures one blended tax figure (OCR asks for a single
      // number, not a rate or HSN per line), so ITC is split proportionally
      // from it rather than computed line-by-line the way sales tax is.
      subtotal = round(invoice.subtotal);
      const tax = round(invoice.taxAmount);
      total = round(invoice.totalAmount);
      cess = money(0);
      cgst = money(0);
      sgst = money(0);
      igst = money(0);
      if (interState) {
        igst = tax;
      } else {
        const half = tax.dividedBy(2);
        cgst = round(half);
        sgst = round(half);
        // Rounding both halves independently can leave a paisa unaccounted
        // for against the header tax figure; fold it into SGST so the three
        // GST lines always sum to exactly `tax`.
        const drift = sub(tax, add(cgst, sgst));
        if (!drift.isZero()) sgst = add(sgst, drift);
      }
    }

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [
      { accountKey: "PURCHASES", debit: subtotal },
    ];
    if (gt(cgst, 0)) lines.push({ accountKey: "GST_INPUT_CGST", debit: cgst });
    if (gt(sgst, 0)) lines.push({ accountKey: "GST_INPUT_SGST", debit: sgst });
    if (gt(igst, 0)) lines.push({ accountKey: "GST_INPUT_IGST", debit: igst });
    if (gt(cess, 0)) lines.push({ accountKey: "GST_INPUT_CESS", debit: cess });
    lines.push({
      accountKey: "AP_TRADE",
      credit: total,
      partyType: "SUPPLIER",
      partyId: invoice.supplierId,
    });

    const posted = await postJournalEntry(
      {
        entryDate: invoice.invoiceDate,
        narration: `Purchase invoice ${invoice.invoiceNumber} from ${invoice.supplier.name}`,
        sourceType: "SUPPLIER_BILL",
        sourceId: invoice.id,
        idempotencyKey: `PURCHASE_INVOICE:${invoice.id}:1`,
        postedById: input.postedById,
        lines,
      },
      tx,
    );

    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "POSTED",
        isInterState: interState,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        cessAmount: cess,
        supplierGstin: invoice.supplier.gstNumber,
        placeOfSupply: invoice.supplier.state,
        // Only the line-priced path overrides the header figures the
        // preparer entered — see the module comment for why that's safe
        // (nothing can have been paid against a still-DRAFT invoice).
        ...(lineBased ? { subtotal, taxAmount: add(add(cgst, sgst), add(igst, cess)), totalAmount: total } : {}),
        postedEntryId: posted.entryId,
        postedAt: new Date(),
      },
    });

    for (const u of itemUpdates) {
      await tx.purchaseInvoiceItem.update({
        where: { id: u.id },
        data: {
          taxRatePercent: u.taxRatePercent,
          taxableValue: u.taxableValue,
          cgstAmount: u.cgstAmount,
          sgstAmount: u.sgstAmount,
          igstAmount: u.igstAmount,
          cessAmount: u.cessAmount,
        },
      });
    }

    await logAudit(
      {
        userId: input.postedById,
        action: "POST",
        entityType: "PurchaseInvoice",
        entityId: invoice.id,
        newValue: { invoiceNumber: invoice.invoiceNumber, totalAmount: toAmountString(total) },
      },
      tx,
    );

    return { journalEntryId: posted.entryId, journalEntryNumber: posted.entryNumber };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelPurchaseInvoiceInput = {
  invoiceId: string;
  reason: string;
  cancelledById: string;
};

export async function cancelPurchaseInvoice(
  input: CancelPurchaseInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const invoice = await tx.purchaseInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { allocations: true },
    });
    if (!invoice) throw new PurchasePostingError("Purchase invoice not found.");
    if (invoice.status === "CANCELLED") throw new PurchasePostingError("Already cancelled.");
    if (invoice.allocations.length > 0) {
      throw new PurchasePostingError(
        "This invoice has payments allocated against it. Unwind the allocation before cancelling.",
      );
    }

    if (invoice.postedEntryId) {
      await reverseJournalEntry(
        { entryId: invoice.postedEntryId, reason: input.reason, postedById: input.cancelledById },
        tx,
      );
    }

    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "PurchaseInvoice",
        entityId: invoice.id,
        oldValue: { status: invoice.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
