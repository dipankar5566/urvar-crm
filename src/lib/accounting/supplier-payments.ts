import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { add, gt, money, round, sub, sum, toAmountString, type Money } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * Supplier payments and their allocation against purchase invoices.
 * Mirrors src/lib/accounting/receipts.ts exactly, direction reversed: money
 * leaves a cash/bank account, reduces AP_TRADE for what's allocated, and
 * anything unallocated becomes an advance sitting in ADVANCE_TO_SUPPLIER —
 * never forced onto an invoice, never dropped.
 */

export class SupplierPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierPaymentError";
  }
}

export type SupplierAllocationInput = {
  invoiceId: string;
  amount: string | number;
};

export type RecordSupplierPaymentInput = {
  supplierId: string;
  paymentDate: Date;
  amount: string | number;
  method: PaymentMethod;
  reference?: string | null;
  paymentAccountId: string;
  allocations?: SupplierAllocationInput[];
  notes?: string | null;
  createdById: string;
};

export type RecordSupplierPaymentResult = {
  paymentId: string;
  paymentNumber: string;
  amount: string;
  allocated: string;
  advance: string;
  journalEntryId: string;
  journalEntryNumber: string;
};

/** How much of a purchase invoice remains outstanding, from posted allocations. */
export async function outstandingOnPurchaseInvoice(
  invoiceId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const [invoice, allocations] = await Promise.all([
    tx.purchaseInvoice.findUnique({ where: { id: invoiceId }, select: { totalAmount: true, status: true } }),
    tx.supplierPaymentAllocation.findMany({
      where: { invoiceId, payment: { status: "POSTED" } },
      select: { amount: true },
    }),
  ]);
  if (!invoice) throw new SupplierPaymentError("Purchase invoice not found.");
  const paid = sum(allocations.map((a) => a.amount));
  return sub(invoice.totalAmount, paid);
}

async function refreshPurchaseInvoiceStatus(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const invoice = await tx.purchaseInvoice.findUnique({
    where: { id: invoiceId },
    select: { totalAmount: true, status: true },
  });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "DRAFT") return;
  const outstanding = await outstandingOnPurchaseInvoice(invoiceId, tx);
  const status = outstanding.lessThanOrEqualTo(0)
    ? "PAID"
    : outstanding.lessThan(invoice.totalAmount)
      ? "PARTIALLY_PAID"
      : "POSTED";
  if (status !== invoice.status) {
    await tx.purchaseInvoice.update({ where: { id: invoiceId }, data: { status } });
  }
}

export async function recordSupplierPayment(
  input: RecordSupplierPaymentInput,
  existingTx?: Prisma.TransactionClient,
): Promise<RecordSupplierPaymentResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<RecordSupplierPaymentResult> => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new SupplierPaymentError("Supplier not found.");

    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new SupplierPaymentError("Payment amount must be greater than zero.");

    const allocationInputs = input.allocations ?? [];
    let allocatedTotal = money(0);
    const allocationRows: { invoiceId: string; amount: Money }[] = [];

    for (const alloc of allocationInputs) {
      const amt = round(alloc.amount);
      if (!gt(amt, 0)) throw new SupplierPaymentError("Each allocation must be greater than zero.");

      const invoice = await tx.purchaseInvoice.findUnique({
        where: { id: alloc.invoiceId },
        select: { id: true, supplierId: true, status: true, totalAmount: true },
      });
      if (!invoice) throw new SupplierPaymentError(`Invoice ${alloc.invoiceId} not found.`);
      if (invoice.supplierId !== input.supplierId) {
        throw new SupplierPaymentError("An allocation must be against an invoice for the same supplier.");
      }
      if (invoice.status === "CANCELLED" || invoice.status === "DRAFT") {
        throw new SupplierPaymentError(
          `Invoice is ${invoice.status.toLowerCase()} and cannot receive a payment. Post it first.`,
        );
      }

      const outstanding = await outstandingOnPurchaseInvoice(alloc.invoiceId, tx);
      if (amt.greaterThan(outstanding)) {
        throw new SupplierPaymentError(
          `Cannot allocate ${toAmountString(amt)} to an invoice with only ` +
            `${toAmountString(outstanding)} outstanding.`,
        );
      }

      allocatedTotal = add(allocatedTotal, amt);
      allocationRows.push({ invoiceId: alloc.invoiceId, amount: amt });
    }

    if (allocatedTotal.greaterThan(amount)) {
      throw new SupplierPaymentError(
        `Allocations (${toAmountString(allocatedTotal)}) exceed the payment amount ` +
          `(${toAmountString(amount)}).`,
      );
    }
    const advance = sub(amount, allocatedTotal);

    const company = await requireCompany(tx);
    const paymentNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.SUPPLIER_PAYMENT,
      financialYear: financialYearOf(input.paymentDate, company.fyStartMonth),
      fyStartMonth: company.fyStartMonth,
    });

    const payment = await tx.supplierPayment.create({
      data: {
        paymentNumber,
        companyId: company.id,
        supplierId: input.supplierId,
        paymentDate: input.paymentDate,
        amount,
        method: input.method,
        reference: input.reference ?? null,
        paymentAccountId: input.paymentAccountId,
        notes: input.notes ?? null,
        createdById: input.createdById,
        allocations: { create: allocationRows.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
      },
    });

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [{ accountId: input.paymentAccountId, credit: amount }];
    if (allocatedTotal.greaterThan(0)) {
      lines.push({
        accountKey: "AP_TRADE",
        debit: allocatedTotal,
        partyType: "SUPPLIER",
        partyId: input.supplierId,
      });
    }
    if (advance.greaterThan(0)) {
      lines.push({
        accountKey: "ADVANCE_TO_SUPPLIER",
        debit: advance,
        partyType: "SUPPLIER",
        partyId: input.supplierId,
      });
    }

    const posted = await postJournalEntry(
      {
        entryDate: input.paymentDate,
        narration: `Payment ${paymentNumber} to ${supplier.name}`,
        sourceType: "SUPPLIER_PAYMENT",
        sourceId: payment.id,
        idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.supplierPayment.update({ where: { id: payment.id }, data: { postedEntryId: posted.entryId } });

    for (const a of allocationRows) {
      await refreshPurchaseInvoiceStatus(tx, a.invoiceId);
    }

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "SupplierPayment",
        entityId: payment.id,
        newValue: {
          paymentNumber,
          supplierId: input.supplierId,
          amount: toAmountString(amount),
          allocated: toAmountString(allocatedTotal),
          advance: toAmountString(advance),
        },
      },
      tx,
    );

    return {
      paymentId: payment.id,
      paymentNumber,
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

export type CancelSupplierPaymentInput = {
  paymentId: string;
  reason: string;
  cancelledById: string;
};

export async function cancelSupplierPayment(
  input: CancelSupplierPaymentInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const payment = await tx.supplierPayment.findUnique({
      where: { id: input.paymentId },
      include: { allocations: true },
    });
    if (!payment) throw new SupplierPaymentError("Payment not found.");
    if (payment.status === "CANCELLED") throw new SupplierPaymentError("Payment is already cancelled.");
    if (!payment.postedEntryId) throw new SupplierPaymentError("This payment was never posted.");

    await reverseJournalEntry(
      { entryId: payment.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    const invoiceIds = payment.allocations.map((a) => a.invoiceId);
    await tx.supplierPaymentAllocation.deleteMany({ where: { paymentId: payment.id } });
    await tx.supplierPayment.update({
      where: { id: payment.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    for (const invoiceId of invoiceIds) {
      await refreshPurchaseInvoiceStatus(tx, invoiceId);
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "SupplierPayment",
        entityId: payment.id,
        oldValue: { status: payment.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
