import { describe, it, expect } from "vitest";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { recordReceipt, cancelReceipt, outstandingOnInvoice, ReceiptError } from "@/lib/accounting/receipts";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, ensureVerifiedTaxRate, testProduct, testCustomer, testOrderWithLine,
} from "./helpers/db";

async function setupInvoice(tx: Parameters<Parameters<typeof withRollback>[0]>[0], amount = { qty: 10, price: 100 }) {
  const userId = await testUserId(tx);
  const date = await openPeriodDate(tx);
  await ensureVerifiedTaxRate(tx, "3101", 5);
  const customer = await testCustomer(tx);
  const product = await testProduct(tx, { hsnCode: "3101" });
  const order = await testOrderWithLine(tx, {
    userId, customerId: customer.id, productId: product.id, quantity: amount.qty, unitPrice: amount.price,
  });
  const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
  const bank = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
  return { userId, date, customer, product, order, invoice, bankId: bank.id };
}

describe("recordReceipt(): full payment", () => {
  it("allocates the full amount and marks the invoice PAID", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      const result = await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: invoice.totalAmount,
        method: "BANK_TRANSFER",
        depositAccountId: bankId,
        allocations: [{ invoiceId: invoice.invoiceId, amount: invoice.totalAmount }],
        createdById: userId,
      }, tx);

      expect(result.receiptNumber).toMatch(/^RCT\/\d{4}-\d{2}\/\d{4}$/);
      expect(result.allocated).toBe(invoice.totalAmount);
      expect(result.advance).toBe("0.00");

      const updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("PAID");

      const outstanding = await outstandingOnInvoice(invoice.invoiceId, tx);
      expect(toAmountString(outstanding)).toBe("0.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );
    });
  });
});

describe("recordReceipt(): partial payment", () => {
  it("marks the invoice PARTIALLY_PAID and leaves the remainder outstanding", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: "500.00",
        method: "CASH",
        depositAccountId: bankId,
        allocations: [{ invoiceId: invoice.invoiceId, amount: "500.00" }],
        createdById: userId,
      }, tx);

      const updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("PARTIALLY_PAID");

      const outstanding = await outstandingOnInvoice(invoice.invoiceId, tx);
      expect(toAmountString(outstanding)).toBe("550.00");
    });
  });

  it("accumulates across multiple receipts to reach PAID", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      await recordReceipt({
        customerId: customer.id, receiptDate: date, amount: "600.00", method: "CASH",
        depositAccountId: bankId, allocations: [{ invoiceId: invoice.invoiceId, amount: "600.00" }],
        createdById: userId,
      }, tx);
      await recordReceipt({
        customerId: customer.id, receiptDate: date, amount: "450.00", method: "CASH",
        depositAccountId: bankId, allocations: [{ invoiceId: invoice.invoiceId, amount: "450.00" }],
        createdById: userId,
      }, tx);

      const updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("PAID");
      expect(toAmountString(await outstandingOnInvoice(invoice.invoiceId, tx))).toBe("0.00");
    });
  });
});

describe("recordReceipt(): the over-allocation guard", () => {
  it("refuses to allocate more than an invoice's outstanding amount", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      await expect(
        recordReceipt({
          customerId: customer.id,
          receiptDate: date,
          amount: "2000.00",
          method: "CASH",
          depositAccountId: bankId,
          allocations: [{ invoiceId: invoice.invoiceId, amount: "2000.00" }],
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/only 1050.00 outstanding/i);
    });
  });

  it("refuses when allocations sum to more than the receipt amount", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);
      const p2 = await testProduct(tx, { hsnCode: "3101" });
      const order2 = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: p2.id, quantity: 5, unitPrice: 100,
      });
      const second = await createInvoiceFromOrder({ orderId: order2.id, invoiceDate: date, createdById: userId }, tx);

      await expect(
        recordReceipt({
          customerId: customer.id,
          receiptDate: date,
          amount: "500.00",
          method: "CASH",
          depositAccountId: bankId,
          allocations: [
            { invoiceId: invoice.invoiceId, amount: "300.00" },
            { invoiceId: second.invoiceId, amount: "300.00" },
          ],
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/exceed the receipt amount/i);
    });
  });

  it("refuses an allocation against another customer's invoice", async () => {
    await withRollback(async (tx) => {
      const { date, invoice, bankId } = await setupInvoice(tx);
      const otherCustomer = await testCustomer(tx);
      const userId2 = await testUserId(tx);

      await expect(
        recordReceipt({
          customerId: otherCustomer.id,
          receiptDate: date,
          amount: "100.00",
          method: "CASH",
          depositAccountId: bankId,
          allocations: [{ invoiceId: invoice.invoiceId, amount: "100.00" }],
          createdById: userId2,
        }, tx),
      ).rejects.toThrow(/same customer/i);
    });
  });
});

describe("recordReceipt(): over-payment becomes an advance", () => {
  it("routes the unallocated remainder to ADVANCE_FROM_CUSTOMER, never forcing it onto an invoice", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      const result = await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: "1200.00",
        method: "UPI",
        depositAccountId: bankId,
        allocations: [{ invoiceId: invoice.invoiceId, amount: "1050.00" }],
        createdById: userId,
      }, tx);

      expect(result.allocated).toBe("1050.00");
      expect(result.advance).toBe("150.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      const advanceLine = await tx.journalLine.findMany({
        where: { entryId: result.journalEntryId, account: { code: "2120" } },
      });
      expect(advanceLine).toHaveLength(1);
      expect(toAmountString(advanceLine[0].credit)).toBe("150.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );

      const updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("PAID");
    });
  });

  it("records a pure on-account receipt with no allocation at all", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const bank = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });

      const result = await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: "500.00",
        method: "UPI",
        depositAccountId: bank.id,
        createdById: userId,
      }, tx);

      expect(result.allocated).toBe("0.00");
      expect(result.advance).toBe("500.00");
    });
  });
});

describe("recordReceipt(): validation", () => {
  it("refuses a zero or negative receipt amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const bank = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });

      await expect(
        recordReceipt({
          customerId: customer.id, receiptDate: date, amount: "0", method: "CASH",
          depositAccountId: bank.id, createdById: userId,
        }, tx),
      ).rejects.toThrow(ReceiptError);
    });
  });
});

describe("cancelReceipt()", () => {
  it("reverses the entry, removes allocations, and reopens the invoice", async () => {
    await withRollback(async (tx) => {
      const { userId, date, customer, invoice, bankId } = await setupInvoice(tx);

      const receipt = await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: invoice.totalAmount,
        method: "CASH",
        depositAccountId: bankId,
        allocations: [{ invoiceId: invoice.invoiceId, amount: invoice.totalAmount }],
        createdById: userId,
      }, tx);

      let updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("PAID");

      await cancelReceipt({ receiptId: receipt.receiptId, reason: "Bounced", cancelledById: userId }, tx);

      const receiptRow = await tx.receipt.findUniqueOrThrow({ where: { id: receipt.receiptId } });
      expect(receiptRow.status).toBe("CANCELLED");

      const allocations = await tx.receiptAllocation.findMany({ where: { receiptId: receipt.receiptId } });
      expect(allocations).toHaveLength(0);

      updated = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
      expect(updated.status).toBe("POSTED");

      const outstanding = await outstandingOnInvoice(invoice.invoiceId, tx);
      expect(toAmountString(outstanding)).toBe(invoice.totalAmount);
    });
  });
});
