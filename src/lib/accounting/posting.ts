import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { JournalSourceType, PartyType } from "@/generated/prisma/enums";
import { logAudit } from "@/lib/audit";
import { loadAccountMap, requireAccount, type AccountKey } from "./account-map";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { add, isNegative, isZero, money, round, toAmountString, type MoneyInput } from "./money";

/**
 * The posting service — the only module in this codebase permitted to write
 * `JournalEntry` / `JournalLine`.
 *
 * Everything else (an invoice, a receipt, a bill) is a business record that
 * *describes* a transaction; posting is the separate step that turns it into
 * balanced ledger movement. Keeping that in one place is what makes the
 * invariants enforceable: a document cannot forget to balance, cannot slip a
 * posting into a closed period, and cannot post itself twice, because it is
 * not the thing doing the posting.
 *
 * Posted entries are immutable. A mistake is corrected by
 * `reverseJournalEntry`, which writes a new, linked, mirror-image entry.
 * Nothing here updates or deletes a posted row.
 */

export type PostingLine = {
  /** Either a concrete account id, or a mapping key to resolve. Exactly one. */
  accountId?: string;
  accountKey?: AccountKey;
  debit?: MoneyInput;
  credit?: MoneyInput;
  narration?: string;
  /** Subledger attribution for AR/AP lines. */
  partyType?: PartyType;
  partyId?: string;
};

export type PostJournalEntryInput = {
  entryDate: Date;
  narration: string;
  sourceType: JournalSourceType;
  sourceId?: string | null;
  /**
   * Stable key identifying this logical posting. A retry, a double-submitted
   * form or a replayed webhook with the same key returns the entry that
   * already exists instead of posting a second time. Compose it from the
   * document: `SALES_INVOICE:${invoiceId}:1`.
   */
  idempotencyKey: string;
  lines: PostingLine[];
  postedById: string;
};

export type PostResult = {
  entryId: string;
  entryNumber: string;
  /** True when this key had already been posted and nothing new was written. */
  alreadyPosted: boolean;
};

export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingError";
  }
}

/**
 * Post a balanced journal entry.
 *
 * Pass `tx` when the caller is already inside a transaction — creating an
 * invoice and posting it must be atomic. Omit it and one is opened here.
 *
 * `tx` must be a real interactive transaction client, never the base Prisma
 * client. An earlier version of this tried to tell the two apart at runtime
 * and got it backwards: in Prisma 7 the interactive client also exposes
 * `$transaction`, so the check always said "not a transaction" and every
 * caller-supplied `tx` was silently ignored in favour of a fresh, independent
 * transaction. Postings committed even when the enclosing work rolled back.
 * There is no reliable way to sniff this, so the contract is explicit instead.
 */
export async function postJournalEntry(
  input: PostJournalEntryInput,
  tx?: Prisma.TransactionClient,
): Promise<PostResult> {
  if (tx) return postWithin(input, tx);
  return prisma.$transaction((t) => postWithin(input, t));
}

async function postWithin(
  input: PostJournalEntryInput,
  tx: Prisma.TransactionClient,
): Promise<PostResult> {
  // 1. Idempotency. Checked first so a retry costs one indexed read and never
  //    re-runs validation against a period that has since closed.
  const existing = await tx.journalEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, entryNumber: true },
  });
  if (existing) {
    return { entryId: existing.id, entryNumber: existing.entryNumber, alreadyPosted: true };
  }

  if (!input.narration.trim()) {
    throw new PostingError("A journal entry needs a narration.");
  }
  if (input.lines.length < 2) {
    throw new PostingError(`A journal entry needs at least two lines, got ${input.lines.length}.`);
  }

  // 2. Resolve mapping keys to account ids.
  const needsMap = input.lines.some((l) => l.accountKey);
  const accountMap = needsMap ? await loadAccountMap(tx) : new Map<AccountKey, string>();

  const resolved = input.lines.map((line, i) => {
    if (!line.accountId === !line.accountKey) {
      throw new PostingError(`Line ${i + 1}: give exactly one of accountId or accountKey.`);
    }
    const accountId = line.accountId ?? requireAccount(accountMap, line.accountKey!);

    const debit = round(line.debit ?? 0);
    const credit = round(line.credit ?? 0);

    if (isNegative(debit) || isNegative(credit)) {
      throw new PostingError(
        `Line ${i + 1}: amounts must be non-negative. Use the other side rather ` +
          `than a negative amount, or every SUM-based report breaks.`,
      );
    }
    if (isZero(debit) === isZero(credit)) {
      throw new PostingError(
        `Line ${i + 1}: exactly one of debit or credit must be non-zero ` +
          `(got debit ${toAmountString(debit)}, credit ${toAmountString(credit)}).`,
      );
    }

    return {
      lineNumber: i + 1,
      accountId,
      debit,
      credit,
      narration: line.narration ?? null,
      partyType: line.partyType ?? null,
      partyId: line.partyId ?? null,
    };
  });

  // 3. The invariant. Exact Decimal comparison, no epsilon: if these differ at
  //    all, something upstream did float arithmetic and must be fixed there
  //    rather than tolerated here.
  const totalDebit = resolved.reduce((acc, l) => add(acc, l.debit), money(0));
  const totalCredit = resolved.reduce((acc, l) => add(acc, l.credit), money(0));
  if (!totalDebit.equals(totalCredit)) {
    throw new PostingError(
      `Entry does not balance: debits ${toAmountString(totalDebit)} vs credits ` +
        `${toAmountString(totalCredit)} (difference ${toAmountString(totalDebit.minus(totalCredit))}).`,
    );
  }
  if (totalDebit.isZero()) {
    throw new PostingError("Entry totals zero — there is nothing to post.");
  }

  // 4. Accounts must exist, be active, and be leaves. Posting to a parent
  //    double-counts it against its own children in every rolled-up report.
  const accountIds = [...new Set(resolved.map((l) => l.accountId))];
  const accounts = await tx.ledgerAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, code: true, name: true, isPostable: true, isActive: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of accountIds) {
    const account = byId.get(id);
    if (!account) throw new PostingError(`Ledger account ${id} does not exist.`);
    if (!account.isActive) {
      throw new PostingError(`Account ${account.code} ${account.name} is inactive.`);
    }
    if (!account.isPostable) {
      throw new PostingError(
        `Account ${account.code} ${account.name} is a grouping account and cannot ` +
          `take postings. Post to one of its children.`,
      );
    }
  }

  // 5. Period must exist and be open.
  const company = await requireCompany(tx);
  const period = await tx.financialPeriod.findFirst({
    where: {
      companyId: company.id,
      startDate: { lte: input.entryDate },
      endDate: { gte: input.entryDate },
    },
    select: { id: true, label: true, status: true },
  });
  if (!period) {
    throw new PostingError(
      `No financial period covers ${input.entryDate.toISOString().slice(0, 10)}. ` +
        `Open the financial year before posting into it.`,
    );
  }
  if (period.status !== "OPEN") {
    throw new PostingError(
      `${period.label} is ${period.status.toLowerCase()} and will not accept postings.`,
    );
  }

  // 6. Number and write.
  const entryNumber = await allocateDocumentNumber(tx, {
    companyId: company.id,
    documentType: DOCUMENT_TYPES.JOURNAL,
    financialYear: financialYearOf(input.entryDate, company.fyStartMonth),
    fyStartMonth: company.fyStartMonth,
  });

  const entry = await tx.journalEntry.create({
    data: {
      entryNumber,
      entryDate: input.entryDate,
      periodId: period.id,
      narration: input.narration.trim(),
      status: "POSTED",
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      postedById: input.postedById,
      lines: { create: resolved },
    },
    select: { id: true, entryNumber: true },
  });

  // 7. Audit, inside this transaction, so it cannot survive a rollback of the
  //    thing it describes.
  await logAudit(
    {
      userId: input.postedById,
      action: "POST",
      entityType: "JournalEntry",
      entityId: entry.id,
      newValue: {
        entryNumber: entry.entryNumber,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        amount: toAmountString(totalDebit),
        lineCount: resolved.length,
      },
    },
    tx,
  );

  return { entryId: entry.id, entryNumber: entry.entryNumber, alreadyPosted: false };
}

export type ReverseInput = {
  entryId: string;
  reason: string;
  postedById: string;
  /**
   * Date of the reversing entry. Defaults to the original's date, which keeps
   * the two in the same period and nets them to zero there. Pass a later date
   * when the original period has already been closed.
   */
  reversalDate?: Date;
};

/**
 * Reverse a posted entry by writing its mirror image.
 *
 * The original is never touched beyond being marked REVERSED — its rows,
 * amounts and audit history stay exactly as posted, which is the whole point
 * of an immutable ledger.
 */
export async function reverseJournalEntry(
  input: ReverseInput,
  tx?: Prisma.TransactionClient,
): Promise<PostResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostResult> => {
    const original = await tx.journalEntry.findUnique({
      where: { id: input.entryId },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        reversedBy: { select: { id: true } },
      },
    });
    if (!original) throw new PostingError(`Journal entry ${input.entryId} does not exist.`);
    if (original.status === "REVERSED" || original.reversedBy) {
      throw new PostingError(`${original.entryNumber} has already been reversed.`);
    }
    if (original.status !== "POSTED") {
      throw new PostingError(
        `Only a posted entry can be reversed; ${original.entryNumber} is ${original.status}.`,
      );
    }
    if (!input.reason.trim()) {
      throw new PostingError("A reversal needs a reason — it is the audit trail.");
    }

    const result = await postWithin(
      {
        entryDate: input.reversalDate ?? original.entryDate,
        narration: `Reversal of ${original.entryNumber}: ${input.reason.trim()}`,
        sourceType: "REVERSAL",
        sourceId: original.id,
        idempotencyKey: `REVERSAL:${original.id}:1`,
        postedById: input.postedById,
        // Debits become credits and vice versa.
        lines: original.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
          narration: l.narration ?? undefined,
          partyType: l.partyType ?? undefined,
          partyId: l.partyId ?? undefined,
        })),
      },
      tx,
    );

    await tx.journalEntry.update({
      where: { id: original.id },
      data: { status: "REVERSED" },
    });
    await tx.journalEntry.update({
      where: { id: result.entryId },
      data: { reversesEntryId: original.id },
    });

    await logAudit(
      {
        userId: input.postedById,
        action: "REVERSE",
        entityType: "JournalEntry",
        entityId: original.id,
        oldValue: { status: original.status },
        newValue: {
          status: "REVERSED",
          reversedByEntryId: result.entryId,
          reversedByNumber: result.entryNumber,
          reason: input.reason.trim(),
        },
      },
      tx,
    );

    return result;
  };

  if (tx) return run(tx);
  return prisma.$transaction(run);
}
