import { describe, it, expect } from "vitest";
import { postJournalEntry, reverseJournalEntry, PostingError } from "@/lib/accounting/posting";
import { toAmountString, sum } from "@/lib/accounting/money";
import { withRollback, testUserId, accountId, openPeriodDate } from "./helpers/db";

/**
 * Integration tests for the posting service.
 *
 * Every one runs inside a transaction that is always rolled back — see
 * tests/helpers/db.ts for why this repo cannot have a separate test database.
 * Nothing here survives the test run, including allocated document numbers.
 */

// A unique key per run so a rolled-back test never collides with a later one.
const key = (name: string) => `TEST:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

describe("postJournalEntry(): the balance invariant", () => {
  it("posts a balanced entry and returns its number", async () => {
    await withRollback(async (tx) => {
      const result = await postJournalEntry(
        {
          entryDate: await openPeriodDate(tx),
          narration: "Cash sale",
          sourceType: "MANUAL",
          idempotencyKey: key("balanced"),
          postedById: await testUserId(tx),
          lines: [
            { accountKey: "CASH_ON_HAND", debit: "1050.00" },
            { accountKey: "SALES_REVENUE", credit: "1000.00" },
            { accountKey: "GST_OUTPUT_CGST", credit: "25.00" },
            { accountKey: "GST_OUTPUT_SGST", credit: "25.00" },
          ],
        },
        tx,
      );

      expect(result.alreadyPosted).toBe(false);
      expect(result.entryNumber).toMatch(/^JV\/\d{4}-\d{2}\/\d{4}$/);

      const lines = await tx.journalLine.findMany({ where: { entryId: result.entryId } });
      expect(lines).toHaveLength(4);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("1050.00");
      expect(toAmountString(sum(lines.map((l) => l.credit)))).toBe("1050.00");
    });
  });

  it("refuses an entry whose debits and credits differ", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            entryDate: await openPeriodDate(tx),
            narration: "Unbalanced",
            sourceType: "MANUAL",
            idempotencyKey: key("unbalanced"),
            postedById: await testUserId(tx),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "99.99" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/does not balance[\s\S]*0\.01/);
    });
  });

  it("refuses an entry that totals zero", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            entryDate: await openPeriodDate(tx),
            narration: "Nothing",
            sourceType: "MANUAL",
            idempotencyKey: key("zero"),
            postedById: await testUserId(tx),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "0" },
              { accountKey: "SALES_REVENUE", credit: "0" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(PostingError);
    });
  });

  it("refuses fewer than two lines", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            entryDate: await openPeriodDate(tx),
            narration: "One-sided",
            sourceType: "MANUAL",
            idempotencyKey: key("oneline"),
            postedById: await testUserId(tx),
            lines: [{ accountKey: "CASH_ON_HAND", debit: "100.00" }],
          },
          tx,
        ),
      ).rejects.toThrow(/at least two lines/i);
    });
  });
});

describe("postJournalEntry(): line-level rules", () => {
  const base = async (tx: Parameters<Parameters<typeof withRollback>[0]>[0]) => ({
    entryDate: await openPeriodDate(tx),
    narration: "Line rules",
    sourceType: "MANUAL" as const,
    postedById: await testUserId(tx),
  });

  it("refuses a negative amount instead of treating it as the other side", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            ...(await base(tx)),
            idempotencyKey: key("negative"),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "-100.00" },
              { accountKey: "SALES_REVENUE", credit: "-100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/non-negative/i);
    });
  });

  it("refuses a line carrying both a debit and a credit", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            ...(await base(tx)),
            idempotencyKey: key("bothsides"),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "100.00", credit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/exactly one of debit or credit/i);
    });
  });

  it("refuses a posting to a grouping account", async () => {
    await withRollback(async (tx) => {
      // 1100 "Current Assets" is a parent — isPostable false.
      await expect(
        postJournalEntry(
          {
            ...(await base(tx)),
            idempotencyKey: key("parent"),
            lines: [
              { accountId: await accountId(tx, "1100"), debit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/grouping account/i);
    });
  });

  it("refuses an unmapped account key by name", async () => {
    await withRollback(async (tx) => {
      await tx.accountMapping.deleteMany({ where: { key: "CASH_ON_HAND" } });
      await expect(
        postJournalEntry(
          {
            ...(await base(tx)),
            idempotencyKey: key("unmapped"),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/CASH_ON_HAND/);
    });
  });
});

describe("postJournalEntry(): idempotency", () => {
  it("returns the existing entry instead of posting twice", async () => {
    await withRollback(async (tx) => {
      const input = {
        entryDate: await openPeriodDate(tx),
        narration: "Double submit",
        sourceType: "SALES_INVOICE" as const,
        sourceId: "invoice-xyz",
        idempotencyKey: key("idem"),
        postedById: await testUserId(tx),
        lines: [
          { accountKey: "AR_TRADE" as const, debit: "500.00" },
          { accountKey: "SALES_REVENUE" as const, credit: "500.00" },
        ],
      };

      const first = await postJournalEntry(input, tx);
      const second = await postJournalEntry(input, tx);

      expect(first.alreadyPosted).toBe(false);
      expect(second.alreadyPosted).toBe(true);
      expect(second.entryId).toBe(first.entryId);
      expect(second.entryNumber).toBe(first.entryNumber);

      const count = await tx.journalEntry.count({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(count).toBe(1);

      const lines = await tx.journalLine.count({ where: { entryId: first.entryId } });
      expect(lines).toBe(2);
    });
  });
});

describe("postJournalEntry(): period control", () => {
  it("refuses to post into a closed period", async () => {
    await withRollback(async (tx) => {
      const date = await openPeriodDate(tx);
      const period = await tx.financialPeriod.findFirst({
        where: { startDate: { lte: date }, endDate: { gte: date } },
        select: { id: true },
      });
      await tx.financialPeriod.update({
        where: { id: period!.id },
        data: { status: "CLOSED" },
      });

      await expect(
        postJournalEntry(
          {
            entryDate: date,
            narration: "Into a closed period",
            sourceType: "MANUAL",
            idempotencyKey: key("closed"),
            postedById: await testUserId(tx),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/closed and will not accept postings/i);
    });
  });

  it("refuses a date no period covers", async () => {
    await withRollback(async (tx) => {
      await expect(
        postJournalEntry(
          {
            entryDate: new Date(1990, 0, 1, 12),
            narration: "Before the books existed",
            sourceType: "MANUAL",
            idempotencyKey: key("noperiod"),
            postedById: await testUserId(tx),
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "100.00" },
              { accountKey: "SALES_REVENUE", credit: "100.00" },
            ],
          },
          tx,
        ),
      ).rejects.toThrow(/no financial period covers/i);
    });
  });
});

describe("reverseJournalEntry()", () => {
  const original = async (tx: Parameters<Parameters<typeof withRollback>[0]>[0]) =>
    postJournalEntry(
      {
        entryDate: await openPeriodDate(tx),
        narration: "Original",
        sourceType: "MANUAL",
        idempotencyKey: key("orig"),
        postedById: await testUserId(tx),
        lines: [
          { accountKey: "AR_TRADE", debit: "750.00", partyType: "CUSTOMER", partyId: "cust-1" },
          { accountKey: "SALES_REVENUE", credit: "750.00" },
        ],
      },
      tx,
    );

  it("writes a mirror image and leaves the original's lines untouched", async () => {
    await withRollback(async (tx) => {
      const first = await original(tx);
      const before = await tx.journalLine.findMany({
        where: { entryId: first.entryId },
        orderBy: { lineNumber: "asc" },
      });

      const reversal = await reverseJournalEntry(
        { entryId: first.entryId, reason: "Wrong customer", postedById: await testUserId(tx) },
        tx,
      );

      const after = await tx.journalLine.findMany({
        where: { entryId: first.entryId },
        orderBy: { lineNumber: "asc" },
      });
      expect(after).toEqual(before);

      const mirrored = await tx.journalLine.findMany({
        where: { entryId: reversal.entryId },
        orderBy: { lineNumber: "asc" },
      });
      expect(toAmountString(mirrored[0].credit)).toBe("750.00");
      expect(toAmountString(mirrored[0].debit)).toBe("0.00");
      expect(mirrored[0].partyId).toBe("cust-1");

      const originalRow = await tx.journalEntry.findUnique({ where: { id: first.entryId } });
      const reversalRow = await tx.journalEntry.findUnique({ where: { id: reversal.entryId } });
      expect(originalRow!.status).toBe("REVERSED");
      expect(reversalRow!.reversesEntryId).toBe(first.entryId);
      expect(reversalRow!.narration).toContain(first.entryNumber);
      expect(reversalRow!.narration).toContain("Wrong customer");
    });
  });

  it("nets the two entries to zero", async () => {
    await withRollback(async (tx) => {
      const first = await original(tx);
      const reversal = await reverseJournalEntry(
        { entryId: first.entryId, reason: "Netting check", postedById: await testUserId(tx) },
        tx,
      );
      const lines = await tx.journalLine.findMany({
        where: { entryId: { in: [first.entryId, reversal.entryId] } },
      });
      const net = sum(lines.map((l) => l.debit)).minus(sum(lines.map((l) => l.credit)));
      expect(toAmountString(net)).toBe("0.00");
    });
  });

  it("refuses to reverse the same entry twice", async () => {
    await withRollback(async (tx) => {
      const first = await original(tx);
      const userId = await testUserId(tx);
      await reverseJournalEntry({ entryId: first.entryId, reason: "First", postedById: userId }, tx);
      await expect(
        reverseJournalEntry({ entryId: first.entryId, reason: "Second", postedById: userId }, tx),
      ).rejects.toThrow(/already been reversed/i);
    });
  });

  it("requires a reason, because that is the audit trail", async () => {
    await withRollback(async (tx) => {
      const first = await original(tx);
      await expect(
        reverseJournalEntry(
          { entryId: first.entryId, reason: "   ", postedById: await testUserId(tx) },
          tx,
        ),
      ).rejects.toThrow(/needs a reason/i);
    });
  });
});

describe("audit trail", () => {
  it("writes the audit row in the same transaction as the posting", async () => {
    await withRollback(async (tx) => {
      const result = await postJournalEntry(
        {
          entryDate: await openPeriodDate(tx),
          narration: "Audited",
          sourceType: "MANUAL",
          idempotencyKey: key("audit"),
          postedById: await testUserId(tx),
          lines: [
            { accountKey: "CASH_ON_HAND", debit: "42.00" },
            { accountKey: "SALES_REVENUE", credit: "42.00" },
          ],
        },
        tx,
      );

      const audit = await tx.auditLog.findFirst({
        where: { entityType: "JournalEntry", entityId: result.entryId, action: "POST" },
      });
      expect(audit).not.toBeNull();
      expect((audit!.newValue as Record<string, unknown>).amount).toBe("42.00");
    });
  });
});

describe("document numbering", () => {
  it("issues consecutive, gapless numbers within a financial year", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const numbers: string[] = [];

      for (let i = 0; i < 5; i++) {
        const r = await postJournalEntry(
          {
            entryDate: date,
            narration: `Sequential ${i}`,
            sourceType: "MANUAL",
            idempotencyKey: key(`seq-${i}`),
            postedById: userId,
            lines: [
              { accountKey: "CASH_ON_HAND", debit: "1.00" },
              { accountKey: "SALES_REVENUE", credit: "1.00" },
            ],
          },
          tx,
        );
        numbers.push(r.entryNumber);
      }

      const serials = numbers.map((n) => Number(n.split("/").pop()));
      for (let i = 1; i < serials.length; i++) {
        expect(serials[i]).toBe(serials[i - 1] + 1);
      }
      expect(new Set(numbers).size).toBe(5);
    });
  });
});

describe("trial balance", () => {
  it("sums to zero across every posted line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);

      await postJournalEntry(
        {
          entryDate: date,
          narration: "Invoice",
          sourceType: "SALES_INVOICE",
          idempotencyKey: key("tb-1"),
          postedById: userId,
          lines: [
            { accountKey: "AR_TRADE", debit: "1180.00" },
            { accountKey: "SALES_REVENUE", credit: "1000.00" },
            { accountKey: "GST_OUTPUT_CGST", credit: "90.00" },
            { accountKey: "GST_OUTPUT_SGST", credit: "90.00" },
          ],
        },
        tx,
      );
      await postJournalEntry(
        {
          entryDate: date,
          narration: "Receipt",
          sourceType: "RECEIPT",
          idempotencyKey: key("tb-2"),
          postedById: userId,
          lines: [
            { accountKey: "BANK_DEFAULT", debit: "1180.00" },
            { accountKey: "AR_TRADE", credit: "1180.00" },
          ],
        },
        tx,
      );

      const grouped = await tx.journalLine.groupBy({
        by: ["accountId"],
        _sum: { debit: true, credit: true },
      });
      const totalDebit = sum(grouped.map((g) => g._sum.debit));
      const totalCredit = sum(grouped.map((g) => g._sum.credit));
      expect(toAmountString(totalDebit.minus(totalCredit))).toBe("0.00");
    });
  });
});
