import { describe, it, expect } from "vitest";
import { createLoan, recordLoanRepayment, cancelLoanRepayment, cancelLoan, outstandingPrincipal, LoanError } from "@/lib/accounting/loans";
import { suggestEmi } from "@/lib/accounting/loan-schedule";
import { toAmountString, sum } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

describe("createLoan()", () => {
  it("creates the loan's own account under 2220 and posts a balanced disbursement", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");

      const { loanId } = await createLoan(
        {
          lenderName: "Test Bank", disbursedToAccountId: bank,
          principal: "100000", annualRatePercent: "12", tenureMonths: 12,
          startDate: date, emiAmount: "9000", createdById: userId,
        },
        tx,
      );

      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId }, include: { loanAccount: true } });
      expect(loan.status).toBe("ACTIVE");
      expect(loan.loanAccount.code).toMatch(/^2221|222\d$/);
      expect(loan.loanAccount.isPostable).toBe(true);
      expect(loan.loanAccount.parentId).not.toBeNull();

      const lines = await tx.journalLine.findMany({ where: { entryId: loan.disbursementEntryId! } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("100000.00");
      expect(toAmountString(sum(lines.map((l) => l.credit)))).toBe("100000.00");
    });
  });

  it("refuses an EMI that would never amortise", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      await expect(
        createLoan(
          { lenderName: "Bad Loan", disbursedToAccountId: bank, principal: "100000", annualRatePercent: "12",
            tenureMonths: 12, startDate: date, emiAmount: "500", createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/never amortise/i);
    });
  });
});

describe("recordLoanRepayment()", () => {
  it("running every instalment closes the loan's own ledger account to exactly 0.00", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const principal = "60000";
      const rate = "9.5";
      const tenure = 6;
      const emi = suggestEmi(principal, rate, tenure);

      const { loanId } = await createLoan(
        { lenderName: "Amort Test Bank", disbursedToAccountId: bank, principal, annualRatePercent: rate,
          tenureMonths: tenure, startDate: date, emiAmount: emi, createdById: userId },
        tx,
      );

      let isFinal = false;
      for (let i = 1; i <= 10 && !isFinal; i++) {
        const result = await recordLoanRepayment(
          { loanId, installmentNumber: i, paidDate: date, paidFromAccountId: bank, createdById: userId },
          tx,
        );
        const repayment = await tx.loanRepayment.findUniqueOrThrow({ where: { id: result.repaymentId } });
        const lines = await tx.journalLine.findMany({ where: { entryId: repayment.postedEntryId! } });
        expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
        isFinal = (await tx.loan.findUniqueOrThrow({ where: { id: loanId } })).status === "CLOSED";
      }

      expect(isFinal).toBe(true);
      const finalOutstanding = await outstandingPrincipal(loanId, tx);
      expect(toAmountString(finalOutstanding)).toBe("0.00");

      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      const ledgerBalance = await tx.journalLine.aggregate({
        where: { accountId: loan.loanAccountId }, _sum: { debit: true, credit: true },
      });
      // Loan account is LIABILITY (credit-normal): balance = credit - debit.
      const netCredit = (ledgerBalance._sum.credit ?? 0).toString();
      const netDebit = (ledgerBalance._sum.debit ?? 0).toString();
      expect(netCredit).toBe(netDebit); // fully closed — credits (disbursement) exactly offset by debits (principal repaid)
    });
  });

  it("refuses a second repayment for an instalment number already posted", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Dup Test", disbursedToAccountId: bank, principal: "50000", annualRatePercent: "10",
          tenureMonths: 12, startDate: date, emiAmount: "5000", createdById: userId },
        tx,
      );
      await recordLoanRepayment({ loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx);
      await expect(
        recordLoanRepayment({ loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx),
      ).rejects.toThrow(/already has a posted repayment/i);
    });
  });

  it("cancelling a repayment reverses it and leaves the instalment payable again — no DB unique to brick it", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Cancel Test", disbursedToAccountId: bank, principal: "50000", annualRatePercent: "10",
          tenureMonths: 12, startDate: date, emiAmount: "5000", createdById: userId },
        tx,
      );
      const { repaymentId } = await recordLoanRepayment(
        { loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx,
      );
      await cancelLoanRepayment({ repaymentId, reason: "wrong amount entered", cancelledById: userId }, tx);

      const outstanding = await outstandingPrincipal(loanId, tx);
      expect(toAmountString(outstanding)).toBe("50000.00"); // back to full principal

      // Re-paying the SAME instalment number must now succeed.
      const retry = await recordLoanRepayment(
        { loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx,
      );
      expect(retry.repaymentId).toBeTruthy();
    });
  });

  it("cancelling the repayment that closed a loan reopens it", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Reopen Test", disbursedToAccountId: bank, principal: "1000", annualRatePercent: "0",
          tenureMonths: 1, startDate: date, emiAmount: "1000", createdById: userId },
        tx,
      );
      const { repaymentId } = await recordLoanRepayment(
        { loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx,
      );
      expect((await tx.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("CLOSED");

      await cancelLoanRepayment({ repaymentId, reason: "test", cancelledById: userId }, tx);
      expect((await tx.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("ACTIVE");
    });
  });
});

describe("cancelLoan()", () => {
  it("reverses the disbursement when no repayment exists yet", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Mistake Loan", disbursedToAccountId: bank, principal: "10000", annualRatePercent: "10",
          tenureMonths: 12, startDate: date, emiAmount: "1000", createdById: userId },
        tx,
      );
      await cancelLoan({ loanId, reason: "entered by mistake", cancelledById: userId }, tx);
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      expect(loan.status).toBe("CANCELLED");
    });
  });

  it("refuses to cancel a loan with repayments already recorded", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const { loanId } = await createLoan(
        { lenderName: "Has Repayment", disbursedToAccountId: bank, principal: "10000", annualRatePercent: "10",
          tenureMonths: 12, startDate: date, emiAmount: "1000", createdById: userId },
        tx,
      );
      await recordLoanRepayment({ loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: bank, createdById: userId }, tx);
      await expect(cancelLoan({ loanId, reason: "test", cancelledById: userId }, tx)).rejects.toThrow(LoanError);
    });
  });
});
