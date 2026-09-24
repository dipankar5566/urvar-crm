import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { add, gt, money, round, sub, sum, toAmountString, type Money } from "./money";
import { logAudit } from "@/lib/audit";
import { syncCustomerOutstanding } from "./receivables";

/**
 * Customer receipts and their allocation against invoices.
 *
 * A receipt is money received, not a payment against one invoice — a
 * customer pays an amount, and that amount is then allocated. Anything not
 * allocated to a specific invoice lands in ADVANCE_FROM_CUSTOMER rather than
 * being forced onto an invoice or dropped, which is what makes over-payment
 * safe: nothing here can ever allocate more to an invoice than it is owed.
 */

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

export type AllocationInput = {
  invoiceId: string;
  amount: string | number;
};

export type RecordReceiptInput = {
  customerId: string;
  receiptDate: Date;
  amount: string | number;
  method: PaymentMethod;
  reference?: string | null;
  depositAccountId: string;
  /** Omit to record the full amount as an on-account advance. */
  allocations?: AllocationInput[];
  notes?: string | null;
  createdById: string;
};

export type RecordReceiptResult = {
  receiptId: string;
  receiptNumber: string;
  amount: string;
  allocated: string;
  advance: string;
  journalEntryId: string;
  journalEntryNumber: string;
};

/** How much of an invoice remains outstanding, from posted allocations. */
export async function outstandingOnInvoice(
  invoiceId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const [invoice, allocations] = await Promise.all([
    tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { totalAmount: true, status: true } }),
    tx.receiptAllocation.findMany({
      where: { invoiceId, receipt: { status: "POSTED" } },
      select: { amount: true },
    }),
  ]);
  if (!invoice) throw new ReceiptError("Invoice not found.");
  const paid = sum(allocations.map((a) => a.amount));
  return sub(invoice.totalAmount, paid);
}

/**
 * Recompute an order's payment status from its invoices.
 *
 * `Order.paymentStatus` used to be set to PENDING at creation and never touched
 * again, so a fully paid order still read "pending". It is derived here from
 * invoice statuses rather than by comparing money, because `Order.totalAmount`
 * is the CRM's own figure and the tax engine's invoice totals can legitimately
 * differ from it (GST, rounding) — comparing the two would flag a fully paid
 * order as short.
 *
 * PAID needs BOTH every live invoice paid AND every order line fully invoiced:
 * an order billed in two instalments, with only the first one paid, is PARTIAL,
 * not PAID. Cancelled and draft invoices don't count either way.
 */
async function refreshOrderPaymentStatus(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const [order, invoices] = await Promise.all([
    tx.order.findUnique({
      where: { id: orderId },
      select: { paymentStatus: true, items: { select: { quantity: true, quantityInvoiced: true } } },
    }),
    tx.salesInvoice.findMany({
      where: { orderId, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] } },
      select: { status: true },
    }),
  ]);
  if (!order) return;

  const anyPaid = invoices.some((i) => i.status === "PAID" || i.status === "PARTIALLY_PAID");
  const allInvoicesPaid = invoices.length > 0 && invoices.every((i) => i.status === "PAID");
  const fullyInvoiced =
    order.items.length > 0 && order.items.every((i) => i.quantityInvoiced.greaterThanOrEqualTo(i.quantity));

  const next = allInvoicesPaid && fullyInvoiced ? "PAID" : anyPaid ? "PARTIAL" : "PENDING";
  if (next !== order.paymentStatus) {
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: next } });
  }
}

/** Recompute and persist an invoice's DRAFT/POSTED/PARTIALLY_PAID/PAID status, then its order's payment status. */
async function refreshInvoiceStatus(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const invoice = await tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    select: { totalAmount: true, status: true, orderId: true },
  });
  if (!invoice || invoice.status === "CANCELLED") return;
  const outstanding = await outstandingOnInvoice(invoiceId, tx);
  const status = outstanding.lessThanOrEqualTo(0)
    ? "PAID"
    : outstanding.lessThan(invoice.totalAmount)
      ? "PARTIALLY_PAID"
      : "POSTED";
  if (status !== invoice.status) {
    await tx.salesInvoice.update({ where: { id: invoiceId }, data: { status } });
  }
  // Runs even when the invoice's own status didn't change — a second invoice
  // on the same order being paid can still move the order's status.
  if (invoice.orderId) await refreshOrderPaymentStatus(tx, invoice.orderId);
}

/** Record a receipt, allocate it, and post the ledger entry. One transaction. */
export async function recordReceipt(
  input: RecordReceiptInput,
  existingTx?: Prisma.TransactionClient,
): Promise<RecordReceiptResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<RecordReceiptResult> => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new ReceiptError("Customer not found.");

    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new ReceiptError("Receipt amount must be greater than zero.");

    // postJournalEntry only checks that an account is active and postable, not
    // what kind it is — without this, a crafted depositAccountId could post a
    // customer receipt as a debit to an expense or liability account. Money
    // received is deposited to Cash on Hand (1110) or any account under Bank
    // Accounts (1120), the same set the receipt form offers.
    const deposit = await tx.ledgerAccount.findUnique({
      where: { id: input.depositAccountId },
      select: { code: true, parent: { select: { code: true } } },
    });
    if (!deposit) throw new ReceiptError("Deposit account not found.");
    if (deposit.code !== "1110" && deposit.parent?.code !== "1120") {
      throw new ReceiptError("Money received must be deposited to Cash on Hand or a bank account.");
    }

    const allocationInputs = input.allocations ?? [];
    let allocatedTotal = money(0);
    const allocationRows: { invoiceId: string; amount: Money }[] = [];

    for (const alloc of allocationInputs) {
      const amt = round(alloc.amount);
      if (!gt(amt, 0)) throw new ReceiptError("Each allocation must be greater than zero.");

      const invoice = await tx.salesInvoice.findUnique({
        where: { id: alloc.invoiceId },
        select: { id: true, customerId: true, status: true, totalAmount: true },
      });
      if (!invoice) throw new ReceiptError(`Invoice ${alloc.invoiceId} not found.`);
      if (invoice.customerId !== input.customerId) {
        throw new ReceiptError("An allocation must be against an invoice for the same customer.");
      }
      if (invoice.status === "CANCELLED") {
        throw new ReceiptError("Invoice is cancelled and cannot receive a payment.");
      }

      const outstanding = await outstandingOnInvoice(alloc.invoiceId, tx);
      if (amt.greaterThan(outstanding)) {
        throw new ReceiptError(
          `Cannot allocate ${toAmountString(amt)} to an invoice with only ` +
            `${toAmountString(outstanding)} outstanding.`,
        );
      }

      allocatedTotal = add(allocatedTotal, amt);
      allocationRows.push({ invoiceId: alloc.invoiceId, amount: amt });
    }

    if (allocatedTotal.greaterThan(amount)) {
      throw new ReceiptError(
        `Allocations (${toAmountString(allocatedTotal)}) exceed the receipt amount ` +
          `(${toAmountString(amount)}).`,
      );
    }
    const advance = sub(amount, allocatedTotal);

    const company = await requireCompany(tx);
    const receiptNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.RECEIPT,
      financialYear: financialYearOf(input.receiptDate, company.fyStartMonth),
      fyStartMonth: company.fyStartMonth,
    });

    const receipt = await tx.receipt.create({
      data: {
        receiptNumber,
        companyId: company.id,
        customerId: input.customerId,
        receiptDate: input.receiptDate,
        amount,
        method: input.method,
        reference: input.reference ?? null,
        depositAccountId: input.depositAccountId,
        notes: input.notes ?? null,
        createdById: input.createdById,
        allocations: { create: allocationRows.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
      },
    });

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [{ accountId: input.depositAccountId, debit: amount }];
    if (allocatedTotal.greaterThan(0)) {
      lines.push({
        accountKey: "AR_TRADE",
        credit: allocatedTotal,
        partyType: "CUSTOMER",
        partyId: input.customerId,
      });
    }
    if (advance.greaterThan(0)) {
      lines.push({
        accountKey: "ADVANCE_FROM_CUSTOMER",
        credit: advance,
        partyType: "CUSTOMER",
        partyId: input.customerId,
      });
    }

    const posted = await postJournalEntry(
      {
        entryDate: input.receiptDate,
        narration: `Receipt ${receiptNumber} from ${customer.name}`,
        sourceType: "RECEIPT",
        sourceId: receipt.id,
        idempotencyKey: `RECEIPT:${receipt.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.receipt.update({ where: { id: receipt.id }, data: { postedEntryId: posted.entryId } });

    for (const a of allocationRows) {
      await refreshInvoiceStatus(tx, a.invoiceId);
    }

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "Receipt",
        entityId: receipt.id,
        newValue: {
          receiptNumber,
          customerId: input.customerId,
          amount: toAmountString(amount),
          allocated: toAmountString(allocatedTotal),
          advance: toAmountString(advance),
        },
      },
      tx,
    );

    await syncCustomerOutstanding(input.customerId, tx);

    return {
      receiptId: receipt.id,
      receiptNumber,
      amount: toAmountString(amount),
      allocated: toAmountString(allocatedTotal),
      advance: toAmountString(advance),
      journalEntryId: posted.entryId,
      journalEntryNumber: posted.entryNumber,
    };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelReceiptInput = {
  receiptId: string;
  reason: string;
  cancelledById: string;
};

/** Reverse a receipt's posting and mark it cancelled. Allocations are removed. */
export async function cancelReceipt(
  input: CancelReceiptInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const receipt = await tx.receipt.findUnique({
      where: { id: input.receiptId },
      include: { allocations: true },
    });
    if (!receipt) throw new ReceiptError("Receipt not found.");
    if (receipt.status === "CANCELLED") throw new ReceiptError("Receipt is already cancelled.");
    if (!receipt.postedEntryId) throw new ReceiptError("This receipt was never posted.");

    await reverseJournalEntry(
      { entryId: receipt.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    const invoiceIds = receipt.allocations.map((a) => a.invoiceId);
    await tx.receiptAllocation.deleteMany({ where: { receiptId: receipt.id } });
    await tx.receipt.update({
      where: { id: receipt.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    for (const invoiceId of invoiceIds) {
      await refreshInvoiceStatus(tx, invoiceId);
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "Receipt",
        entityId: receipt.id,
        oldValue: { status: receipt.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );

    await syncCustomerOutstanding(receipt.customerId, tx);
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
