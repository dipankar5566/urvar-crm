"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createBankAccount,
  changeOpeningBalance,
  setBankAccountActive,
  BankAccountError,
} from "@/lib/accounting/bank-accounts";
import { LedgerAccountError } from "@/lib/accounting/ledger-accounts";
import { PostingError } from "@/lib/accounting/posting";

type ActionResult = { error: string } | { success: true; bankAccountId?: string };

const optionalText = z.string().trim().optional();

const createSchema = z.object({
  displayName: z.string().trim().min(1, "Display name is required"),
  bankName: optionalText,
  branch: optionalText,
  accountNumber: optionalText,
  ifsc: optionalText,
  accountHolderName: optionalText,
  upiId: optionalText,
  isOverdraft: z.boolean().optional(),
  printOnInvoice: z.boolean().optional(),
  openingBalance: z.coerce.number().optional(),
  openingDate: z.string().optional(),
  existingLedgerAccountId: z.string().optional(),
});

function domainError(err: unknown): string | null {
  if (err instanceof BankAccountError || err instanceof LedgerAccountError || err instanceof PostingError) return err.message;
  return null;
}

function revalidate() {
  revalidatePath("/accounting/cash-bank");
  revalidatePath("/accounting/cash-bank/bank-accounts");
}

export async function createBankAccountAction(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;

  try {
    const result = await createBankAccount({
      ...d,
      openingBalance: d.existingLedgerAccountId ? 0 : (d.openingBalance ?? 0),
      openingDate: d.openingDate ? new Date(d.openingDate) : null,
      existingLedgerAccountId: d.existingLedgerAccountId || null,
      createdById: user.id,
    });
    revalidate();
    return { success: true, bankAccountId: result.bankAccountId };
  } catch (err) {
    const message = domainError(err);
    if (message) return { error: message };
    throw err;
  }
}

const openingSchema = z.object({
  bankAccountId: z.string().min(1),
  openingBalance: z.coerce.number(),
  openingDate: z.string().min(1, "Date is required"),
  reason: z.string().trim().min(3, "Give a reason for the change."),
});

export async function changeOpeningBalanceAction(input: z.infer<typeof openingSchema>): Promise<ActionResult> {
  const user = await requireUser();
  // Re-posting an opening balance reverses a posted entry, the same authority cancelling needs.
  assertCan(user.role, "accounting", "approve");

  const parsed = openingSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await changeOpeningBalance({
      ...parsed.data,
      openingDate: new Date(parsed.data.openingDate),
      changedById: user.id,
    });
    revalidate();
    return { success: true };
  } catch (err) {
    const message = domainError(err);
    if (message) return { error: message };
    throw err;
  }
}

const activeSchema = z.object({ bankAccountId: z.string().min(1), isActive: z.boolean() });

export async function setBankAccountActiveAction(input: z.infer<typeof activeSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = activeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await setBankAccountActive({ ...parsed.data, changedById: user.id });
    revalidate();
    return { success: true };
  } catch (err) {
    const message = domainError(err);
    if (message) return { error: message };
    throw err;
  }
}
