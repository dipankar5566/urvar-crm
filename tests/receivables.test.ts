import { describe, it, expect } from "vitest";
import { createInvoiceFromOrder, cancelInvoice } from "@/lib/accounting/invoicing";
import { recordReceipt } from "@/lib/accounting/receipts";
import {
  customerReceivable, syncCustomerOutstanding, reconcileOutstandingAmounts, customerAccountStatus,
} from "@/lib/accounting/receivables";
import { toAmountString } from "@/lib/accounting/money";
import {
  withRollback, testUserId, accountId, openPeriodDate, ensureVerifiedTaxRate, testProduct, testCustomer, testOrderWithLine,
} from "./helpers/db";

describe("customerReceivable(): R1 — a real number instead of a hand-typed one", () => {
  it("is zero for a customer with no invoices", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe("0.00");
    });
  });

  it("equals the invoice total right after posting, before any payment", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe(invoice.totalAmount);
    });
  });

  it("drops as receipts are allocated, and reflects two invoices at once", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const bank = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });

      const order1 = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });
      const inv1 = await createInvoiceFromOrder({ orderId: order1.id, invoiceDate: date, createdById: userId }, tx);

      const order2 = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 200,
      });
      const inv2 = await createInvoiceFromOrder({ orderId: order2.id, invoiceDate: date, createdById: userId }, tx);

      // Both unpaid: receivable is the sum of both.
      const expectedSum = (Number(inv1.totalAmount) + Number(inv2.totalAmount)).toFixed(2);
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe(expectedSum);

      await recordReceipt({
        customerId: customer.id, receiptDate: date, amount: inv1.totalAmount, method: "CASH",
        depositAccountId: bank.id, allocations: [{ invoiceId: inv1.invoiceId, amount: inv1.totalAmount }],
        createdById: userId,
      }, tx);

      // Only inv2 remains.
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe(inv2.totalAmount);
    });
  });

  it("is unaffected by another customer's invoices", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customerA = await testCustomer(tx);
      const customerB = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });

      const orderB = await testOrderWithLine(tx, {
        userId, customerId: customerB.id, productId: product.id, quantity: 10, unitPrice: 100,
      });
      await createInvoiceFromOrder({ orderId: orderB.id, invoiceDate: date, createdById: userId }, tx);

      expect(toAmountString(await customerReceivable(customerA.id, tx))).toBe("0.00");
    });
  });
});

describe("syncCustomerOutstanding()", () => {
  it("writes the ledger-derived balance onto Customer.outstandingAmount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      // Before any invoice: the column starts at the schema default, 0.
      let row = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(toAmountString(row.outstandingAmount)).toBe("0.00");

      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      // createInvoiceFromOrder calls syncCustomerOutstanding itself.
      row = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(toAmountString(row.outstandingAmount)).toBe(invoice.totalAmount);
    });
  });

  it("is idempotent — calling it again does not change an already-correct value", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      const first = await syncCustomerOutstanding(customer.id, tx);
      const second = await syncCustomerOutstanding(customer.id, tx);
      expect(toAmountString(first)).toBe(toAmountString(second));
    });
  });
});

describe("reconcileOutstandingAmounts()", () => {
  it("flags a customer whose stored column disagrees with the ledger", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      // Simulate the old hand-typed field being wrong, the exact scenario R1
      // describes: nothing ever reconciled this column against reality.
      await tx.customer.update({ where: { id: customer.id }, data: { outstandingAmount: "9999.00" } });

      const rows = await reconcileOutstandingAmounts(tx);
      const row = rows.find((r) => r.customerId === customer.id);
      expect(row).toBeDefined();
      expect(row!.matches).toBe(false);
      expect(row!.storedOutstanding).toBe("9999.00");
      expect(row!.ledgerOutstanding).toBe("0.00");
    });
  });

  it("shows a match once synced", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      await tx.customer.update({ where: { id: customer.id }, data: { outstandingAmount: "9999.00" } });
      await syncCustomerOutstanding(customer.id, tx);

      const rows = await reconcileOutstandingAmounts(tx);
      const row = rows.find((r) => r.customerId === customer.id);
      expect(row!.matches).toBe(true);
    });
  });
});

describe("customerReceivable(): cancellation regression", () => {
  it("nets to zero after the only invoice is cancelled, not a phantom negative balance", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe("1050.00");

      await cancelInvoice({ invoiceId: invoice.invoiceId, reason: "Test cancellation", cancelledById: userId }, tx);

      // Before the fix, filtering journal lines to entry status "POSTED"
      // excluded the original (now REVERSED) debit while still counting the
      // reversal's credit, leaving this at -1050.00 instead of 0.00.
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe("0.00");
    });
  });
});

describe("customerAccountStatus()", () => {
  it("reports no overdue invoices and no payment history for a customer with none", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      const status = await customerAccountStatus(customer.id, new Date(), tx);
      expect(toAmountString(status.outstanding)).toBe("0.00");
      expect(status.overdueInvoices).toHaveLength(0);
      expect(status.lastPaymentDate).toBeNull();
    });
  });

  it("flags a POSTED invoice past its due date as overdue, with the correct days-overdue and outstanding amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });
      const dueDate = new Date(date.getTime() + 5 * 24 * 60 * 60 * 1000);
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, dueDate, createdById: userId }, tx);

      const asOf = new Date(dueDate.getTime() + 10 * 24 * 60 * 60 * 1000);
      const status = await customerAccountStatus(customer.id, asOf, tx);

      expect(status.overdueInvoices).toHaveLength(1);
      expect(status.overdueInvoices[0].daysOverdue).toBe(10);
      expect(toAmountString(status.overdueInvoices[0].outstanding)).toBe("1050.00");
      expect(toAmountString(status.overdueAmount)).toBe("1050.00");
    });
  });

  it("does not flag an invoice whose due date has not yet passed", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100,
      });
      const dueDate = new Date(date.getTime() + 30 * 24 * 60 * 60 * 1000);
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, dueDate, createdById: userId }, tx);

      const status = await customerAccountStatus(customer.id, date, tx);
      expect(status.overdueInvoices).toHaveLength(0);
    });
  });

  it("reports the last posted receipt as payment history", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100,
      });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      const cashAccountId = await accountId(tx, "1110");
      await recordReceipt(
        {
          receiptDate: date, customerId: customer.id, amount: "50", method: "CASH", depositAccountId: cashAccountId,
          allocations: [{ invoiceId: invoice.invoiceId, amount: "50" }], createdById: userId,
        },
        tx,
      );

      const status = await customerAccountStatus(customer.id, date, tx);
      expect(status.lastPaymentDate).not.toBeNull();
      expect(toAmountString(status.lastPaymentAmount!)).toBe("50.00");
    });
  });
});
