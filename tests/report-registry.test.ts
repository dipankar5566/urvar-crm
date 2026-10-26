import { describe, it, expect } from "vitest";
import { REPORT_REGISTRY, vyaparFilename } from "@/lib/accounting/report-registry";
import { createCashBankTransaction } from "@/lib/accounting/cash-bank";
import { createLoan } from "@/lib/accounting/loans";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import {
  withRollback,
  testUserId,
  openPeriodDate,
  accountId,
  ensureVerifiedTaxRate,
  testProduct,
  testCustomer,
  testOrderWithLine,
} from "./helpers/db";

/**
 * Vyapar parity step 4 — the export registry (docs/VYAPAR_PARITY_SPEC.md
 * §3.4, G13).
 *
 * Covers what the ad-hoc scripts used to develop this against the dev DB
 * already showed working (every one of the 32 registered reports loads
 * without error, and the PDF renderer produces a real PDF) — this file is
 * the permanent version of that check, plus the parts that need asserted
 * values rather than "it didn't throw": number flattening, ageing-bucket
 * columns, and the Vyapar filename convention.
 */

describe("vyaparFilename()", () => {
  it("formats a range as <Report>_<dd_mm_yy>_to_<dd_mm_yy>", () => {
    expect(vyaparFilename("Sale Report", new Date(2026, 9, 1), new Date(2026, 9, 31))).toBe("SaleReport_01_10_26_to_31_10_26");
  });
  it("formats a single date (asOf) as <Report>_<dd_mm_yy>", () => {
    expect(vyaparFilename("Trial Balance", undefined, new Date(2026, 9, 25))).toBe("TrialBalance_25_10_26");
  });
  it("drops punctuation from the title", () => {
    expect(vyaparFilename("Cash, Bank and Assets", undefined, new Date(2026, 9, 25))).toBe("CashBankandAssets_25_10_26");
  });
});

describe("REPORT_REGISTRY — every entry is registered with a consistent shape", () => {
  it("has 36 reports, each with a non-empty title and at least one need declared or none", () => {
    const ids = Object.keys(REPORT_REGISTRY);
    expect(ids.length).toBe(40);
    for (const id of ids) {
      const entry = REPORT_REGISTRY[id];
      expect(entry.id).toBe(id);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.needs)).toBe(true);
    }
  });
});

describe("REPORT_REGISTRY — row flattening against real fixtures", () => {
  it("day-book: Money In/Out come through as numbers, not Decimal objects", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await createCashBankTransaction(
        { type: "CASH_ADJUSTMENT", direction: "OVERAGE", amount: "500", txnDate: date, createdById: userId },
        tx,
      );
      const sheets = await REPORT_REGISTRY["day-book"].load({ from: date, to: date }, tx);
      expect(sheets).toHaveLength(1);
      const row = sheets[0].rows.find((r) => Number(r["Money In"]) === 500);
      expect(row).toBeDefined();
      expect(typeof row!["Money In"]).toBe("number");
      expect(typeof row!["Date"]).toBe("string");
    });
  });

  it("sale-report: produces a main sheet and an Item Details sheet with matching figures", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      await ensureVerifiedTaxRate(tx, "9999REG", 18);
      const product = await testProduct(tx, { hsnCode: "9999REG", mrp: 1000 });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 1000 });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const sheets = await REPORT_REGISTRY["sale-report"].load({ from: date, to: date }, tx);
      expect(sheets.map((s) => s.name)).toEqual(["Sale Report", "Item Details"]);
      const mainRow = sheets[0].rows.find((r) => r["Invoice No"] === invoice.invoiceNumber);
      expect(mainRow).toBeDefined();
      expect(mainRow!["Total Amount"]).toBe(1180); // 1000 + 18%
      const itemRow = sheets[1].rows.find((r) => r["Invoice/Txn No"] === invoice.invoiceNumber);
      expect(itemRow).toBeDefined();
      expect(itemRow!["HSN/SAC"]).toBe("9999REG");
      expect(itemRow!["Amount"]).toBe(1180);
    });
  });

  it("ar-ageing: flattens buckets into named columns with numbers", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      await ensureVerifiedTaxRate(tx, "9999AGE", 18);
      const product = await testProduct(tx, { hsnCode: "9999AGE", mrp: 1000 });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 1000 });
      await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const sheets = await REPORT_REGISTRY["ar-ageing"].load({ asOf: date }, tx);
      const row = sheets[0].rows.find((r) => r.Party === customer.name);
      expect(row).toBeDefined();
      expect(row!["Current"]).toBe(1180);
      expect(row!["Total"]).toBe(1180);
    });
  });

  it("loan-statement: needs loanId, and flattens the result's rows plus summary rows", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Registry Test Bank", disbursedToAccountId: bank, principal: "20000", annualRatePercent: "12", tenureMonths: 12, startDate: date, emiAmount: "2000", createdById: userId },
        tx,
      );
      const sheets = await REPORT_REGISTRY["loan-statement"].load({ loanId, from: date, to: date }, tx);
      expect(sheets).toHaveLength(1);
      expect(sheets[0].name).toContain("Registry Test Bank");
      const disbursementRow = sheets[0].rows.find((r) => r.Type === "Disbursement");
      expect(disbursementRow!["Amount"]).toBe(20000);
      const balanceDueRow = sheets[0].rows.find((r) => r.Type === "Balance Due");
      expect(balanceDueRow!["Amount"]).toBe(20000);
    });
  });

  it("party-statement: needs partyId and partyType, resolves the party's name into the sheet title", async () => {
    await withRollback(async (tx) => {
      const customer = await testCustomer(tx);
      const date = await openPeriodDate(tx);
      const sheets = await REPORT_REGISTRY["party-statement"].load({ partyId: customer.id, partyType: "CUSTOMER", from: date, to: date }, tx);
      expect(sheets[0].name).toBe(`Statement - ${customer.name}`);
      expect(sheets[0].rows[0].Narration).toBe("Opening balance");
    });
  });

  it("ledger: needs accountId, and the opening-balance row has no debit/credit", async () => {
    await withRollback(async (tx) => {
      const cash = await accountId(tx, "1110");
      const date = await openPeriodDate(tx);
      const userId = await testUserId(tx);
      await createCashBankTransaction({ type: "CASH_ADJUSTMENT", direction: "OVERAGE", amount: "250", txnDate: date, createdById: userId }, tx);
      const sheets = await REPORT_REGISTRY["ledger"].load({ accountId: cash, from: date, to: date }, tx);
      expect(sheets[0].rows[0].Narration).toBe("Opening balance");
      expect(sheets[0].rows[0].Debit).toBe("");
      const movedRow = sheets[0].rows.find((r) => r.Debit === 250);
      expect(movedRow).toBeDefined();
    });
  });

  it("gst: returns two sheets, Summary and Outward Supply Register", async () => {
    await withRollback(async (tx) => {
      const date = await openPeriodDate(tx);
      const sheets = await REPORT_REGISTRY["gst"].load({ from: date, to: date }, tx);
      expect(sheets.map((s) => s.name)).toEqual(["GST Summary", "Outward Supply Register"]);
      expect(sheets[0].rows).toHaveLength(3); // Output / Input / Net
    });
  });

  it("cash-bank-assets: combines cash, bank, fixed assets and loan groups into one sheet", async () => {
    await withRollback(async (tx) => {
      const date = await openPeriodDate(tx);
      const sheets = await REPORT_REGISTRY["cash-bank-assets"].load({ asOf: date }, tx);
      expect(sheets).toHaveLength(1);
      const groups = new Set(sheets[0].rows.map((r) => r.Group));
      expect(groups.has("Cash In Hand")).toBe(true);
    });
  });
});

describe("REPORT_REGISTRY — every range/asOf-only report loads without error against the dev DB", () => {
  it("runs every entry that needs no extra id", async () => {
    await withRollback(async (tx) => {
      const date = await openPeriodDate(tx);
      for (const [id, entry] of Object.entries(REPORT_REGISTRY)) {
        if (entry.needs.some((n) => n === "accountId" || n === "partyId" || n === "partyType" || n === "loanId" || n === "custom")) continue;
        const params = entry.needs.includes("asOf") ? { asOf: date } : { from: date, to: date };
        await expect(entry.load(params, tx), id).resolves.toBeDefined();
      }
    });
  });
});
