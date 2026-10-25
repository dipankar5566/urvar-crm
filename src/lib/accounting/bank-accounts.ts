import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logAudit } from "@/lib/audit";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { createLedgerAccount, nextChildCode } from "./ledger-accounts";
import { abs, isNegative, isZero, round, type MoneyInput } from "./money";

/**
 * Bank account master (docs/VYAPAR_PARITY_SPEC.md §2.1).
 *
 * Vyapar keeps a bank's identity (number, IFSC, UPI) and its opening balance
 * on one record. Here the money still lives on a LedgerAccount under
 * 1120 Bank Accounts — receipts, payments and transfers keep posting to that
 * ledger exactly as before — and `BankAccount` adds only the identity plus
 * the opening balance, which is posted once against OPENING_BALANCE_EQUITY.
 *
 * Vyapar stores the opening figure and shows a "Difference in Opening
 * Balance" line on its Balance Sheet; Urvar's equivalent is 3300.
 *
 * `isActive` here is a display flag for pickers; it does not deactivate the
 * ledger, so history and reversals against the account keep working.
 */

export class BankAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankAccountError";
  }
}

const BANK_GROUP_CODE = "1120";
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const ACCOUNT_NUMBER_PATTERN = /^[0-9]{6,18}$/;

export type BankAccountDetails = {
  displayName: string;
  bankName?: string | null;
  branch?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  accountHolderName?: string | null;
  upiId?: string | null;
  isOverdraft?: boolean;
  printOnInvoice?: boolean;
};

export type CreateBankAccountInput = BankAccountDetails & {
  /** Signed; negative only for an overdraft account. */
  openingBalance?: MoneyInput;
  openingDate?: Date | null;
  /**
   * Attach details to a bank ledger that already exists (1121, 1122). Its
   * balance came from real postings (the Vyapar migration), so no opening
   * entry is posted and `openingBalance` must be zero/omitted.
   */
  existingLedgerAccountId?: string | null;
  createdById: string;
};

const clean = (v: string | null | undefined) => (v ?? "").trim() || null;

function normalizeDetails(d: BankAccountDetails) {
  const displayName = d.displayName.trim();
  if (!displayName) throw new BankAccountError("A bank account needs a display name.");

  const ifsc = clean(d.ifsc)?.toUpperCase() ?? null;
  if (ifsc && !IFSC_PATTERN.test(ifsc)) {
    throw new BankAccountError(`"${ifsc}" is not a valid IFSC — 4 letters, a zero, then 6 letters or digits.`);
  }
  const accountNumber = clean(d.accountNumber)?.replace(/\s+/g, "") ?? null;
  if (accountNumber && !ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
    throw new BankAccountError("An account number is 6 to 18 digits.");
  }
  const upiId = clean(d.upiId);
  if (upiId && !UPI_PATTERN.test(upiId)) throw new BankAccountError(`"${upiId}" is not a valid UPI ID.`);

  return {
    displayName,
    bankName: clean(d.bankName),
    branch: clean(d.branch),
    accountNumber,
    ifsc,
    accountHolderName: clean(d.accountHolderName),
    upiId,
    isOverdraft: d.isOverdraft ?? false,
    printOnInvoice: d.printOnInvoice ?? false,
  };
}

async function assertLinkableBankLedger(tx: Prisma.TransactionClient, ledgerAccountId: string) {
  const account = await tx.ledgerAccount.findUnique({ where: { id: ledgerAccountId }, include: { parent: true } });
  if (!account) throw new BankAccountError("That ledger account does not exist.");
  if (account.parent?.code !== BANK_GROUP_CODE || !account.isPostable) {
    throw new BankAccountError(`${account.code} ${account.name} is not a bank ledger under ${BANK_GROUP_CODE} Bank Accounts.`);
  }
  const linked = await tx.bankAccount.findUnique({ where: { ledgerAccountId } });
  if (linked) throw new BankAccountError(`${account.code} ${account.name} already has bank details (${linked.displayName}).`);
  return account;
}

/** Post (or re-post) the opening balance. Dr bank / Cr OBE; mirrored for an overdraft. */
async function postOpening(
  tx: Prisma.TransactionClient,
  bank: { id: string; ledgerAccountId: string; displayName: string },
  amount: Prisma.Decimal,
  date: Date,
  revision: number,
  userId: string,
) {
  const value = abs(amount);
  const overdrawn = isNegative(amount);
  return postJournalEntry(
    {
      entryDate: date,
      narration: `Opening balance — ${bank.displayName}`,
      sourceType: "OPENING_BALANCE",
      sourceId: bank.id,
      idempotencyKey: `BANK_OPENING:${bank.id}:${revision}`,
      postedById: userId,
      lines: [
        { accountId: bank.ledgerAccountId, ...(overdrawn ? { credit: value } : { debit: value }) },
        { accountKey: "OPENING_BALANCE_EQUITY", ...(overdrawn ? { debit: value } : { credit: value }) },
      ],
    },
    tx,
  );
}

export async function createBankAccount(
  input: CreateBankAccountInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ bankAccountId: string; ledgerAccountId: string; ledgerCode: string }> {
  const run = async (tx: Prisma.TransactionClient) => {
    const details = normalizeDetails(input);
    const opening = round(input.openingBalance ?? 0);
    if (isNegative(opening) && !details.isOverdraft) {
      throw new BankAccountError("Only an overdraft account can open with a negative balance.");
    }

    let ledgerAccountId: string;
    let ledgerCode: string;
    const linking = Boolean(input.existingLedgerAccountId);
    if (input.existingLedgerAccountId) {
      if (!isZero(opening)) {
        throw new BankAccountError("An existing bank ledger already carries its balance — leave the opening balance empty.");
      }
      const ledger = await assertLinkableBankLedger(tx, input.existingLedgerAccountId);
      ledgerAccountId = ledger.id;
      ledgerCode = ledger.code;
    } else {
      const code = await nextChildCode(BANK_GROUP_CODE, tx);
      const created = await createLedgerAccount(
        {
          code,
          name: `Bank - ${details.displayName}`,
          type: "ASSET",
          parentCode: BANK_GROUP_CODE,
          description: details.accountNumber
            ? `A/c ${details.accountNumber}${details.ifsc ? `, IFSC ${details.ifsc}` : ""}`
            : null,
        },
        tx,
      );
      ledgerAccountId = created.accountId;
      ledgerCode = created.code;
    }

    const needsOpening = !isZero(opening);
    if (needsOpening && !input.openingDate) throw new BankAccountError("An opening balance needs an 'as of' date.");

    const bank = await tx.bankAccount.create({
      data: {
        ...details,
        ledgerAccountId,
        openingBalance: opening,
        openingDate: input.openingDate ?? null,
        linkedExistingLedger: linking,
        createdById: input.createdById,
      },
    });

    if (needsOpening) {
      const posted = await postOpening(tx, bank, opening, input.openingDate!, 1, input.createdById);
      await tx.bankAccount.update({
        where: { id: bank.id },
        data: { openingEntryId: posted.entryId, openingRevision: 1 },
      });
    }

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "BankAccount",
        entityId: bank.id,
        newValue: { displayName: details.displayName, ledgerCode, openingBalance: opening.toFixed(2), linking },
      },
      tx,
    );

    return { bankAccountId: bank.id, ledgerAccountId, ledgerCode };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Edit identity fields only. Money changes go through `changeOpeningBalance`. */
export async function updateBankAccountDetails(
  input: BankAccountDetails & { bankAccountId: string; updatedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient) => {
    const bank = await tx.bankAccount.findUnique({ where: { id: input.bankAccountId } });
    if (!bank) throw new BankAccountError("That bank account does not exist.");
    const details = normalizeDetails(input);
    if (!details.isOverdraft && isNegative(bank.openingBalance)) {
      throw new BankAccountError("This account opened overdrawn — change the opening balance before clearing the overdraft flag.");
    }

    await tx.bankAccount.update({ where: { id: bank.id }, data: details });
    if (details.displayName !== bank.displayName && !bank.linkedExistingLedger) {
      await tx.ledgerAccount.update({ where: { id: bank.ledgerAccountId }, data: { name: `Bank - ${details.displayName}` } });
    }
    await logAudit(
      {
        userId: input.updatedById,
        action: "UPDATE",
        entityType: "BankAccount",
        entityId: bank.id,
        oldValue: { displayName: bank.displayName, ifsc: bank.ifsc, accountNumber: bank.accountNumber },
        newValue: { displayName: details.displayName, ifsc: details.ifsc, accountNumber: details.accountNumber },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Correct an opening balance: reverse the posted opening entry (never edit
 * it) and post the new figure under the next revision's idempotency key.
 */
export async function changeOpeningBalance(
  input: { bankAccountId: string; openingBalance: MoneyInput; openingDate: Date; reason: string; changedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient) => {
    const bank = await tx.bankAccount.findUnique({ where: { id: input.bankAccountId } });
    if (!bank) throw new BankAccountError("That bank account does not exist.");
    if (bank.linkedExistingLedger) {
      throw new BankAccountError("This ledger's balance comes from existing postings — correct it with a journal entry instead.");
    }
    if (input.reason.trim().length < 3) throw new BankAccountError("Give a reason for changing the opening balance.");
    const opening = round(input.openingBalance);
    if (isNegative(opening) && !bank.isOverdraft) {
      throw new BankAccountError("Only an overdraft account can open with a negative balance.");
    }

    if (bank.openingEntryId) {
      await reverseJournalEntry({ entryId: bank.openingEntryId, reason: input.reason, postedById: input.changedById }, tx);
    }
    const revision = bank.openingRevision + 1;
    let openingEntryId: string | null = null;
    if (!isZero(opening)) {
      const posted = await postOpening(tx, bank, opening, input.openingDate, revision, input.changedById);
      openingEntryId = posted.entryId;
    }
    await tx.bankAccount.update({
      where: { id: bank.id },
      data: { openingBalance: opening, openingDate: input.openingDate, openingEntryId, openingRevision: revision },
    });

    await logAudit(
      {
        userId: input.changedById,
        action: "UPDATE",
        entityType: "BankAccount",
        entityId: bank.id,
        oldValue: { openingBalance: bank.openingBalance.toFixed(2) },
        newValue: { openingBalance: opening.toFixed(2), reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export async function setBankAccountActive(
  input: { bankAccountId: string; isActive: boolean; changedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient) => {
    const bank = await tx.bankAccount.findUnique({ where: { id: input.bankAccountId } });
    if (!bank) throw new BankAccountError("That bank account does not exist.");
    await tx.bankAccount.update({ where: { id: bank.id }, data: { isActive: input.isActive } });
    await logAudit(
      {
        userId: input.changedById,
        action: "UPDATE",
        entityType: "BankAccount",
        entityId: bank.id,
        newValue: { isActive: input.isActive },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
