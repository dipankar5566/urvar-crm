import { describe, it, expect } from "vitest";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import { postJournalEntry } from "@/lib/accounting/posting";
import {
  partyStatement, billWiseProfit, allPartiesSummary, itemWiseDiscount, discountReport,
  accountGroupBalances, cashOnHandBalance, cashFlowSummary, dayBook, hsnSummary,
} from "@/lib/accounting/financial-reports";
import { toAmountString } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, ensureVerifiedTaxRate, accountId,
  testProduct, testCustomer, testOrderWithLine, testSupplier, testPurchaseInvoice,
} from "./helpers/db";

describe("partyStatement()", () => {
  it("a customer statement is debit-normal: an invoice increases the balance the customer owes", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const result = await partyStatement(customer.id, "CUSTOMER", date, date, tx);
      expect(result.lines).toHaveLength(1);
      expect(toAmountString(result.openingBalance)).toBe("0.00");
      // 1000 taxable + 5% GST = 1050, and the balance owed rose by that much.
      expect(toAmountString(result.closingBalance)).toBe("1050.00");
      expect(result.closingBalance.greaterThan(result.openingBalance)).toBe(true);
    });
  });

  it("a supplier statement is credit-normal: a purchase increases the balance we owe", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000", taxAmount: "0", totalAmount: "1000" });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const result = await partyStatement(supplier.id, "SUPPLIER", date, date, tx);
      expect(toAmountString(result.closingBalance)).toBe("1000.00");
      expect(result.closingBalance.greaterThan(result.openingBalance)).toBe(true);
    });
  });

  it("respects the opening-balance boundary: activity before fromDate rolls into the opening balance, not a line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const dayAfter = new Date(date.getTime() + 24 * 60 * 60 * 1000);
      const result = await partyStatement(customer.id, "CUSTOMER", dayAfter, dayAfter, tx);
      expect(result.lines).toHaveLength(0);
      expect(toAmountString(result.openingBalance)).toBe("1050.00");
      expect(toAmountString(result.closingBalance)).toBe("1050.00");
    });
  });
});

describe("billWiseProfit()", () => {
  it("flags a null estimated cost rather than treating it as zero", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" }); // no purchase history -> null estimatedUnitCost
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const rows = await billWiseProfit(date, date, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0].hasUnknownCostLine).toBe(true);
      expect(rows[0].estimatedCost).toBeNull();
      expect(rows[0].estimatedMargin).toBeNull();
      expect(toAmountString(rows[0].revenue)).toBe("1000.00");
    });
  });
});

describe("allPartiesSummary()", () => {
  it("settled equals invoiced minus outstanding for a fully unpaid invoice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const rows = await allPartiesSummary(date, tx);
      const row = rows.find((r) => r.partyId === customer.id);
      expect(row).toBeDefined();
      expect(row!.partyType).toBe("CUSTOMER");
      expect(toAmountString(row!.totalInvoiced)).toBe("1050.00");
      expect(toAmountString(row!.outstanding)).toBe("1050.00");
      expect(toAmountString(row!.totalSettled)).toBe("0.00");
    });
  });
});

describe("itemWiseDiscount() / discountReport()", () => {
  it("recomputes discount as quantity × unitPrice × discountPercent, matching tax.ts's own formula", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      // createInvoiceFromOrder always writes discountPercent 0 today (no UI
      // path sets a per-line discount yet) — simulate one directly to verify
      // the report's own aggregation formula independent of that gap.
      await tx.salesInvoiceItem.updateMany({ where: { invoiceId: invoice.invoiceId }, data: { discountPercent: "10" } });

      const itemRows = await itemWiseDiscount(date, date, tx);
      expect(itemRows).toHaveLength(1);
      expect(toAmountString(itemRows[0].discountAmount)).toBe("100.00"); // 10 * 100 * 10%

      const customerRows = await discountReport(date, date, tx);
      expect(customerRows).toHaveLength(1);
      expect(toAmountString(customerRows[0].discountAmount)).toBe("100.00");
    });
  });

  it("returns nothing when no line carries a discount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      expect(await itemWiseDiscount(date, date, tx)).toHaveLength(0);
    });
  });
});

describe("accountGroupBalances() / cashOnHandBalance()", () => {
  it("Fixed Assets (1200) and Loans (2200) already exist in the seed with no new setup", async () => {
    await withRollback(async (tx) => {
      const fixedAssets = await accountGroupBalances("1200", new Date(), tx);
      const loans = await accountGroupBalances("2200", new Date(), tx);
      expect(fixedAssets).not.toBeNull();
      expect(fixedAssets!.accounts.length).toBeGreaterThan(0);
      expect(loans).not.toBeNull();
      expect(loans!.accounts.some((a) => a.code === "2210")).toBe(true); // "Loans"
    });
  });

  it("returns null for a code that isn't in the chart of accounts", async () => {
    await withRollback(async (tx) => {
      expect(await accountGroupBalances("9999", new Date(), tx)).toBeNull();
    });
  });

  it("cashOnHandBalance reads account 1110 directly, debit-normal", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { postJournalEntry } = await import("@/lib/accounting/posting");
      const { accountId } = await import("./helpers/db");
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");
      await postJournalEntry(
        {
          entryDate: date, narration: "Cash in", sourceType: "MANUAL",
          idempotencyKey: `TEST:CASH:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "500" }, { accountId: capital, credit: "500" }],
        },
        tx,
      );
      const result = await cashOnHandBalance(date, tx);
      expect(result).not.toBeNull();
      expect(toAmountString(result!.balance)).toBe("500.00");
    });
  });
});

describe("dayBook() / hsnSummary()", () => {
  it("dayBook lists every posted line across accounts, chronologically, within range", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const entries = await dayBook(date, date, tx);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries.find((e) => e.sourceType === "SALES_INVOICE");
      expect(entry).toBeDefined();
      const totalDebit = entry!.lines.reduce((s, l) => s.plus(l.debit), entry!.lines[0].debit.minus(entry!.lines[0].debit));
      const totalCredit = entry!.lines.reduce((s, l) => s.plus(l.credit), entry!.lines[0].credit.minus(entry!.lines[0].credit));
      expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
    });
  });

  it("hsnSummary aggregates gstOutwardSupplyRegister rows by HSN", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const product = await testProduct(tx, { hsnCode: "3101" });
      const customer = await testCustomer(tx, { state: "West Bengal" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const rows = await hsnSummary(date, date, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0].hsnCode).toBe("3101");
      expect(toAmountString(rows[0].taxableValue)).toBe("1000.00");
      expect(rows[0].count).toBe(1);
    });
  });
});

describe("accountGroupBalances() / cashFlowSummary() — Phase 8 regressions found while designing Phase 9", () => {
  it("nets a contra account DOWN, never adds it — a credit to Accumulated Depreciation reduces the Fixed Assets group total", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210"); // Fixed Assets, DEBIT-normal
      const accumDep = await accountId(tx, "1290"); // contra-asset, CREDIT-normal, same group
      const capital = await accountId(tx, "3100");

      // Simulate an asset costing 1,00,000 with 10,000 already depreciated —
      // no FixedAsset model needed for this, just two postings to real
      // pre-existing accounts.
      await postJournalEntry(
        { entryDate: date, narration: "Test asset cost", sourceType: "MANUAL",
          idempotencyKey: `TEST:AGB-COST:${Date.now()}`, postedById: userId,
          lines: [{ accountId: plantMachinery, debit: "100000" }, { accountId: capital, credit: "100000" }] },
        tx,
      );
      await postJournalEntry(
        { entryDate: date, narration: "Test accumulated depreciation", sourceType: "MANUAL",
          idempotencyKey: `TEST:AGB-DEP:${Date.now()}`, postedById: userId,
          lines: [{ accountId: capital, debit: "10000" }, { accountId: accumDep, credit: "10000" }] },
        tx,
      );

      const result = await accountGroupBalances("1200", date, tx);
      expect(result).not.toBeNull();
      // Must be 90,000 (cost minus accumulated depreciation), not 110,000
      // (the pre-fix bug: signing by each child's own normalBalance made the
      // CREDIT-normal contra account ADD to the DEBIT-normal group instead
      // of subtracting).
      expect(toAmountString(result!.total)).toBe("90000.00");
    });
  });

  it("includes movement through every bank account, not just the mapped default", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const flipkart = await accountId(tx, "1122"); // Bank - Flipkart Settlement, NOT the mapped BANK_DEFAULT
      const revenue = await accountId(tx, "4100");

      await postJournalEntry(
        { entryDate: date, narration: "Flipkart settlement", sourceType: "MANUAL",
          idempotencyKey: `TEST:CFS:${Date.now()}`, postedById: userId,
          lines: [{ accountId: flipkart, debit: "5000" }, { accountId: revenue, credit: "5000" }] },
        tx,
      );

      const result = await cashFlowSummary(date, date, tx);
      // Pre-fix, this was structurally zero: only CASH_ON_HAND/BANK_DEFAULT
      // were ever resolved, so 1122 never contributed to any bucket.
      expect(toAmountString(result.totalInflow)).toBe("5000.00");
    });
  });
});
