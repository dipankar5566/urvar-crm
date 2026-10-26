import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createBankAccount } from "@/lib/accounting/bank-accounts";
import { createCashBankTransaction } from "@/lib/accounting/cash-bank";
import {
  importBankStatement,
  matchStatementLine,
  unmatchStatementLine,
  ignoreStatementLine,
  restoreStatementLine,
  deleteStatementImport,
  createTransactionFromStatementLine,
  reconciliationSummary,
  ReconciliationError,
} from "@/lib/accounting/bank-reconciliation";
import { toAmountString } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

/**
 * Vyapar parity step 7 (docs/VYAPAR_PARITY_SPEC.md §4) — Urvar's own
 * design, not a Vyapar oracle match (there is nothing to match against; the
 * licensed reconcile UI was never exercised in REA's runtime rounds).
 *
 * Every test creates its own brand-new bank ledger (no `existingLedgerAccountId`)
 * rather than reusing the shared seeded 1121/1122 — a fresh account can have
 * no history, so balance assertions never depend on what else is in the dev DB.
 */

async function freshBank(tx: Prisma.TransactionClient, userId: string, name: string) {
  const { bankAccountId, ledgerAccountId } = await createBankAccount({ displayName: name, createdById: userId }, tx);
  return { bankAccountId, ledgerAccountId };
}

describe("importBankStatement() + auto-matching", () => {
  it("matches a deposit line to the existing journal line on the same bank, same amount, within the date window", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await freshBank(tx, userId, "Test HDFC");

      await createCashBankTransaction(
        { type: "DEPOSIT", bankAccountId: ledgerAccountId, amount: "1000", txnDate: date, createdById: userId },
        tx,
      );

      const result = await importBankStatement(
        {
          bankAccountId,
          rows: [{ txnDate: date, description: "Cash deposit", reference: null, withdrawal: 0, deposit: 1000 }],
          createdById: userId,
        },
        tx,
      );

      expect(result.imported).toBe(1);
      expect(result.autoMatched).toBe(1);

      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } });
      expect(line.status).toBe("MATCHED");
      expect(line.matchedJournalLineId).not.toBeNull();
    });
  });

  it("drops a row where both withdrawal and deposit are zero, and a row where both are set", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId } = await freshBank(tx, userId, "Test SBI");

      await expect(
        importBankStatement(
          {
            bankAccountId,
            rows: [
              { txnDate: date, description: "blank", reference: null, withdrawal: 0, deposit: 0 },
              { txnDate: date, description: "both", reference: null, withdrawal: 100, deposit: 100 },
            ],
            createdById: userId,
          },
          tx,
        ),
      ).rejects.toThrow(ReconciliationError);
    });
  });

  it("leaves an unmatched line unmatched when no journal line has the same amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId } = await freshBank(tx, userId, "Test unmatched bank");

      const result = await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "No match", reference: null, withdrawal: 250, deposit: 0 }], createdById: userId },
        tx,
      );
      expect(result.autoMatched).toBe(0);

      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } });
      expect(line.status).toBe("UNMATCHED");
    });
  });
});

describe("manual match / unmatch", () => {
  it("manually matches, then unmatches, a statement line to a journal line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await freshBank(tx, userId, "Test manual match");

      const { transactionId } = await createCashBankTransaction(
        { type: "DEPOSIT", bankAccountId: ledgerAccountId, amount: "750", txnDate: date, createdById: userId },
        tx,
      );
      const txn = await tx.cashBankTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      const journalLine = await tx.journalLine.findFirstOrThrow({ where: { entryId: txn.postedEntryId!, accountId: ledgerAccountId } });

      await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "Deposit", reference: null, withdrawal: 0, deposit: 750 }], createdById: userId },
        tx,
      );
      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } });
      // Auto-match should already have claimed it; unmatch first to exercise the manual path cleanly.
      expect(line.status).toBe("MATCHED");

      await unmatchStatementLine({ statementLineId: line.id, unmatchedById: userId }, tx);
      const unmatched = await tx.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(unmatched.status).toBe("UNMATCHED");
      expect(unmatched.matchedJournalLineId).toBeNull();

      await matchStatementLine({ statementLineId: line.id, journalLineId: journalLine.id, matchedById: userId }, tx);
      const rematched = await tx.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(rematched.status).toBe("MATCHED");
      expect(rematched.matchedJournalLineId).toBe(journalLine.id);
    });
  });

  it("refuses to match a journal line on a different bank's ledger", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId: bankA } = await freshBank(tx, userId, "Bank A");
      const { ledgerAccountId: ledgerB } = await freshBank(tx, userId, "Bank B");

      const { transactionId } = await createCashBankTransaction(
        { type: "DEPOSIT", bankAccountId: ledgerB, amount: "300", txnDate: date, createdById: userId },
        tx,
      );
      const txn = await tx.cashBankTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      const journalLineOnB = await tx.journalLine.findFirstOrThrow({ where: { entryId: txn.postedEntryId!, accountId: ledgerB } });

      await importBankStatement(
        { bankAccountId: bankA, rows: [{ txnDate: date, description: "cross-bank", reference: null, withdrawal: 0, deposit: 999 }], createdById: userId },
        tx,
      );
      const lineOnA = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId: bankA } });

      await expect(
        matchStatementLine({ statementLineId: lineOnA.id, journalLineId: journalLineOnB.id, matchedById: userId }, tx),
      ).rejects.toThrow(/not on this bank/i);
    });
  });
});

describe("ignore / restore", () => {
  it("ignores an unmatched line, then restores it", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId } = await freshBank(tx, userId, "Test ignore");

      await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "Stray", reference: null, withdrawal: 10, deposit: 0 }], createdById: userId },
        tx,
      );
      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } });

      await ignoreStatementLine({ statementLineId: line.id, ignoredById: userId }, tx);
      expect((await tx.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).status).toBe("IGNORED");

      await restoreStatementLine({ statementLineId: line.id, restoredById: userId }, tx);
      expect((await tx.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).status).toBe("UNMATCHED");
    });
  });
});

describe("createTransactionFromStatementLine()", () => {
  it("posts a bank charge from a withdrawal line and matches it", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const expenseAccountId = await accountId(tx, "5490"); // Bank Charges
      const { bankAccountId } = await freshBank(tx, userId, "Test charge");

      await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "SMS charges", reference: null, withdrawal: 25, deposit: 0 }], createdById: userId },
        tx,
      );
      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } });
      expect(line.status).toBe("UNMATCHED");

      const { transactionId } = await createTransactionFromStatementLine(
        { statementLineId: line.id, type: "BANK_CHARGE", expenseAccountId, createdById: userId },
        tx,
      );
      expect(transactionId).toBeTruthy();

      const matched = await tx.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(matched.status).toBe("MATCHED");

      const txn = await tx.cashBankTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(toAmountString(txn.amount)).toBe("25.00");
      expect(txn.type).toBe("BANK_CHARGE");
    });
  });
});

describe("deleteStatementImport()", () => {
  it("refuses to delete a batch with a matched line, succeeds once unmatched", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await freshBank(tx, userId, "Test delete import");
      await createCashBankTransaction({ type: "DEPOSIT", bankAccountId: ledgerAccountId, amount: "400", txnDate: date, createdById: userId }, tx);

      const { importBatch } = await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "Will auto-match", reference: null, withdrawal: 0, deposit: 400 }], createdById: userId },
        tx,
      );
      const line = await tx.bankStatementLine.findFirstOrThrow({ where: { importBatch } });
      expect(line.status).toBe("MATCHED");

      await expect(deleteStatementImport({ bankAccountId, importBatch, deletedById: userId }, tx)).rejects.toThrow(/matched lines/i);

      await unmatchStatementLine({ statementLineId: line.id, unmatchedById: userId }, tx);
      const result = await deleteStatementImport({ bankAccountId, importBatch, deletedById: userId }, tx);
      expect(result.deleted).toBe(1);
      expect(await tx.bankStatementLine.findUnique({ where: { id: line.id } })).toBeNull();
    });
  });
});

describe("reconciliationSummary()", () => {
  it("nets book balance, unmatched statement items and unmatched book items correctly", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await freshBank(tx, userId, "Test summary");

      // Book-only: a deposit the bank statement hasn't shown yet (deposit in transit).
      await createCashBankTransaction({ type: "DEPOSIT", bankAccountId: ledgerAccountId, amount: "1000", txnDate: date, createdById: userId }, tx);
      // Statement-only: a bank charge the books don't have yet.
      await importBankStatement(
        { bankAccountId, rows: [{ txnDate: date, description: "Unrecorded charge", reference: null, withdrawal: 40, deposit: 0 }], createdById: userId },
        tx,
      );

      const summary = await reconciliationSummary({ bankAccountId, asOfDate: date, statementClosingBalance: "960" }, tx);

      expect(toAmountString(summary.bookBalance)).toBe("1000.00");
      expect(toAmountString(summary.statementOnlyWithdrawals)).toBe("40.00");
      expect(toAmountString(summary.bookOnlyDeposits)).toBe("1000.00");
      // adjustedBookBalance = 1000 + 0(deposits) - 40(withdrawals) = 960
      expect(toAmountString(summary.adjustedBookBalance)).toBe("960.00");
      // adjustedStatementBalance = 960(closing) - 1000(book-only deposit) + 0 = -40
      expect(toAmountString(summary.adjustedStatementBalance!)).toBe("-40.00");
    });
  });
});
