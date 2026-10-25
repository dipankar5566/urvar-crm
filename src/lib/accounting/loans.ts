import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireAccount, loadAccountMap } from "./account-map";
import { createLedgerAccount, nextChildCode, setLedgerAccountActive } from "./ledger-accounts";
import { computeInstallmentSplit, LoanScheduleError } from "./loan-schedule";
import { add, gt, money, round, sub, sum, toAmountString, type Money, type MoneyInput } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * The loan register: few, named, accountant-created liabilities, each with
 * its OWN LedgerAccount — the opposite end of the sub-ledger-vs-account axis
 * from fixed assets. See the Phase 9 plan for the full argument; the short
 * version is that a loan is a bank account with the sign flipped and should
 * be named on the balance sheet the same way a bank account is.
 *
 * `outstandingPrincipal` is deliberately never a stored column — it is
 * `principal` plus every non-cancelled `TOP_UP` minus the sum of every
 * non-cancelled repayment's `principalPortion`, and it must equal the loan's
 * own ledger account balance to the paisa, the same rule every other derived
 * balance in this system follows.
 *
 * `LoanTransaction` (VYAPAR_PARITY_SPEC.md §2.4, G7) holds everything that
 * isn't the disbursement or an EMI: `recordLoanFee` (a processing fee or an
 * ad-hoc charge, paid from cash/bank, never touching the loan balance) and
 * `recordLoanTopUp` (the opposite direction — increases the balance exactly
 * like the disbursement).
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
  const [repayments, topUps] = await Promise.all([
    db.loanRepayment.findMany({ where: { loanId, cancelledAt: null }, select: { principalPortion: true } }),
    // A TOP_UP (loans.ts step 3) increases the balance exactly like the
    // original disbursement — omitted here, this function would drift from
    // the loan account's real ledger balance the moment a top-up is posted.
    db.loanTransaction.findMany({ where: { loanId, type: "TOP_UP", cancelledAt: null }, select: { amount: true } }),
  ]);
  const principalWithTopUps = loan.principal.plus(sum(topUps.map((t) => t.amount)));
  return round(principalWithTopUps.minus(sum(repayments.map((r) => r.principalPortion))));
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

// ------------------------------------------------------------ R9 Loan Statement

export type LoanStatementRow = {
  date: Date;
  type: "Disbursement" | "Top-up" | "Processing Fee" | "Charges" | "EMI Paid";
  amount: Money;
  endingBalance: Money;
};
export type LoanStatementResult = {
  loanId: string;
  lenderName: string;
  openingBalance: Money;
  rows: LoanStatementRow[];
  balanceDue: Money;
  totalPrincipalPaid: Money;
  totalInterestPaid: Money;
};

/**
 * Every event against one loan, with a running balance — Vyapar's "Loan
 * Statement" (VYAPAR_PARITY_SPEC.md R9), confirmed against
 * `vyapar/rea-test-reports/Loan Statement Report_*.xlsx`: a fee/charge row
 * shows its amount but leaves Ending Balance unchanged; a disbursement or
 * top-up increases it; an EMI reduces it by the instalment's principal
 * portion only (the interest portion never touched the balance). "Total
 * Principal/Interest Paid" are summed over instalments *within* the range,
 * matching every other ranged report here — not a lifetime total.
 */
export async function loanStatement(
  loanId: string,
  fromDate: Date,
  toDate: Date,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<LoanStatementResult> {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } });
  const [repayments, transactions] = await Promise.all([
    db.loanRepayment.findMany({ where: { loanId, cancelledAt: null }, orderBy: { paidDate: "asc" } }),
    db.loanTransaction.findMany({ where: { loanId, cancelledAt: null }, orderBy: { txnDate: "asc" } }),
  ]);

  type Event = { date: Date; type: LoanStatementRow["type"]; amount: Money; balanceDelta: Money };
  const loanTxnRowType = (t: "PROCESSING_FEE" | "CHARGES" | "TOP_UP"): LoanStatementRow["type"] =>
    t === "TOP_UP" ? "Top-up" : t === "PROCESSING_FEE" ? "Processing Fee" : "Charges";

  const disbursementEvent: Event = {
    date: loan.startDate,
    type: "Disbursement",
    amount: money(loan.principal),
    balanceDelta: money(loan.principal),
  };
  const transactionEvents: Event[] = transactions.map((t) => ({
    date: t.txnDate,
    type: loanTxnRowType(t.type),
    amount: t.amount,
    balanceDelta: t.type === "TOP_UP" ? t.amount : money(0),
  }));
  const repaymentEvents: Event[] = repayments.map((r) => ({
    date: r.paidDate,
    type: "EMI Paid",
    amount: r.totalPaid,
    balanceDelta: r.principalPortion.negated(),
  }));
  const events: Event[] = [disbursementEvent, ...transactionEvents, ...repaymentEvents].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  let running = money(0);
  let openingBalance = money(0);
  const rows: LoanStatementRow[] = [];
  for (const e of events) {
    if (e.date < fromDate) {
      running = add(running, e.balanceDelta);
      openingBalance = running;
      continue;
    }
    if (e.date > toDate) break; // sorted ascending — nothing further applies within range
    running = add(running, e.balanceDelta);
    rows.push({ date: e.date, type: e.type, amount: e.amount, endingBalance: running });
  }

  const inRange = repayments.filter((r) => r.paidDate >= fromDate && r.paidDate <= toDate);
  return {
    loanId,
    lenderName: loan.lenderName,
    openingBalance,
    rows,
    balanceDue: await outstandingPrincipal(loanId, db),
    totalPrincipalPaid: sum(inRange.map((r) => r.principalPortion)),
    totalInterestPaid: sum(inRange.map((r) => r.interestPortion)),
  };
}

// ------------------------------------------------------------ R10 Loan Account Summary

export type LoanAccountSummaryRow = {
  loanId: string;
  lenderName: string;
  status: string;
  openingPrincipal: Money;
  principalPaid: Money;
  interestPaid: Money;
  balance: Money;
};

/** One row per loan, as of a date — Vyapar's "Loan Account Summary" (R10). No single oracle export exists for this one; it reuses `outstandingPrincipal`'s own arithmetic, scoped to `asOfDate` instead of "now". */
export async function loanAccountSummary(asOfDate: Date, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<LoanAccountSummaryRow[]> {
  const loans = await db.loan.findMany({
    where: { startDate: { lte: asOfDate } },
    select: {
      id: true,
      lenderName: true,
      principal: true,
      status: true,
      repayments: { where: { cancelledAt: null, paidDate: { lte: asOfDate } }, select: { principalPortion: true, interestPortion: true } },
      transactions: { where: { cancelledAt: null, type: "TOP_UP", txnDate: { lte: asOfDate } }, select: { amount: true } },
    },
    orderBy: { startDate: "asc" },
  });

  return loans.map((l) => {
    const principalPaid = sum(l.repayments.map((r) => r.principalPortion));
    const interestPaid = sum(l.repayments.map((r) => r.interestPortion));
    const openingPrincipal = add(money(l.principal), sum(l.transactions.map((t) => t.amount)));
    return {
      loanId: l.id,
      lenderName: l.lenderName,
      status: l.status,
      openingPrincipal,
      principalPaid,
      interestPaid,
      balance: sub(openingPrincipal, principalPaid),
    };
  });
}

export type RecordLoanFeeInput = {
  loanId: string;
  /** PROCESSING_FEE or CHARGES only — TOP_UP has its own function below (opposite posting direction). */
  type: "PROCESSING_FEE" | "CHARGES";
  txnDate: Date;
  amount: MoneyInput;
  /** Cash/bank account the fee or charge was paid from. */
  paymentAccountId: string;
  notes?: string | null;
  createdById: string;
};

/**
 * A one-off processing fee or an ad-hoc charge (VYAPAR_PARITY_SPEC.md §2.4,
 * G7) — Dr the matching expense account (LOAN_PROCESSING_FEE / LOAN_CHARGES),
 * Cr the paying account. Never touches the loan's own balance: a charge paid
 * from cash/bank is an expense of the period it was paid in, not debt (D6's
 * default — "added to the loan balance" is the unimplemented alternative).
 */
export async function recordLoanFee(
  input: RecordLoanFeeInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ loanTransactionId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ loanTransactionId: string }> => {
    const loan = await tx.loan.findUnique({ where: { id: input.loanId } });
    if (!loan) throw new LoanError("That loan does not exist.");
    if (loan.status === "CANCELLED") throw new LoanError("This loan has been cancelled.");

    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new LoanError("Amount must be greater than zero.");

    const txn = await tx.loanTransaction.create({
      data: {
        loanId: input.loanId,
        type: input.type,
        txnDate: input.txnDate,
        amount,
        accountId: input.paymentAccountId,
        notes: input.notes?.trim() || null,
        createdById: input.createdById,
      },
    });

    const accountMap = await loadAccountMap(tx);
    const expenseAccountId = requireAccount(accountMap, input.type === "PROCESSING_FEE" ? "LOAN_PROCESSING_FEE" : "LOAN_CHARGES");
    const label = input.type === "PROCESSING_FEE" ? "Processing fee" : "Charges";

    const posted = await postJournalEntry(
      {
        entryDate: input.txnDate,
        narration: `${label} — ${loan.lenderName}`,
        sourceType: "LOAN_TRANSACTION",
        sourceId: txn.id,
        idempotencyKey: `LOAN_TRANSACTION:${txn.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountId: expenseAccountId, debit: amount },
          { accountId: input.paymentAccountId, credit: amount },
        ],
      },
      tx,
    );

    await tx.loanTransaction.update({ where: { id: txn.id }, data: { postedEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "LoanTransaction",
        entityId: txn.id,
        newValue: { loanId: input.loanId, type: input.type, amount: toAmountString(amount) },
      },
      tx,
    );

    return { loanTransactionId: txn.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type RecordLoanTopUpInput = {
  loanId: string;
  txnDate: Date;
  amount: MoneyInput;
  /** Where the top-up landed — same shape as the original disbursement. */
  receivingAccountId: string;
  notes?: string | null;
  createdById: string;
};

/**
 * Increases the outstanding principal — Dr the receiving account, Cr the
 * loan's own account, the same shape as `createLoan`'s disbursement. Only a
 * still-ACTIVE loan can be topped up; `outstandingPrincipal` picks this up
 * automatically (it sums every non-cancelled TOP_UP into the balance).
 */
export async function recordLoanTopUp(
  input: RecordLoanTopUpInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ loanTransactionId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ loanTransactionId: string }> => {
    const loan = await tx.loan.findUnique({ where: { id: input.loanId } });
    if (!loan) throw new LoanError("That loan does not exist.");
    if (loan.status !== "ACTIVE") throw new LoanError(`This loan is ${loan.status.toLowerCase()}, not active.`);

    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new LoanError("Amount must be greater than zero.");

    const txn = await tx.loanTransaction.create({
      data: {
        loanId: input.loanId,
        type: "TOP_UP",
        txnDate: input.txnDate,
        amount,
        accountId: input.receivingAccountId,
        notes: input.notes?.trim() || null,
        createdById: input.createdById,
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.txnDate,
        narration: `Top-up — ${loan.lenderName}`,
        sourceType: "LOAN_TRANSACTION",
        sourceId: txn.id,
        idempotencyKey: `LOAN_TRANSACTION:${txn.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountId: input.receivingAccountId, debit: amount },
          { accountId: loan.loanAccountId, credit: amount },
        ],
      },
      tx,
    );

    await tx.loanTransaction.update({ where: { id: txn.id }, data: { postedEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "LoanTransaction",
        entityId: txn.id,
        newValue: { loanId: input.loanId, type: "TOP_UP", amount: toAmountString(amount) },
      },
      tx,
    );

    return { loanTransactionId: txn.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Reverses a fee/charge/top-up's posting — never deletes the row, mirroring `cancelLoanRepayment`. */
export async function cancelLoanTransaction(
  input: { loanTransactionId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const txn = await tx.loanTransaction.findUnique({ where: { id: input.loanTransactionId } });
    if (!txn) throw new LoanError("That loan transaction does not exist.");
    if (txn.cancelledAt) throw new LoanError("Already cancelled.");
    if (!txn.postedEntryId) throw new LoanError("This has no posting to reverse.");

    await reverseJournalEntry({ entryId: txn.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.loanTransaction.update({ where: { id: txn.id }, data: { cancelledAt: new Date() } });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "LoanTransaction",
        entityId: txn.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
