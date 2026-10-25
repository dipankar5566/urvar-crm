import { describe, it, expect } from "vitest";
import { createOtherIncome, approveOtherIncome, rejectOtherIncome, cancelOtherIncome, OtherIncomeError } from "@/lib/accounting/other-income";
import { toAmountString, sum } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate } from "./helpers/db";

async function otherIncomeAccountId(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const acc = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "4900" } }); // Other Income
  return acc.id;
}
async function cashAccountId(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const acc = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1110" } }); // Cash on Hand
  return acc.id;
}
async function linesWithCode(tx: Parameters<Parameters<typeof withRollback>[0]>[0], entryId: string) {
  return tx.journalLine.findMany({ where: { entryId }, include: { account: { select: { code: true } } } });
}

describe("createOtherIncome()", () => {
  it("creates a SUBMITTED entry with a numbered id", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Scrap Buyer",
        amount: "2500.00",
        method: "CASH",
        depositAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(income.status).toBe("SUBMITTED");
      expect(income.incomeNumber).toMatch(/^OIN\/\d{4}-\d{2}\/\d{4}$/);
      expect(toAmountString(income.amount)).toBe("2500.00");
    });
  });

  it("refuses a zero amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(
        createOtherIncome({
          incomeDate: new Date(), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
          amount: "0", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(OtherIncomeError);
    });
  });

  it("refuses a category account that isn't an INCOME type", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const arAccount = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1130" } }); // AR, an ASSET
      await expect(
        createOtherIncome({
          incomeDate: new Date(), categoryAccountId: arAccount.id, payerName: "X",
          amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(/not an income account/i);
    });
  });

  it("refuses a grouping income account", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const group = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "4000" } }); // Revenue, a group
      await expect(
        createOtherIncome({
          incomeDate: new Date(), categoryAccountId: group.id, payerName: "X",
          amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
        }, tx),
      ).rejects.toThrow(/grouping account/i);
    });
  });
});

describe("approveOtherIncome(): posts on approval", () => {
  it("posts a balanced entry: debit the deposit account, credit the category", async () => {
    await withRollback(async (tx) => {
      const submitter = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Scrap Buyer",
        amount: "2500.00",
        method: "CASH",
        depositAccountId: await cashAccountId(tx),
        createdById: submitter,
      }, tx);

      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: submitter },
        tx,
      );

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(income.status).toBe("APPROVED");
      expect(income.postedEntryId).toBe(journalEntryId);

      const lines = await linesWithCode(tx, journalEntryId);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      const cashLine = lines.find((l) => l.account.code === "1110");
      const categoryLine = lines.find((l) => l.account.code === "4900");
      expect(toAmountString(cashLine!.debit)).toBe("2500.00");
      expect(toAmountString(categoryLine!.credit)).toBe("2500.00");
    });
  });

  it("refuses to approve a non-SUBMITTED entry", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await approveOtherIncome({ otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId }, tx);
      await expect(
        approveOtherIncome({ otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId }, tx),
      ).rejects.toThrow(/only a submitted entry/i);
    });
  });

  it("blocks self-approval for a non-exempt role", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await expect(
        approveOtherIncome({ otherIncomeId, approverRole: "ACCOUNTS_TEAM", approvedById: userId }, tx),
      ).rejects.toThrow(/cannot approve an entry you submitted/i);
    });
  });

  it("allows the Super Admin exemption to self-approve", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      expect(journalEntryId).toBeTruthy();
    });
  });
});

describe("createOtherIncome() / approveOtherIncome(): itemised, GST as output tax only", () => {
  it("computes subtotal and total from line items with GST off", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Buyer",
        items: [
          { description: "Scrap metal", quantity: 2, unitPrice: 100 },
          { description: "Scrap plastic", quantity: 10, unitPrice: 5 },
        ],
        method: "CASH",
        depositAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId }, include: { items: true } });
      expect(income.items).toHaveLength(2);
      expect(toAmountString(income.subtotal)).toBe("250.00");
      expect(toAmountString(income.cgstAmount)).toBe("0.00");
      expect(toAmountString(income.amount)).toBe("250.00");
    });
  });

  it("GST on: output tax splits CGST/SGST and posts to GST_OUTPUT_*, never a claimable credit", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Buyer",
        items: [{ description: "Service", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
        isGstApplicable: true,
        method: "CASH",
        depositAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(toAmountString(income.subtotal)).toBe("1000.00");
      expect(toAmountString(income.amount)).toBe("1180.00");

      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const categoryLine = lines.find((l) => l.account.code === "4900");
      const cgstLine = lines.find((l) => l.account.code === "2131");
      const sgstLine = lines.find((l) => l.account.code === "2132");
      expect(toAmountString(categoryLine!.credit)).toBe("1000.00");
      expect(toAmountString(cgstLine!.credit)).toBe("90.00");
      expect(toAmountString(sgstLine!.credit)).toBe("90.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("rounding UP credits Round Off (mirror image of expenses.ts, which debits it)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Buyer",
        items: [{ description: "Goods", quantity: 1, unitPrice: 100.6 }], // rounds 100.60 -> 101
        method: "CASH",
        depositAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(toAmountString(income.roundOff)).toBe("0.40");
      expect(toAmountString(income.amount)).toBe("101.00");

      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      const roundOffLine = lines.find((l) => l.account.code === "4910");
      expect(toAmountString(roundOffLine!.credit)).toBe("0.40");
      expect(toAmountString(roundOffLine!.debit)).toBe("0.00");
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("a legacy flat-amount entry still posts exactly as expected (no items)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx),
        categoryAccountId: await otherIncomeAccountId(tx),
        payerName: "Bank",
        amount: "500",
        method: "BANK_TRANSFER",
        depositAccountId: await cashAccountId(tx),
        createdById: userId,
      }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId }, include: { items: true } });
      expect(income.items).toHaveLength(0);
      expect(income.isGstApplicable).toBe(false);
      expect(toAmountString(income.roundOff)).toBe("0.00");

      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );
      const lines = await linesWithCode(tx, journalEntryId);
      expect(lines).toHaveLength(2); // just deposit debit, category credit — no GST/round-off lines
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("500.00");
    });
  });

  it("rejects an item line with a zero quantity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(
        createOtherIncome({
          incomeDate: await openPeriodDate(tx),
          categoryAccountId: await otherIncomeAccountId(tx),
          payerName: "Buyer",
          items: [{ description: "Bad line", quantity: 0, unitPrice: 100 }],
          method: "CASH",
          depositAccountId: await cashAccountId(tx),
          createdById: userId,
        }, tx),
      ).rejects.toThrow(/quantity greater than zero/i);
    });
  });
});

describe("rejectOtherIncome()", () => {
  it("marks REJECTED with a reason and posts nothing", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await rejectOtherIncome({ otherIncomeId, reason: "Not a real sale", rejectedById: userId }, tx);
      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(income.status).toBe("REJECTED");
      expect(income.rejectedReason).toBe("Not a real sale");
      expect(income.postedEntryId).toBeNull();
    });
  });
});

describe("cancelOtherIncome()", () => {
  it("reverses an approved entry's posting", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      const { journalEntryId } = await approveOtherIncome(
        { otherIncomeId, approverRole: "SUPER_ADMIN", approvedById: userId },
        tx,
      );

      await cancelOtherIncome({ otherIncomeId, reason: "Duplicate entry", cancelledById: userId }, tx);

      const income = await tx.otherIncome.findUniqueOrThrow({ where: { id: otherIncomeId } });
      expect(income.status).toBe("CANCELLED");
      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId } });
      expect(entry.status).toBe("REVERSED");
    });
  });

  it("refuses to cancel an entry that was never approved", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { otherIncomeId } = await createOtherIncome({
        incomeDate: await openPeriodDate(tx), categoryAccountId: await otherIncomeAccountId(tx), payerName: "X",
        amount: "100", method: "CASH", depositAccountId: await cashAccountId(tx), createdById: userId,
      }, tx);
      await expect(
        cancelOtherIncome({ otherIncomeId, reason: "N/A", cancelledById: userId }, tx),
      ).rejects.toThrow(/only an approved entry/i);
    });
  });
});
