"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { transferCheque, reopenCheque, ChequeError } from "@/lib/accounting/cheques";
import { PostingError } from "@/lib/accounting/posting";

type ActionResult = { error: string } | { success: true };

function domainError(err: unknown): string | null {
  return err instanceof ChequeError || err instanceof PostingError ? err.message : null;
}

function revalidate() {
  revalidatePath("/accounting/cash-bank");
  revalidatePath("/accounting/cash-bank/cheques");
}

const transferSchema = z.object({
  chequeId: z.string().min(1),
  bankLedgerAccountId: z.string().min(1, "Choose a bank account"),
  transferDate: z.string().min(1, "Date is required"),
});

/** Deposit a received cheque or clear an issued one (Vyapar: Deposit / Withdraw). */
export async function transferChequeAction(input: z.infer<typeof transferSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await transferCheque({
      chequeId: parsed.data.chequeId,
      bankLedgerAccountId: parsed.data.bankLedgerAccountId,
      transferDate: new Date(parsed.data.transferDate),
      transferredById: user.id,
    });
    revalidate();
    return { success: true };
  } catch (err) {
    const message = domainError(err);
    if (message) return { error: message };
    throw err;
  }
}

const reopenSchema = z.object({
  chequeId: z.string().min(1),
  reason: z.string().trim().min(3, "Give a reason for reopening."),
});

/** Vyapar's Reopen. Reverses a posting, so it needs the same authority as cancelling. */
export async function reopenChequeAction(input: z.infer<typeof reopenSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await reopenCheque({ ...parsed.data, reopenedById: user.id });
    revalidate();
    return { success: true };
  } catch (err) {
    const message = domainError(err);
    if (message) return { error: message };
    throw err;
  }
}
