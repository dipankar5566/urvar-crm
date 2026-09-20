import { describe, it, expect } from "vitest";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import {
  recordSupplierPayment, cancelSupplierPayment, outstandingOnPurchaseInvoice, SupplierPaymentError,
} from "@/lib/accounting/supplier-payments";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, testSupplier, testPurchaseInvoice,
} from "./helpers/db";

async function setupPostedInvoice(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const userId = await testUserId(tx);
  const date = await openPeriodDate(tx);
  const supplier = await testSupplier(tx, { userId });
  const invoice = await testPurchaseInvoice(tx, {
    userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000.00", taxAmount: "50.00", totalAmount: "1050.00",
  });
  await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);
  const cash = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
  return { userId, date, supplier, invoice, cashId: cash.id };
}

describe("recordSupplierPayment(): full and partial payment", () => {
  it("allocates the full amount and marks the invoice PAID", async () => {
    await withRollback(async (tx) => {
      const { userId, date, supplier, invoice, cashId } = await setupPostedInvoice(tx);

      const result = await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "1050.00", method: "BANK_TRANSFER",
        paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "1050.00" }],
        createdById: userId,
      }, tx);

      expect(result.paymentNumber).toMatch(/^SPY\/\d{4}-\d{2}\/\d{4}$/);
      expect(result.advance).toBe("0.00");

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("PAID");
      expect(toAmountString(await outstandingOnPurchaseInvoice(invoice.id, tx))).toBe("0.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );
    });
  });

  it("marks PARTIALLY_PAID and leaves the remainder outstanding", async () => {
    await withRollback(async (tx) => {
      const { userId, date, supplier, invoice, cashId } = await setupPostedInvoice(tx);

      await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "500.00", method: "CASH",
        paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "500.00" }],
        createdById: userId,
      }, tx);

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("PARTIALLY_PAID");
      expect(toAmountString(await outstandingOnPurchaseInvoice(invoice.id, tx))).toBe("550.00");
    });
  });
});

describe("recordSupplierPayment(): guards", () => {
  it("refuses to allocate more than the outstanding amount", async () => {
    await withRollback(async (tx) => {
      const { userId, date, supplier, invoice, cashId } = await setupPostedInvoice(tx);
      await expect(
        recordSupplierPayment({
          supplierId: supplier.id, paymentDate: date, amount: "5000.00", method: "CASH",
          paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "5000.00" }],
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/only 1050.00 outstanding/i);
    });
  });

  it("refuses to allocate against a DRAFT (unposted) invoice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date });
      const cash = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });

      await expect(
        recordSupplierPayment({
          supplierId: supplier.id, paymentDate: date, amount: "100.00", method: "CASH",
          paymentAccountId: cash.id, allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/draft.*post it first/i);
    });
  });

  it("refuses cross-supplier allocation", async () => {
    await withRollback(async (tx) => {
      const { date, invoice, cashId } = await setupPostedInvoice(tx);
      const userId2 = await testUserId(tx);
      const otherSupplier = await testSupplier(tx, { userId: userId2 });

      await expect(
        recordSupplierPayment({
          supplierId: otherSupplier.id, paymentDate: date, amount: "100.00", method: "CASH",
          paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
          createdById: userId2,
        }, tx),
      ).rejects.toThrow(/same supplier/i);
    });
  });

  it("refuses a zero payment amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const cash = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
      await expect(
        recordSupplierPayment({
          supplierId: supplier.id, paymentDate: date, amount: "0", method: "CASH", paymentAccountId: cash.id, createdById: userId,
        }, tx),
      ).rejects.toThrow(SupplierPaymentError);
    });
  });
});

describe("recordSupplierPayment(): over-payment becomes an advance", () => {
  it("routes the remainder to ADVANCE_TO_SUPPLIER with a balanced entry", async () => {
    await withRollback(async (tx) => {
      const { userId, date, supplier, invoice, cashId } = await setupPostedInvoice(tx);

      const result = await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "1200.00", method: "UPI",
        paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "1050.00" }],
        createdById: userId,
      }, tx);

      expect(result.allocated).toBe("1050.00");
      expect(result.advance).toBe("150.00");

      const advanceLine = await tx.journalLine.findMany({
        where: { entryId: result.journalEntryId, account: { code: "1140" } },
      });
      expect(advanceLine).toHaveLength(1);
      expect(toAmountString(advanceLine[0].debit)).toBe("150.00");
    });
  });
});

describe("cancelSupplierPayment()", () => {
  it("reverses the entry, removes allocations, and reopens the invoice", async () => {
    await withRollback(async (tx) => {
      const { userId, date, supplier, invoice, cashId } = await setupPostedInvoice(tx);
      const payment = await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "1050.00", method: "CASH",
        paymentAccountId: cashId, allocations: [{ invoiceId: invoice.id, amount: "1050.00" }],
        createdById: userId,
      }, tx);

      let updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("PAID");

      await cancelSupplierPayment({ paymentId: payment.paymentId, reason: "Bounced cheque", cancelledById: userId }, tx);

      const paymentRow = await tx.supplierPayment.findUniqueOrThrow({ where: { id: payment.paymentId } });
      expect(paymentRow.status).toBe("CANCELLED");

      updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("POSTED");
      expect(toAmountString(await outstandingOnPurchaseInvoice(invoice.id, tx))).toBe("1050.00");
    });
  });
});
