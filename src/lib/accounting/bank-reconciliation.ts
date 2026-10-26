import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { randomUUID } from "crypto";
import { logAudit } from "@/lib/audit";
import { createCashBankTransaction } from "./cash-bank";
import { add, gt, isZero, money, round, sub, sum, type Money, type MoneyInput } from "./money";

/**
 * Bank reconciliation (docs/VYAPAR_PARITY_SPEC.md §4) — Urvar's own design,
 * not Vyapar parity. REA found no reconcile UI on the licensed test
 * company, only decoded online-bank-linking constants with nothing to
 * observe at runtime, so there is no oracle to match here.
 *
 * The design: upload a bank statement, map its columns once per bank
 * (stored on `BankAccount.statementColumnMap`), auto-match statement lines
 * to already-posted `JournalLine`s on that bank's ledger by amount + a date
 * window, confirm the rest by hand, and let an unmatched statement line
 * (a bank charge, interest) become a `CashBankTransaction` in one click.
 *
 * This module never posts a journal entry itself — `createCashBankTransaction`
 * does that. Reconciliation only links rows that already happened.
 */

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

/** A statement date either side of a journal entry's date still counts as a plausible match — bank-processing lag, not a different transaction. */
const MATCH_WINDOW_DAYS = 5;

export type StatementRow = {
  txnDate: Date;
  description: string;
  reference?: string | null;
  /** Money out of the account, per the statement. Exactly one of withdrawal/deposit should be non-zero. */
  withdrawal: MoneyInput;
  deposit: MoneyInput;
};

export type ImportResult = { importBatch: string; imported: number; autoMatched: number };

async function assertBankAccount(db: Db, bankAccountId: string) {
  const bank = await db.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!bank) throw new ReconciliationError("That bank account does not exist.");
  return bank;
}

/**
 * Import a batch of already-parsed statement rows and auto-match what can be
 * matched with confidence. Rows failing basic sanity (zero amount, both
 * sides set) are skipped rather than rejecting the whole file — one bad row
 * in a 200-line statement shouldn't block the other 199.
 */
export async function importBankStatement(
  input: { bankAccountId: string; rows: StatementRow[]; createdById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<ImportResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<ImportResult> => {
    await assertBankAccount(tx, input.bankAccountId);
    const importBatch = randomUUID();

    const clean = input.rows
      .map((r) => ({ ...r, withdrawal: round(r.withdrawal), deposit: round(r.deposit) }))
      .filter((r) => !isZero(r.withdrawal) !== !isZero(r.deposit)); // exactly one side non-zero

    if (clean.length === 0) {
      throw new ReconciliationError("No usable rows — every row was either blank or had both withdrawal and deposit set.");
    }

    await tx.bankStatementLine.createMany({
      data: clean.map((r) => ({
        bankAccountId: input.bankAccountId,
        importBatch,
        txnDate: r.txnDate,
        description: r.description.trim() || "(no description)",
        reference: r.reference?.trim() || null,
        withdrawal: r.withdrawal,
        deposit: r.deposit,
        createdById: input.createdById,
      })),
    });

    const { matched } = await autoMatchBankAccount({ bankAccountId: input.bankAccountId, matchedById: input.createdById }, tx);

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "BankStatementImport",
        entityId: importBatch,
        newValue: { bankAccountId: input.bankAccountId, rows: clean.length, autoMatched: matched },
      },
      tx,
    );

    return { importBatch, imported: clean.length, autoMatched: matched };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Run (or re-run) auto-matching for every UNMATCHED line on one bank.
 * Deterministic single pass: a journal line is consumed by at most one
 * statement line within the run, tracked in-memory, then persisted — the
 * DB's own unique constraint on `matchedJournalLineId` is the backstop, not
 * the primary mechanism, since a single pass never double-claims.
 */
export async function autoMatchBankAccount(
  input: { bankAccountId: string; matchedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<{ matched: number }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ matched: number }> => {
    const bank = await assertBankAccount(tx, input.bankAccountId);

    const [unmatchedLines, candidateJournalLines] = await Promise.all([
      tx.bankStatementLine.findMany({ where: { bankAccountId: input.bankAccountId, status: "UNMATCHED" } }),
      tx.journalLine.findMany({
        where: {
          accountId: bank.ledgerAccountId,
          entry: { status: "POSTED" },
          matchedByStatementLine: null,
        },
        select: { id: true, debit: true, credit: true, entry: { select: { entryDate: true } } },
      }),
    ]);

    const consumed = new Set<string>();
    let matched = 0;

    for (const line of unmatchedLines) {
      const isDeposit = gt(line.deposit, 0);
      const amount = isDeposit ? line.deposit : line.withdrawal;

      let best: { id: string; diffDays: number } | null = null;
      for (const jl of candidateJournalLines) {
        if (consumed.has(jl.id)) continue;
        const side = isDeposit ? jl.debit : jl.credit;
        if (!money(side).equals(money(amount))) continue;
        const diffMs = Math.abs(jl.entry.entryDate.getTime() - line.txnDate.getTime());
        const diffDays = diffMs / 86_400_000;
        if (diffDays > MATCH_WINDOW_DAYS) continue;
        if (!best || diffDays < best.diffDays) best = { id: jl.id, diffDays };
      }

      if (best) {
        consumed.add(best.id);
        await tx.bankStatementLine.update({
          where: { id: line.id },
          data: { status: "MATCHED", matchedJournalLineId: best.id, matchedAt: new Date(), matchedById: input.matchedById },
        });
        matched++;
      }
    }

    return { matched };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Manually confirm a match the auto-matcher missed or got wrong. */
export async function matchStatementLine(
  input: { statementLineId: string; journalLineId: string; matchedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: input.statementLineId } });
    if (!line) throw new ReconciliationError("That statement line does not exist.");
    if (line.status === "MATCHED") throw new ReconciliationError("This statement line is already matched.");

    const journalLine = await tx.journalLine.findUnique({ where: { id: input.journalLineId } });
    if (!journalLine) throw new ReconciliationError("That journal line does not exist.");

    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: line.bankAccountId } });
    if (journalLine.accountId !== bank.ledgerAccountId) {
      throw new ReconciliationError("That journal line is not on this bank's ledger account.");
    }

    try {
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: "MATCHED", matchedJournalLineId: journalLine.id, matchedAt: new Date(), matchedById: input.matchedById },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ReconciliationError("That journal line is already matched to another statement line.");
      }
      throw err;
    }

    await logAudit(
      {
        userId: input.matchedById,
        action: "UPDATE",
        entityType: "BankStatementLine",
        entityId: line.id,
        oldValue: { status: "UNMATCHED" },
        newValue: { status: "MATCHED", journalLineId: journalLine.id },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Undo a match — the line goes back to the unmatched pool on both sides. */
export async function unmatchStatementLine(
  input: { statementLineId: string; unmatchedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: input.statementLineId } });
    if (!line) throw new ReconciliationError("That statement line does not exist.");
    if (line.status !== "MATCHED") throw new ReconciliationError("This statement line is not matched.");

    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "UNMATCHED", matchedJournalLineId: null, matchedAt: null, matchedById: null },
    });

    await logAudit(
      { userId: input.unmatchedById, action: "UPDATE", entityType: "BankStatementLine", entityId: line.id, oldValue: { status: "MATCHED" }, newValue: { status: "UNMATCHED" } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Mark a statement line as reviewed-and-excluded (a duplicate row, a bank error) without matching it to anything. */
export async function ignoreStatementLine(
  input: { statementLineId: string; ignoredById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: input.statementLineId } });
    if (!line) throw new ReconciliationError("That statement line does not exist.");
    if (line.status !== "UNMATCHED") throw new ReconciliationError("Only an unmatched line can be ignored.");

    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: "IGNORED" } });
    await logAudit(
      { userId: input.ignoredById, action: "UPDATE", entityType: "BankStatementLine", entityId: line.id, oldValue: { status: "UNMATCHED" }, newValue: { status: "IGNORED" } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Bring an ignored line back into the unmatched pool. */
export async function restoreStatementLine(
  input: { statementLineId: string; restoredById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: input.statementLineId } });
    if (!line) throw new ReconciliationError("That statement line does not exist.");
    if (line.status !== "IGNORED") throw new ReconciliationError("Only an ignored line can be restored.");

    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: "UNMATCHED" } });
    await logAudit(
      { userId: input.restoredById, action: "UPDATE", entityType: "BankStatementLine", entityId: line.id, oldValue: { status: "IGNORED" }, newValue: { status: "UNMATCHED" } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Delete every still-unmatched/ignored line of one import batch — the undo
 * path for a bad upload (wrong file, wrong column mapping). Refuses if any
 * row in the batch has already been matched: unmatch it first, so a
 * statement line never disappears while still linked to a journal line.
 */
export async function deleteStatementImport(
  input: { bankAccountId: string; importBatch: string; deletedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<{ deleted: number }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ deleted: number }> => {
    const lines = await tx.bankStatementLine.findMany({ where: { bankAccountId: input.bankAccountId, importBatch: input.importBatch } });
    if (lines.length === 0) throw new ReconciliationError("That import batch does not exist.");
    if (lines.some((l) => l.status === "MATCHED")) {
      throw new ReconciliationError("This import has matched lines — unmatch them before deleting the import.");
    }

    const result = await tx.bankStatementLine.deleteMany({ where: { bankAccountId: input.bankAccountId, importBatch: input.importBatch } });
    await logAudit(
      { userId: input.deletedById, action: "DELETE", entityType: "BankStatementImport", entityId: input.importBatch, oldValue: { rows: lines.length } },
      tx,
    );
    return { deleted: result.count };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Save (or update) the column mapping for a bank, so the next import skips the mapping step. */
export async function saveStatementColumnMap(
  input: { bankAccountId: string; columnMap: Record<string, string>; savedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    await assertBankAccount(tx, input.bankAccountId);
    await tx.bankAccount.update({ where: { id: input.bankAccountId }, data: { statementColumnMap: input.columnMap } });
    await logAudit(
      { userId: input.savedById, action: "UPDATE", entityType: "BankAccount", entityId: input.bankAccountId, newValue: { statementColumnMap: input.columnMap } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Turn an unmatched statement line into a `CashBankTransaction` (a bank
 * charge or interest the books don't have yet), then match the two —
 * "unmatched statement lines can create a CashBankTransaction in one click."
 */
export async function createTransactionFromStatementLine(
  input:
    | { statementLineId: string; type: "BANK_CHARGE"; expenseAccountId: string; createdById: string }
    | { statementLineId: string; type: "INTEREST_INCOME"; incomeAccountId: string; createdById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<{ transactionId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ transactionId: string }> => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: input.statementLineId } });
    if (!line) throw new ReconciliationError("That statement line does not exist.");
    if (line.status !== "UNMATCHED") throw new ReconciliationError("This statement line is not unmatched.");
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: line.bankAccountId } });

    const isCharge = input.type === "BANK_CHARGE";
    if (isCharge && !gt(line.withdrawal, 0)) {
      throw new ReconciliationError("A bank charge must come from a withdrawal line.");
    }
    if (!isCharge && !gt(line.deposit, 0)) {
      throw new ReconciliationError("Interest income must come from a deposit line.");
    }
    const amount = isCharge ? line.withdrawal : line.deposit;

    const result = await createCashBankTransaction(
      isCharge
        ? { type: "BANK_CHARGE", txnDate: line.txnDate, amount, bankAccountId: bank.ledgerAccountId, expenseAccountId: input.expenseAccountId, reference: line.reference, notes: line.description, createdById: input.createdById }
        : { type: "INTEREST_INCOME", txnDate: line.txnDate, amount, bankAccountId: bank.ledgerAccountId, incomeAccountId: input.incomeAccountId, reference: line.reference, notes: line.description, createdById: input.createdById },
      tx,
    );

    const txn = await tx.cashBankTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });
    const journalLineId = (
      await tx.journalLine.findFirstOrThrow({ where: { entryId: txn.postedEntryId!, accountId: bank.ledgerAccountId } })
    ).id;

    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "MATCHED", matchedJournalLineId: journalLineId, matchedAt: new Date(), matchedById: input.createdById },
    });

    return result;
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type ReconciliationSummary = {
  bookBalance: Money;
  statementOnlyDeposits: Money;
  statementOnlyWithdrawals: Money;
  bookOnlyDeposits: Money;
  bookOnlyWithdrawals: Money;
  /** Book balance brought up to date with statement-only items the books don't have yet (bank charges, interest). Should settle to the book balance itself once every unmatched statement line is actioned. */
  adjustedBookBalance: Money;
  /** The statement's own closing figure (user-entered, not stored) adjusted for items the bank hasn't processed yet (deposits in transit, outstanding cheques). Equal to adjustedBookBalance once reconciled. */
  adjustedStatementBalance: Money | null;
  unmatchedStatementLines: number;
  unmatchedJournalLines: number;
};

/**
 * Book balance vs. statement balance as of a date, with both sides'
 * unmatched items — the standard reconciliation-statement shape. Passing
 * `statementClosingBalance` (read off the paper/PDF statement) also computes
 * the adjusted statement-side figure; omit it to see only the book-side
 * adjustment.
 */
export async function reconciliationSummary(
  input: { bankAccountId: string; asOfDate: Date; statementClosingBalance?: MoneyInput },
  db: Db = prisma,
): Promise<ReconciliationSummary> {
  const bank = await db.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!bank) throw new ReconciliationError("That bank account does not exist.");

  const [bookLines, statementOnly, bookOnly] = await Promise.all([
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { accountId: bank.ledgerAccountId, entry: { status: "POSTED", entryDate: { lte: input.asOfDate } } },
      _sum: { debit: true, credit: true },
    }),
    db.bankStatementLine.findMany({
      where: { bankAccountId: input.bankAccountId, status: "UNMATCHED", txnDate: { lte: input.asOfDate } },
      select: { withdrawal: true, deposit: true },
    }),
    db.journalLine.findMany({
      where: {
        accountId: bank.ledgerAccountId,
        entry: { status: "POSTED", entryDate: { lte: input.asOfDate } },
        matchedByStatementLine: null,
      },
      select: { debit: true, credit: true },
    }),
  ]);

  const bookBalance = bookLines.length ? sub(bookLines[0]._sum.debit, bookLines[0]._sum.credit) : money(0);
  const statementOnlyDeposits = sum(statementOnly.map((l) => l.deposit));
  const statementOnlyWithdrawals = sum(statementOnly.map((l) => l.withdrawal));
  const bookOnlyDeposits = sum(bookOnly.map((l) => l.debit));
  const bookOnlyWithdrawals = sum(bookOnly.map((l) => l.credit));

  const adjustedBookBalance = sub(add(bookBalance, statementOnlyDeposits), statementOnlyWithdrawals);
  const adjustedStatementBalance =
    input.statementClosingBalance === undefined
      ? null
      : add(sub(money(input.statementClosingBalance), bookOnlyDeposits), bookOnlyWithdrawals);

  return {
    bookBalance,
    statementOnlyDeposits,
    statementOnlyWithdrawals,
    bookOnlyDeposits,
    bookOnlyWithdrawals,
    adjustedBookBalance,
    adjustedStatementBalance,
    unmatchedStatementLines: statementOnly.length,
    unmatchedJournalLines: bookOnly.length,
  };
}
