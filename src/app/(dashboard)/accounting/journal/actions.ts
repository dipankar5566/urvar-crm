"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { postJournalEntry, reverseJournalEntry, PostingError, type PostingLine } from "@/lib/accounting/posting";
import { prisma } from "@/lib/prisma";

type ActionResult = { error: string } | { success: true; entryId?: string; alreadyPosted?: boolean };

/** A manual entry has no source document, so this must be a real UUID from
 * the client (minted once when the form mounts) rather than free text —
 * otherwise a caller could compose an idempotencyKey that collides with a
 * document's own key space (e.g. "SALES_INVOICE:xyz:1"). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lineSchema = z
  .object({
    accountId: z.string().min(1),
    debit: z.coerce.number().min(0).optional(),
    credit: z.coerce.number().min(0).optional(),
    narration: z.string().optional(),
    partyType: z.enum(["CUSTOMER", "SUPPLIER"]).optional(),
    partyId: z.string().optional(),
  })
  .refine((l) => (l.debit ?? 0) > 0 !== (l.credit ?? 0) > 0, {
    message: "Each line needs exactly one of debit or credit.",
  });

const createSchema = z.object({
  entryDate: z.string().min(1, "Date is required"),
  narration: z.string().min(1, "A narration is required"),
  lines: z.array(lineSchema).min(2, "A journal entry needs at least two lines"),
  clientToken: z.string().regex(UUID_PATTERN, "Invalid submission token"),
});

export async function createManualJournalEntryAction(
  input: z.infer<typeof createSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const lines: PostingLine[] = data.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    narration: l.narration || undefined,
    partyType: l.partyType,
    partyId: l.partyType ? l.partyId : undefined,
  }));

  try {
    const result = await postJournalEntry({
      entryDate: new Date(data.entryDate),
      narration: data.narration.trim(),
      sourceType: "MANUAL",
      idempotencyKey: `MANUAL:${data.clientToken}:1`,
      postedById: user.id,
      lines,
    });
    revalidatePath("/accounting/journal");
    return { success: true, entryId: result.entryId, alreadyPosted: result.alreadyPosted };
  } catch (err) {
    if (err instanceof PostingError) return { error: err.message };
    throw err;
  }
}

const reverseSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the reversal."),
});

/**
 * `reverseJournalEntry()` will happily reverse ANY posted entry, including
 * one backing a live business document — and then the document (a
 * SalesInvoice, an Expense, ...) still reads POSTED/APPROVED while its
 * ledger effect is gone. Every document already has its own cancel path
 * (cancelExpense, cancelStockValuation, ...) that reverses the entry AND
 * updates the document atomically. So this UI action refuses anything except
 * MANUAL and OPENING_BALANCE entries (the latter has no document status to
 * desync) and points elsewhere for everything else — the single easiest
 * thing to get wrong in this feature, caught before it shipped.
 */
export async function reverseManualEntryAction(input: z.infer<typeof reverseSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const entry = await prisma.journalEntry.findUnique({
    where: { id: parsed.data.entryId },
    select: { sourceType: true, entryNumber: true },
  });
  if (!entry) return { error: "That journal entry does not exist." };
  if (entry.sourceType !== "MANUAL" && entry.sourceType !== "OPENING_BALANCE") {
    return {
      error:
        `${entry.entryNumber} was posted from a ${entry.sourceType.replace(/_/g, " ").toLowerCase()} document — ` +
        `cancel it there instead. That reverses this entry and updates the document together; reversing it ` +
        `here would leave the document's own status out of sync with the ledger.`,
    };
  }

  try {
    const result = await reverseJournalEntry({
      entryId: parsed.data.entryId,
      reason: parsed.data.reason,
      postedById: user.id,
    });
    revalidatePath("/accounting/journal");
    return { success: true, entryId: result.entryId };
  } catch (err) {
    if (err instanceof PostingError) return { error: err.message };
    throw err;
  }
}
