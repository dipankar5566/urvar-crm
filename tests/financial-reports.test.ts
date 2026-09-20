import { describe, it, expect } from "vitest";
import { postJournalEntry } from "@/lib/accounting/posting";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import {
  trialBalance, generalLedger, profitAndLoss, balanceSheet, gstTaxSummary, gstOutwardSupplyRegister,
  accountsReceivableAgeing, accountsPayableAgeing,
} from "@/lib/accounting/financial-reports";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, accountId, openPeriodDate, ensureVerifiedTaxRate,
  testProduct, testCustomer, testOrderWithLine, testSupplier, testPurchaseInvoice,
} from "./helpers/db";

const DAY = 24 * 60 * 60 * 1000;

describe("trialBalance()", () => {
  it("has equal debit and credit columns and shows the posted amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");

      await postJournalEntry(
        {
          entryDate: date,
          narration: "Owner capital introduced",
          sourceType: "MANUAL",
          idempotencyKey: `TEST:TB:${Date.now()}`,
          postedById: userId,
          lines: [
            { accountId: cash, debit: "5000" },
            { accountId: capital, credit: "5000" },
          ],
        },
        tx,
      );

      const rows = await trialBalance(date, tx);
      const totalDebit = sum(rows.map((r) => r.debit));
      const totalCredit = sum(rows.map((r) => r.credit));
      expect(toAmountString(totalDebit)).toBe(toAmountString(totalCredit));

      const cashRow = rows.find((r) => r.accountId === cash);
      expect(toAmountString(cashRow!.debit)).toBe("5000.00");
      expect(toAmountString(cashRow!.credit)).toBe("0.00");
    });
  });

  it("omits an account with net-zero activity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");

      await postJournalEntry(
        {
          entryDate: date, narration: "In", sourceType: "MANUAL",
          idempotencyKey: `TEST:TB-ZERO-IN:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "100" }, { accountId: capital, credit: "100" }],
        },
        tx,
      );
      await postJournalEntry(
        {
          entryDate: date, narration: "Out", sourceType: "MANUAL",
          idempotencyKey: `TEST:TB-ZERO-OUT:${Date.now()}`, postedById: userId,
          lines: [{ accountId: capital, debit: "100" }, { accountId: cash, credit: "100" }],
        },
        tx,
      );

      const rows = await trialBalance(date, tx);
      expect(rows.find((r) => r.accountId === cash)).toBeUndefined();
      expect(rows.find((r) => r.accountId === capital)).toBeUndefined();
    });
  });
});

describe("generalLedger()", () => {
  it("carries an opening balance forward and computes a correct running balance", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");
      // openPeriodDate() returns the period's own start date, so "before the
      // range" has to stay inside the same OPEN period rather than subtract
      // a day off it (which would land before any period exists).
      const before = new Date(date.getTime());
      const within = new Date(date.getTime() + DAY);
      const later = new Date(date.getTime() + 2 * DAY);

      await postJournalEntry(
        {
          entryDate: before, narration: "Opening", sourceType: "MANUAL",
          idempotencyKey: `TEST:GL-OPEN:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "1000" }, { accountId: capital, credit: "1000" }],
        },
        tx,
      );
      await postJournalEntry(
        {
          entryDate: within, narration: "Deposit", sourceType: "MANUAL",
          idempotencyKey: `TEST:GL-MID:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "500" }, { accountId: capital, credit: "500" }],
        },
        tx,
      );

      const result = await generalLedger(cash, within, later, tx);
      expect(toAmountString(result.openingBalance)).toBe("1000.00");
      expect(result.lines).toHaveLength(1);
      expect(toAmountString(result.lines[0].runningBalance)).toBe("1500.00");
      expect(toAmountString(result.closingBalance)).toBe("1500.00");
    });
  });

  it("nets a reversed entry to zero once the reversal date has passed", async () => {
    await withRollback(async (tx) => {
      const { reverseJournalEntry } = await import("@/lib/accounting/posting");
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");

      const posted = await postJournalEntry(
        {
          entryDate: date, narration: "Entry to reverse", sourceType: "MANUAL",
          idempotencyKey: `TEST:GL-REV:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "300" }, { accountId: capital, credit: "300" }],
        },
        tx,
      );
      await reverseJournalEntry({ entryId: posted.entryId, reason: "Test reversal", postedById: userId }, tx);

      const result = await generalLedger(cash, date, date, tx);
      expect(toAmountString(result.closingBalance)).toBe("0.00");
    });
  });
});

describe("profitAndLoss()", () => {
  it("reports revenue from a posted sales invoice and computes net profit", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
      });

      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const result = await profitAndLoss(date, date, tx);
      const revenueLine = result.income.find((l) => l.code === "4100");
      expect(toAmountString(revenueLine!.amount)).toBe("1000.00");
      expect(toAmountString(result.netProfit)).toBe(toAmountString(result.totalIncome));
    });
  });

  it("excludes activity outside the date range", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const outside = new Date(date.getTime() + 10 * DAY);
      const revenue = await accountId(tx, "4100");
      const cash = await accountId(tx, "1110");

      await postJournalEntry(
        {
          entryDate: outside, narration: "Later sale", sourceType: "MANUAL",
          idempotencyKey: `TEST:PNL-OUT:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "200" }, { accountId: revenue, credit: "200" }],
        },
        tx,
      );

      const result = await profitAndLoss(date, date, tx);
      expect(result.income.find((l) => l.code === "4100")).toBeUndefined();
    });
  });
});

describe("balanceSheet()", () => {
  it("always balances: Assets = Liabilities + Equity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 200,
      });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const result = await balanceSheet(date, tx);
      expect(result.balances).toBe(true);
      expect(toAmountString(result.totalAssets)).toBe(
        toAmountString(result.totalLiabilities.plus(result.totalEquity)),
      );
    });
  });

  it("folds cumulative net profit into equity as Current Earnings", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const revenue = await accountId(tx, "4100");
      const cash = await accountId(tx, "1110");

      await postJournalEntry(
        {
          entryDate: date, narration: "Cash sale", sourceType: "MANUAL",
          idempotencyKey: `TEST:BS-EARN:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "750" }, { accountId: revenue, credit: "750" }],
        },
        tx,
      );

      const result = await balanceSheet(date, tx);
      expect(toAmountString(result.currentEarnings)).toBe("750.00");
      expect(result.balances).toBe(true);
    });
  });
});

describe("gstTaxSummary()", () => {
  it("nets output tax against input tax over the range", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 1000,
      });
      // 10,000 taxable @ 5% intra-state = 250 CGST + 250 SGST output.
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const purchase = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "4000", taxAmount: "200", totalAmount: "4200",
      });
      // 200 tax intra-state = 100 input CGST + 100 input SGST.
      await postPurchaseInvoice({ invoiceId: purchase.id, postedById: userId }, tx);

      const result = await gstTaxSummary(date, date, tx);
      expect(toAmountString(result.outputCgst)).toBe("250.00");
      expect(toAmountString(result.outputSgst)).toBe("250.00");
      expect(toAmountString(result.inputCgst)).toBe("100.00");
      expect(toAmountString(result.inputSgst)).toBe("100.00");
      expect(toAmountString(result.netPayable)).toBe(
        toAmountString(result.totalOutput.minus(result.totalInput)),
      );
      expect(toAmountString(result.netPayable)).toBe("300.00");
    });
  });
});

describe("gstOutwardSupplyRegister()", () => {
  it("lists a posted invoice's line with its HSN and tax split", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 2, unitPrice: 500,
      });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const rows = await gstOutwardSupplyRegister(date, date, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0].hsnCode).toBe("3101");
      expect(toAmountString(rows[0].taxableValue)).toBe("1000.00");
    });
  });

  it("excludes a cancelled invoice", async () => {
    await withRollback(async (tx) => {
      const { cancelInvoice } = await import("@/lib/accounting/invoicing");
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100,
      });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      await cancelInvoice({ invoiceId: invoice.invoiceId, reason: "Test cancel", cancelledById: userId }, tx);

      const rows = await gstOutwardSupplyRegister(date, date, tx);
      expect(rows).toHaveLength(0);
    });
  });
});

describe("accountsReceivableAgeing()", () => {
  it("buckets an invoice by days past its due date", async () => {
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

      const asOf = new Date(dueDate.getTime() + 40 * 24 * 60 * 60 * 1000); // 40 days past due
      const rows = await accountsReceivableAgeing(asOf, tx);
      const row = rows.find((r) => r.partyId === customer.id);
      expect(row).toBeDefined();
      expect(toAmountString(row!.buckets.d31_60)).toBe("1050.00");
      expect(toAmountString(row!.buckets.current)).toBe("0.00");
      expect(toAmountString(row!.total)).toBe("1050.00");
    });
  });

  it("omits a fully paid invoice", async () => {
    await withRollback(async (tx) => {
      const { recordReceipt } = await import("@/lib/accounting/receipts");
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, {
        userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100,
      });
      const dueDate = new Date(date.getTime() + 5 * 24 * 60 * 60 * 1000);
      const invoice = await createInvoiceFromOrder(
        { orderId: order.id, invoiceDate: date, dueDate, createdById: userId }, tx,
      );
      const cashAccountId = await accountId(tx, "1110");
      await recordReceipt(
        {
          receiptDate: date, customerId: customer.id, amount: invoice.totalAmount, method: "CASH",
          depositAccountId: cashAccountId,
          allocations: [{ invoiceId: invoice.invoiceId, amount: invoice.totalAmount }], createdById: userId,
        },
        tx,
      );

      const asOf = new Date(dueDate.getTime() + 60 * 24 * 60 * 60 * 1000);
      const rows = await accountsReceivableAgeing(asOf, tx);
      expect(rows.find((r) => r.partyId === customer.id)).toBeUndefined();
    });
  });
});

describe("accountsPayableAgeing()", () => {
  it("buckets a purchase invoice by days since its invoice date", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000", taxAmount: "50", totalAmount: "1050",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const asOf = new Date(date.getTime() + 75 * 24 * 60 * 60 * 1000); // 75 days since invoice date
      const rows = await accountsPayableAgeing(asOf, tx);
      const row = rows.find((r) => r.partyId === supplier.id);
      expect(row).toBeDefined();
      expect(toAmountString(row!.buckets.d61_90)).toBe("1050.00");
      expect(toAmountString(row!.total)).toBe("1050.00");
    });
  });
});
