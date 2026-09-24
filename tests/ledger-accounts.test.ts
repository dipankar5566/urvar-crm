import { describe, it, expect } from "vitest";
import { postJournalEntry, reverseJournalEntry } from "@/lib/accounting/posting";
import {
  createLedgerAccount, renameLedgerAccount, setLedgerAccountActive, nextChildCode, LedgerAccountError,
} from "@/lib/accounting/ledger-accounts";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

describe("createLedgerAccount()", () => {
  it("creates a postable account under an existing non-postable group", async () => {
    await withRollback(async (tx) => {
      const result = await createLedgerAccount(
        { code: "9901", name: "Test Loan Account", type: "LIABILITY", parentCode: "2220" },
        tx,
      );
      const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: result.accountId } });
      expect(account.code).toBe("9901");
      expect(account.isPostable).toBe(true);
      expect(account.isSystem).toBe(false);
      expect(account.normalBalance).toBe("CREDIT"); // defaulted from LIABILITY
    });
  });

  it("refuses a code already in use", async () => {
    await withRollback(async (tx) => {
      await expect(
        createLedgerAccount({ code: "1110", name: "Duplicate", type: "ASSET", parentCode: "1100" }, tx),
      ).rejects.toThrow(/already in use/i);
    });
  });

  it("refuses a code that is not exactly four digits", async () => {
    await withRollback(async (tx) => {
      await expect(
        createLedgerAccount({ code: "99", name: "Bad Code", type: "ASSET", parentCode: "1100" }, tx),
      ).rejects.toThrow(LedgerAccountError);
    });
  });

  it("refuses a parent that is itself postable", async () => {
    await withRollback(async (tx) => {
      await expect(
        createLedgerAccount({ code: "9902", name: "Under a leaf", type: "ASSET", parentCode: "1110" }, tx),
      ).rejects.toThrow(/not a grouping account/i);
    });
  });

  it("refuses a type mismatch with the parent group", async () => {
    await withRollback(async (tx) => {
      await expect(
        createLedgerAccount({ code: "9903", name: "Wrong type", type: "ASSET", parentCode: "2220" }, tx),
      ).rejects.toThrow(/LIABILITY group/i);
    });
  });
});

describe("nextChildCode()", () => {
  it("suggests one past the highest existing child", async () => {
    await withRollback(async (tx) => {
      const suggestion = await nextChildCode("1120", tx); // Bank Accounts: 1121, 1122
      expect(suggestion).toBe("1123");
    });
  });
});

describe("renameLedgerAccount()", () => {
  it("always allowed, regardless of posting history", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");
      await postJournalEntry(
        { entryDate: date, narration: "Test", sourceType: "MANUAL",
          idempotencyKey: `TEST:RENAME:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "100" }, { accountId: capital, credit: "100" }] },
        tx,
      );
      await renameLedgerAccount({ accountId: cash, name: "Petty Cash", userId }, tx);
      const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: cash } });
      expect(account.name).toBe("Petty Cash");
    });
  });
});

describe("setLedgerAccountActive()", () => {
  it("refuses to deactivate a system account", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const cash = await accountId(tx, "1110");
      await expect(setLedgerAccountActive({ accountId: cash, isActive: false, userId }, tx)).rejects.toThrow(/system account/i);
    });
  });

  it("refuses to deactivate an account referenced by AccountMapping", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const result = await createLedgerAccount(
        { code: "9904", name: "Mapped Test", type: "ASSET", parentCode: "1100" },
        tx,
      );
      await tx.accountMapping.create({ data: { key: "TEST_MAPPING_9904", accountId: result.accountId } });
      await expect(
        setLedgerAccountActive({ accountId: result.accountId, isActive: false, userId }, tx),
      ).rejects.toThrow(/mapped to the posting role/i);
    });
  });

  it("refuses to deactivate an account with a non-zero balance", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const result = await createLedgerAccount(
        { code: "9905", name: "Nonzero Test", type: "ASSET", parentCode: "1100" },
        tx,
      );
      const capital = await accountId(tx, "3100");
      await postJournalEntry(
        { entryDate: date, narration: "Test", sourceType: "MANUAL",
          idempotencyKey: `TEST:NONZERO:${Date.now()}`, postedById: userId,
          lines: [{ accountId: result.accountId, debit: "500" }, { accountId: capital, credit: "500" }] },
        tx,
      );
      await expect(
        setLedgerAccountActive({ accountId: result.accountId, isActive: false, userId }, tx),
      ).rejects.toThrow(/non-zero balance/i);
    });
  });

  it("allows deactivating a clean, unmapped, zero-balance account", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const result = await createLedgerAccount(
        { code: "9906", name: "Clean Test", type: "ASSET", parentCode: "1100" },
        tx,
      );
      await setLedgerAccountActive({ accountId: result.accountId, isActive: false, userId }, tx);
      const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: result.accountId } });
      expect(account.isActive).toBe(false);
    });
  });
});

describe("reverseJournalEntry()", () => {
  it("reverses a posted manual entry to a net-zero pair", async () => {
    // The document-desync guard (refusing to reverse a SALES_INVOICE-sourced
    // entry from the raw journal UI) lives in
    // accounting/journal/actions.ts's reverseManualEntryAction, one layer
    // above this library call, which intentionally has no opinion on source
    // type. This test exercises the library call itself.
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const capital = await accountId(tx, "3100");
      const posted = await postJournalEntry(
        { entryDate: date, narration: "Test", sourceType: "MANUAL",
          idempotencyKey: `TEST:REV:${Date.now()}`, postedById: userId,
          lines: [{ accountId: cash, debit: "200" }, { accountId: capital, credit: "200" }] },
        tx,
      );
      const reversal = await reverseJournalEntry({ entryId: posted.entryId, reason: "test", postedById: userId }, tx);
      expect(reversal.entryId).not.toBe(posted.entryId);
      const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: posted.entryId } });
      expect(original.status).toBe("REVERSED");
    });
  });
});
