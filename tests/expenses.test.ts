import { describe, it, expect } from "vitest";
import { createExpense, approveExpense, rejectExpense, cancelExpense, ExpenseError } from "@/lib/accounting/expenses";
import { toAmountString, sum } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate } from "./helpers/db";

async function rentAccountId(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const acc = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "5420" } }); // Rent
  return acc.id;
}
async function cashAccountId(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const acc = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1110" } }); // Cash on Hand
  return acc.id;
}

describe("createExpense()", () => {
  it("creates a SUBMITTED expense with a numbered id", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Landlord",
        amount: "15000.00",
        method: "BANK_TRANSFER",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(expense.status).toBe("SUBMITTED");
      expect(expense.expenseNumber).toMatch(/^EXP\/\d{4}-\d{2}\/\d{4}$/);
      expect(toAmountString(expense.amount)).toBe("15000.00");
    });
  });

  it("refuses a zero amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(
        createExpense({
          expenseDate: new Date(), categoryAccountId: await rentAccountId(tx), payeeName: "X",
          amount: "0", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(ExpenseError);
    });
  });

  it("refuses a category account that isn't an EXPENSE type", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const arAccount = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1130" } }); // AR, an ASSET
      await expect(
        createExpense({
          expenseDate: new Date(), categoryAccountId: arAccount.id, payeeName: "X",
          amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(/not an expense account/i);
    });
  });

  it("refuses a grouping expense account", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const group = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "5400" } }); // Operating Expenses, a group
      await expect(
        createExpense({
          expenseDate: new Date(), categoryAccountId: group.id, payeeName: "X",
          amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(/grouping account/i);
    });
  });
});

describe("approveExpense(): posts on approval", () => {
  it("posts a balanced entry: debit the category, credit the payment account", async () => {
    await withRollback(async (tx) => {
      const submitter = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Landlord",
        amount: "15000.00",
        method: "BANK_TRANSFER",
        paymentAccountId: await cashAccountId(tx),
        createdById: submitter,
      }, tx);

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: submitter },
        tx,
      );

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(expense.status).toBe("APPROVED");
      expect(expense.postedEntryId).toBe(journalEntryId);

      const lines = await tx.journalLine.findMany({ where: { entryId: journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("15000.00");
    });
  });

  it("refuses to approve a non-SUBMITTED expense", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await approveExpense({ expenseId, approverRole: "SUPER_ADMIN", approvedById: userId }, tx);
      await expect(
        approveExpense({ expenseId, approverRole: "SUPER_ADMIN", approvedById: userId }, tx),
      ).rejects.toThrow(/only a submitted expense/i);
    });
  });

  it("blocks self-approval for a non-exempt role", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await expect(
        approveExpense({ expenseId, approverRole: "ACCOUNTS_TEAM", approvedById: userId }, tx),
      ).rejects.toThrow(/cannot approve an expense you submitted/i);
    });
  });

  it("allows the Super Admin exemption to self-approve", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      expect(journalEntryId).toBeTruthy();
    });
  });
});

describe("rejectExpense()", () => {
  it("marks REJECTED with a reason and posts nothing", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await rejectExpense({ expenseId, reason: "Missing receipt", rejectedById: userId }, tx);
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(expense.status).toBe("REJECTED");
      expect(expense.rejectedReason).toBe("Missing receipt");
      expect(expense.postedEntryId).toBeNull();
    });
  });
});

describe("cancelExpense()", () => {
  it("reverses an approved expense's posting", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );

      await cancelExpense({ expenseId, reason: "Duplicate entry", cancelledById: userId }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(expense.status).toBe("CANCELLED");
      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId } });
      expect(entry.status).toBe("REVERSED");
    });
  });

  it("refuses to cancel an expense that was never approved", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx), categoryAccountId: await rentAccountId(tx), payeeName: "X",
        amount: "100", method: "CASH", paymentAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await expect(
        cancelExpense({ expenseId, reason: "N/A", cancelledById: userId }, tx),
      ).rejects.toThrow(/only an approved expense/i);
    });
  });
});
