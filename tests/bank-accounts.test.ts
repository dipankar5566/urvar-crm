import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import {
  createBankAccount,
  changeOpeningBalance,
  updateBankAccountDetails,
  BankAccountError,
} from "@/lib/accounting/bank-accounts";
import { sub, sum, toAmountString } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

/** Net debit balance of an account from posted journal lines. */
async function balance(tx: Prisma.TransactionClient, accountIdValue: string): Promise<string> {
  const lines = await tx.journalLine.findMany({ where: { accountId: accountIdValue } });
  return toAmountString(sub(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit))));
}

describe("createBankAccount()", () => {
  it("mints a ledger under 1120 and posts the opening balance against Opening Balance Equity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const obe = await accountId(tx, "3300");
      const obeBefore = await balance(tx, obe);

      const { bankAccountId, ledgerAccountId, ledgerCode } = await createBankAccount(
        {
          displayName: "HDFC Test",
          bankName: "HDFC Bank",
          accountNumber: "1234567890",
          ifsc: "hdfc0001234",
          upiId: "test@hdfc",
          openingBalance: "50000",
          openingDate: date,
          createdById: userId,
        },
        tx,
      );

      expect(ledgerCode).toMatch(/^112\d$/);
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
      expect(bank.ifsc).toBe("HDFC0001234");
      expect(bank.openingRevision).toBe(1);
      expect(bank.openingEntryId).not.toBeNull();

      expect(await balance(tx, ledgerAccountId)).toBe("50000.00");
      expect(toAmountString(sub(await balance(tx, obe), obeBefore))).toBe("-50000.00");

      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: bank.openingEntryId! } });
      expect(entry.sourceType).toBe("OPENING_BALANCE");
      expect(entry.idempotencyKey).toBe(`BANK_OPENING:${bankAccountId}:1`);
    });
  });

  it("posts nothing for a zero opening balance", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { bankAccountId, ledgerAccountId } = await createBankAccount(
        { displayName: "SBI Test", createdById: userId },
        tx,
      );
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
      expect(bank.openingEntryId).toBeNull();
      expect(await balance(tx, ledgerAccountId)).toBe("0.00");
    });
  });

  it("allows a negative opening only on an overdraft account, and credits the bank", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await expect(
        createBankAccount({ displayName: "Bad", openingBalance: "-100", openingDate: date, createdById: userId }, tx),
      ).rejects.toThrow(BankAccountError);

      const { ledgerAccountId } = await createBankAccount(
        { displayName: "OD Account", isOverdraft: true, openingBalance: "-25000", openingDate: date, createdById: userId },
        tx,
      );
      expect(await balance(tx, ledgerAccountId)).toBe("-25000.00");
    });
  });

  it("rejects a malformed IFSC, account number or UPI ID", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      await expect(createBankAccount({ displayName: "X", ifsc: "HDFC123", createdById: userId }, tx)).rejects.toThrow(/IFSC/);
      await expect(createBankAccount({ displayName: "X", accountNumber: "12AB", createdById: userId }, tx)).rejects.toThrow(/account number/i);
      await expect(createBankAccount({ displayName: "X", upiId: "no-at-sign", createdById: userId }, tx)).rejects.toThrow(/UPI/);
    });
  });

  it("links details to an existing bank ledger without posting, and refuses an opening balance there", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const existing = await accountId(tx, "1121");
      const before = await balance(tx, existing);

      await expect(
        createBankAccount(
          { displayName: "Current A/c", existingLedgerAccountId: existing, openingBalance: "10", openingDate: date, createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/already carries its balance/);

      const { bankAccountId } = await createBankAccount(
        { displayName: "Current A/c", existingLedgerAccountId: existing, ifsc: "SBIN0000001", createdById: userId },
        tx,
      );
      expect(await balance(tx, existing)).toBe(before);

      await expect(
        changeOpeningBalance(
          { bankAccountId, openingBalance: "5", openingDate: date, reason: "test", changedById: userId },
          tx,
        ),
      ).rejects.toThrow(/journal entry instead/);

      await expect(
        createBankAccount({ displayName: "Dup", existingLedgerAccountId: existing, createdById: userId }, tx),
      ).rejects.toThrow(/already has bank details/);
    });
  });

  it("refuses to link a ledger that is not a bank account", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const cash = await accountId(tx, "1110");
      await expect(
        createBankAccount({ displayName: "Cash?", existingLedgerAccountId: cash, createdById: userId }, tx),
      ).rejects.toThrow(/not a bank ledger/);
    });
  });
});

describe("changeOpeningBalance()", () => {
  it("reverses the old opening and posts the new one under the next revision", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await createBankAccount(
        { displayName: "Fix Me", openingBalance: "50000", openingDate: date, createdById: userId },
        tx,
      );

      await changeOpeningBalance(
        { bankAccountId, openingBalance: "48000", openingDate: date, reason: "typo in opening", changedById: userId },
        tx,
      );

      expect(await balance(tx, ledgerAccountId)).toBe("48000.00");
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
      expect(bank.openingRevision).toBe(2);
      const reposted = await tx.journalEntry.findUniqueOrThrow({ where: { id: bank.openingEntryId! } });
      expect(reposted.idempotencyKey).toBe(`BANK_OPENING:${bankAccountId}:2`);
    });
  });

  it("can take the opening back to zero", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { bankAccountId, ledgerAccountId } = await createBankAccount(
        { displayName: "Zero Me", openingBalance: "100", openingDate: date, createdById: userId },
        tx,
      );
      await changeOpeningBalance(
        { bankAccountId, openingBalance: "0", openingDate: date, reason: "opened by mistake", changedById: userId },
        tx,
      );
      expect(await balance(tx, ledgerAccountId)).toBe("0.00");
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
      expect(bank.openingEntryId).toBeNull();
    });
  });
});

describe("updateBankAccountDetails()", () => {
  it("renames the minted ledger with the display name", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const { bankAccountId, ledgerAccountId } = await createBankAccount({ displayName: "Old Name", createdById: userId }, tx);
      await updateBankAccountDetails({ bankAccountId, displayName: "New Name", updatedById: userId }, tx);
      const ledger = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: ledgerAccountId } });
      expect(ledger.name).toBe("Bank - New Name");
    });
  });
});
