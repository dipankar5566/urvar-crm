"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { createCreditNote, cancelCreditNote, CreditNoteError } from "@/lib/accounting/credit-notes";
import type { CreditNoteReason } from "@/generated/prisma/enums";

type ActionResult = { error: string } | { success: true };

export async function createCreditNoteAction(input: {
  invoiceId: string;
  noteDate: string;
  reason: CreditNoteReason;
  narration?: string;
  lines: { invoiceItemId: string; quantity: string }[];
}): Promise<ActionResult & { creditNoteId?: string }> {
  const user = await requireUser();
  assertCan(user.role, "invoices", "write");

  const lines = input.lines.filter((l) => l.quantity.trim() !== "" && Number(l.quantity) > 0);
  if (lines.length === 0) return { error: "Enter a quantity to credit for at least one line." };

  try {
    const result = await createCreditNote({
      invoiceId: input.invoiceId,
      noteDate: new Date(input.noteDate),
      reason: input.reason,
      narration: input.narration?.trim() || null,
      lines,
      createdById: user.id,
    });
    revalidatePath(`/invoices/${input.invoiceId}`);
    revalidatePath("/accounting/journal");
    return { success: true, creditNoteId: result.creditNoteId };
  } catch (err) {
    if (err instanceof CreditNoteError) return { error: err.message };
    throw err;
  }
}

export async function cancelCreditNoteAction(
  creditNoteId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  if (input.reason.trim().length < 3) return { error: "Give a reason for cancelling." };

  try {
    await cancelCreditNote({ creditNoteId, reason: input.reason, cancelledById: user.id });
  } catch (err) {
    if (err instanceof CreditNoteError) return { error: err.message };
    throw err;
  }
  revalidatePath(`/credit-notes/${creditNoteId}`);
  revalidatePath("/accounting/journal");
  return { success: true };
}
