import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireAccount, loadAccountMap } from "./account-map";
import { createLedgerAccount, nextChildCode, setLedgerAccountActive } from "./ledger-accounts";
import { computeInstallmentSplit, LoanScheduleError } from "./loan-schedule";
import { gt, money, round, sum, toAmountString, type Money, type MoneyInput } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * The loan register: few, named, accountant-created liabilities, each with
 * its OWN LedgerAccount — the opposite end of the sub-ledger-vs-account axis
 * from fixed assets. See the Phase 9 plan for the full argument; the short
 * version is that a loan is a bank account with the sign flipped and should
 * be named on the balance sheet the same way a bank account is.
 *
 * `outstandingPrincipal` is deliberately never a stored column — it is
 * `principal` minus the sum of every non-cancelled repayment's
 * `principalPortion`, and it must equal the loan's own ledger account
 * balance to the paisa, the same rule every other derived balance in this
 * system follows.
 */

export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanError";
  }
}

export type CreateLoanInput = {
  lenderName: string;
  lenderReference?: string | null;
  disbursedToAccountId: string;
  principal: MoneyInput;
  annualRatePercent: MoneyInput;
  tenureMonths: number;
  startDate: Date;
  emiAmount: MoneyInput;
  notes?: string | null;
  createdById: string;
};

/**
 * Creates the loan's own liability account under 2220 Loan Accounts (never
 * 2210 — see the plan's note on why that account already carries a real
 * pre-Phase-9 balance and cannot be touched), then posts the disbursement:
 * Dr the account the money landed in, Cr the loan's own account.
 */
export async function createLoan(
  input: CreateLoanInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ loanId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ loanId: string }> => {
    const lenderName = input.lenderName.trim();
    if (!lenderName) throw new LoanError("A lender name is required.");

    const principal = round(input.principal);
    if (!gt(principal, 0)) throw new LoanError("Principal must be greater than zero.");
    const annualRatePercent = money(input.annualRatePercent);
    if (annualRatePercent.isNegative()) throw new LoanError("Interest rate cannot be negative.");
    if (!Number.isInteger(input.tenureMonths) || input.tenureMonths <= 0) {
      throw new LoanError("Tenure must be a positive whole number of instalments.");
    }
    const emiAmount = round(input.emiAmount);
    if (!gt(emiAmount, 0)) throw new LoanError("The instalment amount must be greater than zero.");

    // A quick sanity check, not a substitute for the per-instalment guard in
    // loan-schedule.ts: if the very first instalment wouldn't even cover the
    // first period's interest, the loan can never amortise regardless of how
    // many instalments follow.
    const firstMonthInterest = round(annualRatePercent.dividedBy(1200).times(principal));
    if (emiAmount.lessThanOrEqualTo(firstMonthInterest)) {
      throw new LoanError(
        `An instalment of ${toAmountString(emiAmount)} does not cover the first period's interest of ` +
          `${toAmountString(firstMonthInterest)} — this loan would never amortise.`,
      );
    }

    const loanGroupCode = "2220";
    const suggestedCode = await nextChildCode(loanGroupCode, tx);
    const { accountId: loanAccountId } = await createLedgerAccount(
      {
        code: suggestedCode,
        name: `Loan — ${lenderName}`,
        type: "LIABILITY",
        parentCode: loanGroupCode,
        description: "Created for the loan register. Do not post to this account directly — use the loan's own repayment flow.",
      },
      tx,
    );

    const loan = await tx.loan.create({
      data: {
        lenderName,
        lenderReference: input.lenderReference?.trim() || null,
        loanAccountId,
        disbursedToAccountId: input.disbursedToAccountId,
        principal,
        annualRatePercent,
        tenureMonths: input.tenureMonths,
        startDate: input.startDate,
        emiAmount,
        notes: input.notes?.trim() || null,
        createdById: input.createdById,
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.startDate,
        narration: `Loan disbursed — ${lenderName}`,
        sourceType: "LOAN",
        sourceId: loan.id,
        idempotencyKey: `LOAN:${loan.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountId: input.disbursedToAccountId, debit: principal },
          { accountId: loanAccountId, credit: principal },
        ],
      },
      tx,
    );

    await tx.loan.update({ where: { id: loan.id }, data: { disbursementEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "Loan",
        entityId: loan.id,
        newValue: { lenderName, principal: toAmountString(principal), loanAccountCode: suggestedCode },
      },
      tx,
    );

    return { loanId: loan.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** `principal - Σ principalPortion of every non-cancelled repayment`. Must equal the loan's own ledger account balance. */
export async function outstandingPrincipal(loanId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Money> {
  const loan = await db.loan.findUnique({ where: { id: loanId }, select: { principal: true } });
  if (!loan) throw new LoanError("That loan does not exist.");
  const repayments = await db.loanRepayment.findMany({
    where: { loanId, cancelledAt: null },
    select: { principalPortion: true },
  });
  return round(loan.principal.minus(sum(repayments.map((r) => r.principalPortion))));
}

export type RecordRepaymentInput = {
  loanId: string;
  installmentNumber: number;
  paidDate: Date;
  paidFromAccountId: string;
  createdById: string;
};

/**
 * Records one instalment, splits it via `computeInstallmentSplit()` against
 * the loan's current outstanding balance, and posts Dr loan account
 * (principal) + Dr Interest Expense (interest) / Cr the paying account
 * (total). Closes the loan when this instalment brings the balance to zero.
 */
export async function recordLoanRepayment(
  input: RecordRepaymentInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ repaymentId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ repaymentId: string }> => {
    const loan = await tx.loan.findUnique({ where: { id: input.loanId } });
    if (!loan) throw new LoanError("That loan does not exist.");
    if (loan.status !== "ACTIVE") throw new LoanError(`This loan is ${loan.status.toLowerCase()}, not active.`);

    // Enforced here, in the same transaction as the insert, rather than a DB
    // unique constraint — see LoanRepayment's own schema comment for why a
    // hard unique would permanently brick a cancelled instalment number.
    const existingActive = await tx.loanRepayment.findFirst({
      where: { loanId: input.loanId, installmentNumber: input.installmentNumber, cancelledAt: null },
    });
    if (existingActive) {
      throw new LoanError(`Instalment ${input.installmentNumber} already has a posted repayment.`);
    }

    const outstanding = await outstandingPrincipal(input.loanId, tx);

    let split;
    try {
      split = computeInstallmentSplit(outstanding, loan.annualRatePercent, loan.emiAmount);
    } catch (err) {
      if (err instanceof LoanScheduleError) throw new LoanError(err.message);
      throw err;
    }

    const repayment = await tx.loanRepayment.create({
      data: {
        loanId: input.loanId,
        installmentNumber: input.installmentNumber,
        paidDate: input.paidDate,
        totalPaid: split.totalPaid,
        principalPortion: split.principal,
        interestPortion: split.interest,
        paidFromAccountId: input.paidFromAccountId,
        createdById: input.createdById,
      },
    });

    const accountMap = await loadAccountMap(tx);
    const interestExpenseAccountId = requireAccount(accountMap, "INTEREST_EXPENSE");

    const lines = [
      { accountId: loan.loanAccountId, debit: split.principal },
      ...(gt(split.interest, 0) ? [{ accountId: interestExpenseAccountId, debit: split.interest }] : []),
      { accountId: input.paidFromAccountId, credit: split.totalPaid },
    ];

    const posted = await postJournalEntry(
      {
        entryDate: input.paidDate,
        narration: `Loan instalment ${input.installmentNumber} — ${loan.lenderName}`,
        sourceType: "LOAN_REPAYMENT",
        sourceId: repayment.id,
        idempotencyKey: `LOAN_REPAYMENT:${repayment.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.loanRepayment.update({ where: { id: repayment.id }, data: { postedEntryId: posted.entryId } });

    if (split.isFinal) {
      await tx.loan.update({ where: { id: loan.id }, data: { status: "CLOSED", closedAt: new Date() } });
    }

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "LoanRepayment",
        entityId: repayment.id,
        newValue: {
          installmentNumber: input.installmentNumber,
          principal: toAmountString(split.principal),
          interest: toAmountString(split.interest),
          isFinal: split.isFinal,
        },
      },
      tx,
    );

    return { repaymentId: repayment.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Reverses a repayment's posting and leaves its instalment number payable again — never deletes the row. */
export async function cancelLoanRepayment(
  input: { repaymentId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const repayment = await tx.loanRepayment.findUnique({ where: { id: input.repaymentId } });
    if (!repayment) throw new LoanError("That repayment does not exist.");
    if (repayment.cancelledAt) throw new LoanError("Already cancelled.");
    if (!repayment.postedEntryId) throw new LoanError("This repayment has no posting to reverse.");

    await reverseJournalEntry({ entryId: repayment.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.loanRepayment.update({ where: { id: repayment.id }, data: { cancelledAt: new Date() } });

    // If this repayment had closed the loan, cancelling it must reopen the
    // loan — otherwise a real outstanding balance would sit under a CLOSED
    // status forever.
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: repayment.loanId } });
    if (loan.status === "CLOSED") {
      await tx.loan.update({ where: { id: loan.id }, data: { status: "ACTIVE", closedAt: null } });
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "LoanRepayment",
        entityId: repayment.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Cancels a loan that was recorded in error — reverses the disbursement and
 * best-effort deactivates its now-empty account (a reversed disbursement
 * nets that account back to exactly zero, so `setLedgerAccountActive`'s own
 * balance guard passes). Refused once any repayment exists — unwind those
 * first, the same "corrections are reversals, applied in order" rule
 * everything else in this system follows.
 */
export async function cancelLoan(
  input: { loanId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const loan = await tx.loan.findUnique({ where: { id: input.loanId } });
    if (!loan) throw new LoanError("That loan does not exist.");
    if (loan.status === "CANCELLED") throw new LoanError("Already cancelled.");

    const repaymentCount = await tx.loanRepayment.count({ where: { loanId: loan.id, cancelledAt: null } });
    if (repaymentCount > 0) {
      throw new LoanError("This loan has repayments recorded against it — cancel those first.");
    }
    if (!loan.disbursementEntryId) throw new LoanError("This loan has no disbursement posting to reverse.");

    await reverseJournalEntry({ entryId: loan.disbursementEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.loan.update({ where: { id: loan.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });

    try {
      await setLedgerAccountActive({ accountId: loan.loanAccountId, isActive: false, userId: input.cancelledById }, tx);
    } catch {
      // Non-fatal — a stray active, zero-balance loan account left behind is
      // cosmetic and does not affect any balance or report.
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "Loan",
        entityId: loan.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
