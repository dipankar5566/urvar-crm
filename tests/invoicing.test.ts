import { describe, it, expect } from "vitest";
import { createInvoiceFromOrder, cancelInvoice, InvoicingError } from "@/lib/accounting/invoicing";
import { TaxRateError } from "@/lib/accounting/tax";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, ensureVerifiedTaxRate, testProduct, testCustomer, testOrderWithLine,
} from "./helpers/db";

describe("createInvoiceFromOrder(): pricing and posting", () => {
  it("prices, posts, and creates a balanced entry for an intra-state sale", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);

      const customer = await testCustomer(tx, { state: "West Bengal" });
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      const result = await createInvoiceFromOrder({
        orderId: order.id,
        invoiceDate: date,
        createdById: userId,
      }, tx);

      expect(result.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/);
      expect(result.totalAmount).toBe("1050.00");

      const invoice = await tx.salesInvoice.findUniqueOrThrow({
        where: { id: result.invoiceId },
        include: { items: true },
      });
      expect(invoice.isInterState).toBe(false);
      expect(toAmountString(invoice.cgstAmount)).toBe("25.00");
      expect(toAmountString(invoice.sgstAmount)).toBe("25.00");
      expect(toAmountString(invoice.igstAmount)).toBe("0.00");
      expect(invoice.items).toHaveLength(1);
      expect(invoice.items[0].hsnCode).toBe("3101");
      expect(toAmountString(invoice.items[0].taxableValue)).toBe("1000.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      const debits = sum(lines.map((l) => l.debit));
      const credits = sum(lines.map((l) => l.credit));
      expect(toAmountString(debits)).toBe(toAmountString(credits));
      expect(toAmountString(debits)).toBe("1050.00");
    });
  });

  it("splits into IGST for an inter-state sale", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);

      const customer = await testCustomer(tx, { state: "Karnataka" });
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      const result = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: result.invoiceId } });

      expect(invoice.isInterState).toBe(true);
      expect(toAmountString(invoice.igstAmount)).toBe("50.00");
      expect(toAmountString(invoice.cgstAmount)).toBe("0.00");
      expect(toAmountString(invoice.sgstAmount)).toBe("0.00");
    });
  });

  it("refuses to price a product with no HSN code", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const product = await tx.product.create({
        data: {
          sku: `NOHSN-${Date.now()}`, name: "No HSN", category: "VERMICOMPOST",
          unit: "kg", mrp: "100", gstPercent: "5", hsnCode: null,
        },
      });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id });

      await expect(
        createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx),
      ).rejects.toThrow(/no HSN code/i);
    });
  });

  it("refuses to price from an unverified tax rate", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "9999" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id });

      await expect(
        createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx),
      ).rejects.toThrow(TaxRateError);
    });
  });

  it("refuses to invoice an order with no line items", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const order = await tx.order.create({
        data: {
          orderNumber: `EMPTY-${Date.now()}`, customerId: customer.id, totalAmount: "100.00",
          state: customer.state, district: customer.district, createdById: userId,
        },
      });
      await expect(
        createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx),
      ).rejects.toThrow(/no line items/i);
    });
  });
});

describe("createInvoiceFromOrder(): partial invoicing", () => {
  it("supports partial invoicing and tracks quantityInvoiced", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      const first = await createInvoiceFromOrder({
        orderId: order.id,
        invoiceDate: date,
        createdById: userId,
        lines: [{ orderItemId: order.items[0].id, quantity: 4 }],
      }, tx);
      expect(first.totalAmount).toBe("420.00");

      const item = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
      expect(toAmountString(item.quantityInvoiced)).toBe("4.00");

      const second = await createInvoiceFromOrder({
        orderId: order.id,
        invoiceDate: date,
        createdById: userId,
        lines: [{ orderItemId: order.items[0].id }],
      }, tx);
      expect(second.totalAmount).toBe("630.00");

      await expect(
        createInvoiceFromOrder({
          orderId: order.id,
          invoiceDate: date,
          createdById: userId,
          lines: [{ orderItemId: order.items[0].id, quantity: 1 }],
        }, tx),
      ).rejects.toThrow(/only 0.00 remains/i);
    });
  });

  it("refuses to over-invoice beyond the remaining quantity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      await expect(
        createInvoiceFromOrder({
          orderId: order.id,
          invoiceDate: date,
          createdById: userId,
          lines: [{ orderItemId: order.items[0].id, quantity: 20 }],
        }, tx),
      ).rejects.toThrow(InvoicingError);
    });
  });

  it("charges freight as taxed and applies a round-off line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: "3.33", unitPrice: 100,
      });

      const result = await createInvoiceFromOrder({
        orderId: order.id, invoiceDate: date, createdById: userId,
      }, tx);

      // 3.33 x 100 = 333.00 taxable. 5% split intra-state: 2.5% each side of
      // 333.00 = 8.325, rounds to 8.33 CGST + 8.33 SGST = 16.66 tax.
      // 333.00 + 16.66 = 349.66, which rounds UP to 350 -> roundOff +0.34.
      const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: result.invoiceId } });
      expect(result.totalAmount).toBe("350.00");
      expect(toAmountString(invoice.roundOff)).toBe("0.34");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );
    });
  });

  it("cannot re-invoice a fully invoiced order", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 100,
      });

      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      await expect(
        createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx),
      ).rejects.toThrow(/nothing left to invoice/i);
    });
  });
});

describe("cancelInvoice()", () => {
  it("reverses the posting and marks the invoice cancelled", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 100,
      });
      const created = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      await cancelInvoice({ invoiceId: created.invoiceId, reason: "Test cancellation", cancelledById: userId }, tx);

      const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: created.invoiceId } });
      expect(invoice.status).toBe("CANCELLED");

      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: created.journalEntryId } });
      expect(entry.status).toBe("REVERSED");

      const item = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
      expect(toAmountString(item.quantityInvoiced)).toBe("0.00");
    });
  });

  it("refuses to cancel an invoice that has a payment allocated", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 100,
      });
      const created = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const { recordReceipt } = await import("@/lib/accounting/receipts");
      const bank = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
      await recordReceipt({
        customerId: customer.id,
        receiptDate: date,
        amount: created.totalAmount,
        method: "BANK_TRANSFER",
        depositAccountId: bank.id,
        allocations: [{ invoiceId: created.invoiceId, amount: created.totalAmount }],
        createdById: userId,
      }, tx);

      await expect(
        cancelInvoice({ invoiceId: created.invoiceId, reason: "Too late", cancelledById: userId }, tx),
      ).rejects.toThrow(/receipts allocated/i);
    });
  });
});
