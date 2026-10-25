import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { loadAccountMap, requireAccount } from "./account-map";
import { gt, round, type MoneyInput } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * Cash and bank movements not already captured by a Receipt, Expense or
 * SupplierPayment: deposits, withdrawals, inter-account transfers, bank
 * charges, interest income, and a physical cash-count correction.
 *
 * `type` decides which side of the entry each account lands on — the
 * posting matrix in the Phase 9 plan — so the caller never has to know
 * debit-vs-credit itself, the same "guided form" shape Expense's category
 * picker already has.
 */

export class CashBankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashBankError";
  }
}

type BaseInput = {
  txnDate: Date;
  amount: MoneyInput;
  reference?: string | null;
  notes?: string | null;
  createdById: string;
};

export type CreateCashBankTransactionInput =
  | (BaseInput & { type: "DEPOSIT"; bankAccountId: string })
  | (BaseInput & { type: "WITHDRAWAL"; bankAccountId: string })
  | (BaseInput & { type: "TRANSFER"; fromAccountId: string; toAccountId: string })
  | (BaseInput & { type: "BANK_CHARGE"; bankAccountId: string; expenseAccountId: string })
  | (BaseInput & { type: "INTEREST_INCOME"; bankAccountId: string; incomeAccountId: string })
  | (BaseInput & {
      type: "CASH_ADJUSTMENT";
      direction: "SHORTAGE" | "OVERAGE";
      /**
       * Expense or equity account to offset the cash change. Omitted, it
       * defaults to CASH_ADJUSTMENT_EQUITY (3410) — Vyapar's Add/Reduce Cash
       * treatment (VYAPAR_PARITY_SPEC.md §2.2, decision D4).
       */
      adjustmentAccountId?: string | null;
    })
  // A bank balance change with no cash side (Vyapar types 17/18), offset to
  // BANK_ADJUSTMENT_EQUITY (3420).
  | (BaseInput & { type: "BANK_ADJ_INCREASE"; bankAccountId: string })
  | (BaseInput & { type: "BANK_ADJ_DECREASE"; bankAccountId: string });

type AccountTypeName = "ASSET" | "EXPENSE" | "INCOME" | "EQUITY";

async function assertAccountUsable(
  tx: Prisma.TransactionClient,
  accountId: string,
  expectType?: AccountTypeName | AccountTypeName[],
) {
  const account = await tx.ledgerAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new CashBankError("That account does not exist.");
  if (!account.isActive) throw new CashBankError(`${account.code} ${account.name} is inactive.`);
  if (!account.isPostable) throw new CashBankError(`${account.code} ${account.name} is a grouping account.`);
  const allowed = expectType === undefined ? null : Array.isArray(expectType) ? expectType : [expectType];
  if (allowed && !allowed.includes(account.type as AccountTypeName)) {
    // Every type name starts with a vowel, hence "an".
    throw new CashBankError(`${account.code} ${account.name} is not an ${allowed.join(" or ")} account.`);
  }
  return account;
}

/** A bank adjustment must hit a real bank ledger — a child of 1120 Bank Accounts. */
async function assertBankLedger(tx: Prisma.TransactionClient, accountId: string) {
  const account = await assertAccountUsable(tx, accountId, "ASSET");
  const parent = account.parentId ? await tx.ledgerAccount.findUnique({ where: { id: account.parentId } }) : null;
  if (parent?.code !== "1120") {
    throw new CashBankError(`${account.code} ${account.name} is not a bank account (it is not under 1120 Bank Accounts).`);
  }
  return account;
}

export async function createCashBankTransaction(
  input: CreateCashBankTransactionInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ transactionId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ transactionId: string }> => {
    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new CashBankError("Amount must be greater than zero.");

    const accountMap = await loadAccountMap(tx);
    const cashAccountId = requireAccount(accountMap, "CASH_ON_HAND");

    let debitAccountId: string;
    let creditAccountId: string;

    switch (input.type) {
      case "DEPOSIT": {
        await assertAccountUsable(tx, input.bankAccountId, "ASSET");
        debitAccountId = input.bankAccountId;
        creditAccountId = cashAccountId;
        break;
      }
      case "WITHDRAWAL": {
        await assertAccountUsable(tx, input.bankAccountId, "ASSET");
        debitAccountId = cashAccountId;
        creditAccountId = input.bankAccountId;
        break;
      }
      case "TRANSFER": {
        if (input.fromAccountId === input.toAccountId) {
          throw new CashBankError("A transfer needs two different accounts.");
        }
        await assertAccountUsable(tx, input.fromAccountId, "ASSET");
        await assertAccountUsable(tx, input.toAccountId, "ASSET");
        debitAccountId = input.toAccountId;
        creditAccountId = input.fromAccountId;
        break;
      }
      case "BANK_CHARGE": {
        await assertAccountUsable(tx, input.bankAccountId, "ASSET");
        await assertAccountUsable(tx, input.expenseAccountId, "EXPENSE");
        debitAccountId = input.expenseAccountId;
        creditAccountId = input.bankAccountId;
        break;
      }
      case "INTEREST_INCOME": {
        await assertAccountUsable(tx, input.bankAccountId, "ASSET");
        await assertAccountUsable(tx, input.incomeAccountId, "INCOME");
        debitAccountId = input.bankAccountId;
        creditAccountId = input.incomeAccountId;
        break;
      }
      case "CASH_ADJUSTMENT": {
        const offsetId = input.adjustmentAccountId || requireAccount(accountMap, "CASH_ADJUSTMENT_EQUITY");
        await assertAccountUsable(tx, offsetId, ["EXPENSE", "EQUITY"]);
        if (input.direction === "SHORTAGE") {
          debitAccountId = offsetId;
          creditAccountId = cashAccountId;
        } else {
          debitAccountId = cashAccountId;
          creditAccountId = offsetId;
        }
        break;
      }
      case "BANK_ADJ_INCREASE":
      case "BANK_ADJ_DECREASE": {
        await assertBankLedger(tx, input.bankAccountId);
        const offsetId = requireAccount(accountMap, "BANK_ADJUSTMENT_EQUITY");
        if (input.type === "BANK_ADJ_INCREASE") {
          debitAccountId = input.bankAccountId;
          creditAccountId = offsetId;
        } else {
          debitAccountId = offsetId;
          creditAccountId = input.bankAccountId;
        }
        break;
      }
    }

    const record = await tx.cashBankTransaction.create({
      data: {
        type: input.type,
        txnDate: input.txnDate,
        debitAccountId,
        creditAccountId,
        amount,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        createdById: input.createdById,
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.txnDate,
        narration: `${input.type.replace(/_/g, " ")} — ${input.reference?.trim() || record.id}`,
        sourceType: "CASH_BANK_TRANSFER",
        sourceId: record.id,
        idempotencyKey: `CASH_BANK_TRANSFER:${record.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountId: debitAccountId, debit: amount },
          { accountId: creditAccountId, credit: amount },
        ],
      },
      tx,
    );

    await tx.cashBankTransaction.update({ where: { id: record.id }, data: { postedEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "CashBankTransaction",
        entityId: record.id,
        newValue: { type: input.type, amount: amount.toFixed(2) },
      },
      tx,
    );

    return { transactionId: record.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export async function cancelCashBankTransaction(
  input: { transactionId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const record = await tx.cashBankTransaction.findUnique({ where: { id: input.transactionId } });
    if (!record) throw new CashBankError("That transaction does not exist.");
    if (record.cancelledAt) throw new CashBankError("Already cancelled.");
    if (!record.postedEntryId) throw new CashBankError("This transaction has no posting to reverse.");

    await reverseJournalEntry({ entryId: record.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.cashBankTransaction.update({ where: { id: record.id }, data: { cancelledAt: new Date() } });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "CashBankTransaction",
        entityId: record.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
