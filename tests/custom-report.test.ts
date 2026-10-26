import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createExpense, approveExpense } from "@/lib/accounting/expenses";
import {
  runCustomReport,
  saveCustomReportDefinition,
  listCustomReportDefinitions,
  deleteCustomReportDefinition,
  sanitizeColumns,
  CustomReportError,
} from "@/lib/accounting/custom-report";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

/**
 * Vyapar parity step 7 (docs/VYAPAR_PARITY_SPEC.md §3.5) — "a user picks
 * columns and filters over R3's dataset. Saved definitions per user."
 */

async function approvedExpense(
  tx: Prisma.TransactionClient,
  userId: string,
  date: Date,
  payeeName: string,
  amount: string,
) {
  const rent = await accountId(tx, "5420");
  const cash = await accountId(tx, "1110");
  const { expenseId } = await createExpense(
    { expenseDate: date, categoryAccountId: rent, payeeName, amount, method: "CASH", paymentAccountId: cash, createdById: userId },
    tx,
  );
  await approveExpense({ expenseId, approverRole: "SUPER_ADMIN", approvedById: userId }, tx);
  return expenseId;
}

describe("runCustomReport()", () => {
  it("filters by transaction type, party name and amount range, and projects only the requested columns", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await approvedExpense(tx, userId, date, "Test Landlord Co", "1200.00");

      const all = await runCustomReport(date, date, ["date", "partyName", "transactionType", "total"], {}, tx);
      const row = all.rows.find((r) => r["Party Name"] === "Test Landlord Co");
      expect(row).toBeDefined();
      expect(row!["Type"]).toBe("Expense");
      expect(Object.keys(row!).sort()).toEqual(["Date", "Party Name", "Total", "Type"].sort());

      const byType = await runCustomReport(date, date, ["partyName"], { transactionTypes: ["Expense"] }, tx);
      expect(byType.rows.some((r) => r["Party Name"] === "Test Landlord Co")).toBe(true);
      const bySale = await runCustomReport(date, date, ["partyName"], { transactionTypes: ["Sale"] }, tx);
      expect(bySale.rows.some((r) => r["Party Name"] === "Test Landlord Co")).toBe(false);

      const byParty = await runCustomReport(date, date, ["partyName"], { partyContains: "landlord" }, tx);
      expect(byParty.rows.some((r) => r["Party Name"] === "Test Landlord Co")).toBe(true);
      const byOtherParty = await runCustomReport(date, date, ["partyName"], { partyContains: "nobody here" }, tx);
      expect(byOtherParty.rows.length).toBe(0);

      const inRange = await runCustomReport(date, date, ["partyName"], { minAmount: "1000", maxAmount: "1500" }, tx);
      expect(inRange.rows.some((r) => r["Party Name"] === "Test Landlord Co")).toBe(true);
      const outOfRange = await runCustomReport(date, date, ["partyName"], { minAmount: "5000" }, tx);
      expect(outOfRange.rows.some((r) => r["Party Name"] === "Test Landlord Co")).toBe(false);
    });
  });
});

describe("sanitizeColumns()", () => {
  it("drops unknown keys and falls back to every column when nothing valid remains", () => {
    expect(sanitizeColumns(["date", "notAColumn", "total"])).toEqual(["date", "total"]);
    expect(sanitizeColumns(["bogus"]).length).toBeGreaterThan(1);
  });
});

describe("saveCustomReportDefinition() / listCustomReportDefinitions() / deleteCustomReportDefinition()", () => {
  it("saves, lists for the owning user, and refuses deletion by anyone else", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { id } = await saveCustomReportDefinition(
        { name: "My Expense View", columns: ["date", "total"], transactionTypes: ["Expense"], minAmount: "100", createdById: userId },
        tx,
      );

      const saved = await listCustomReportDefinitions(userId, tx);
      const found = saved.find((r) => r.id === id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("My Expense View");
      expect(found!.transactionTypes).toEqual(["Expense"]);
      expect(found!.minAmount).toBe("100.00");

      await expect(deleteCustomReportDefinition({ id, deletedById: "someone-else" }, tx)).rejects.toThrow(CustomReportError);

      await deleteCustomReportDefinition({ id, deletedById: userId }, tx);
      expect((await listCustomReportDefinitions(userId, tx)).some((r) => r.id === id)).toBe(false);
    });
  });

  it("refuses an unnamed report", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(
        saveCustomReportDefinition({ name: "   ", columns: ["date"], transactionTypes: [], createdById: userId }, tx),
      ).rejects.toThrow(/name/i);
    });
  });
});
