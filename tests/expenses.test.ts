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

async function linesWithCode(tx: Parameters<Parameters<typeof withRollback>[0]>[0], entryId: string) {
  return tx.journalLine.findMany({ where: { entryId }, include: { account: { select: { code: true } } } });
}

describe("createExpense() / approveExpense(): itemised (Part B — line items, GST, transport, round-off)", () => {
  it("computes subtotal, tax and total from line items with GST off", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Stationery Shop",
        items: [
          { description: "Paper", quantity: 2, unitPrice: 100 },
          { description: "Pens", quantity: 10, unitPrice: 5 },
        ],
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId }, include: { items: true } });
      expect(expense.items).toHaveLength(2);
      expect(toAmountString(expense.subtotal)).toBe("250.00");
      expect(toAmountString(expense.cgstAmount)).toBe("0.00");
      expect(toAmountString(expense.amount)).toBe("250.00");
      expect(toAmountString(expense.roundOff)).toBe("0.00");
    });
  });

  it("GST on, ITC not claimed: tax folds into the category account, GST_INPUT_* untouched", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Service", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
        isGstApplicable: true,
        claimInputCredit: false,
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(toAmountString(expense.subtotal)).toBe("1000.00");
      expect(toAmountString(expense.amount)).toBe("1180.00"); // 1000 + 18% GST, no ITC claim

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const rentLine = lines.find((l) => l.account.code === "5420");
      expect(toAmountString(rentLine!.debit)).toBe("1180.00"); // subtotal + tax, folded together
      expect(lines.some((l) => l.account.code === "1151" || l.account.code === "1152")).toBe(false); // no GST_INPUT posting
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("GST on, ITC claimed: tax splits CGST/SGST into GST_INPUT_*, category gets only the subtotal", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Service", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
        isGstApplicable: true,
        claimInputCredit: true,
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const rentLine = lines.find((l) => l.account.code === "5420");
      const cgstLine = lines.find((l) => l.account.code === "1151");
      const sgstLine = lines.find((l) => l.account.code === "1152");
      expect(toAmountString(rentLine!.debit)).toBe("1000.00"); // subtotal only — tax carved out
      expect(toAmountString(cgstLine!.debit)).toBe("90.00");
      expect(toAmountString(sgstLine!.debit)).toBe("90.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("posts the Transportation amount to Freight Inward, separate from the category", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Goods", quantity: 1, unitPrice: 500 }],
        transportAmount: 50,
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const freightLine = lines.find((l) => l.account.code === "5310"); // Freight Inward
      expect(toAmountString(freightLine!.debit)).toBe("50.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("rounding UP debits Round Off (mirror image of invoicing.ts, which credits it)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Goods", quantity: 1, unitPrice: 100.6 }], // rounds 100.60 -> 101
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(toAmountString(expense.roundOff)).toBe("0.40");
      expect(toAmountString(expense.amount)).toBe("101.00");

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const roundOffLine = lines.find((l) => l.account.code === "4910");
      expect(toAmountString(roundOffLine!.debit)).toBe("0.40");
      expect(toAmountString(roundOffLine!.credit)).toBe("0.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("rounding DOWN credits Round Off", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Goods", quantity: 1, unitPrice: 100.3 }], // rounds 100.30 -> 100
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(toAmountString(expense.roundOff)).toBe("-0.30");
      expect(toAmountString(expense.amount)).toBe("100.00");

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const roundOffLine = lines.find((l) => l.account.code === "4910");
      expect(toAmountString(roundOffLine!.credit)).toBe("0.30");
      expect(toAmountString(roundOffLine!.debit)).toBe("0.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("a multi-line total equals subtotal + transport + tax, rounded, with everything reconciling", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [
          { description: "A", quantity: 2, unitPrice: 150, taxRatePercent: 18 },
          { description: "B", quantity: 1, unitPrice: 75.5, taxRatePercent: 5 },
        ],
        isGstApplicable: true,
        claimInputCredit: true,
        transportAmount: 25,
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      // subtotal = 300 + 75.50 = 375.50; tax = 54.00 + 3.78 = 57.78; +25 transport
      expect(toAmountString(expense.subtotal)).toBe("375.50");
      const totalTax = expense.cgstAmount.plus(expense.sgstAmount);
      expect(toAmountString(totalTax)).toBe("57.78");
      const beforeRounding = expense.subtotal.plus(expense.transportAmount).plus(totalTax);
      expect(beforeRounding.plus(expense.roundOff).toFixed(2)).toBe(toAmountString(expense.amount));

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      // The payment line specifically — not sum(credits), which also
      // includes the Round Off line's own credit when rounding down.
      const cashLine = lines.find((l) => l.account.code === "1110");
      expect(toAmountString(cashLine!.credit)).toBe(toAmountString(expense.amount));
    });
  });

  it("cancelling an itemised, ITC-claimed expense reverses the entry to net zero", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Vendor",
        items: [{ description: "Service", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
        isGstApplicable: true,
        claimInputCredit: true,
        transportAmount: 10,
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);
      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );

      await cancelExpense({ expenseId, reason: "Duplicate", cancelledById: userId }, tx);

      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId } });
      expect(entry.status).toBe("REVERSED");
      const allLines = await tx.journalLine.findMany({
        where: { entry: { OR: [{ id: journalEntryId }, { reversesEntryId: journalEntryId }] } },
      });
      expect(toAmountString(sum(allLines.map((l) => l.debit)))).toBe(toAmountString(sum(allLines.map((l) => l.credit))));
    });
  });

  it("a legacy no-items expense still posts exactly as before (backward compatible)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { expenseId } = await createExpense({
        expenseDate: await openPeriodDate(tx),
        categoryAccountId: await rentAccountId(tx),
        payeeName: "Landlord",
        amount: "5000",
        method: "CASH",
        paymentAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId }, include: { items: true } });
      expect(expense.items).toHaveLength(0);
      expect(expense.isGstApplicable).toBe(false);
      expect(toAmountString(expense.roundOff)).toBe("0.00");

      const { journalEntryId } = await approveExpense(
        { expenseId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      expect(lines).toHaveLength(2); // just category debit, payment credit — no new lines introduced
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("5000.00");
    });
  });

  it("rejects an item line with a zero quantity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(
        createExpense({
          expenseDate: await openPeriodDate(tx),
          categoryAccountId: await rentAccountId(tx),
          payeeName: "Vendor",
          items: [{ description: "Bad line", quantity: 0, unitPrice: 100 }],
          method: "CASH",
          paymentAccountId: await cashAccountId(tx),
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/quantity greater than zero/i);
    });
  });
});
