"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createLedgerAccountAudited, renameLedgerAccount, setLedgerAccountActive, LedgerAccountError,
} from "@/lib/accounting/ledger-accounts";

type ActionResult = { error: string } | { success: true; accountId?: string };

const LEDGER_ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
const NORMAL_BALANCES = ["DEBIT", "CREDIT"] as const;

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1, "A name is required"),
  type: z.enum(LEDGER_ACCOUNT_TYPES),
  parentCode: z.string().min(1, "Select a parent group"),
  normalBalance: z.enum(NORMAL_BALANCES).optional(),
  isPostable: z.boolean().optional(),
  description: z.string().optional(),
});

export async function createLedgerAccountAction(
  input: z.infer<typeof createSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createLedgerAccountAudited({
      code: data.code,
      name: data.name,
      type: data.type,
      parentCode: data.parentCode,
      normalBalance: data.normalBalance,
      isPostable: data.isPostable,
      description: data.description || null,
      userId: user.id,
    });
    revalidatePath("/accounting");
    return { success: true, accountId: result.accountId };
  } catch (err) {
    if (err instanceof LedgerAccountError) return { error: err.message };
    throw err;
  }
}

const renameSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1, "A name is required"),
  description: z.string().optional(),
});

export async function renameLedgerAccountAction(input: z.infer<typeof renameSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await renameLedgerAccount({ ...parsed.data, userId: user.id });
    revalidatePath("/accounting");
    return { success: true };
  } catch (err) {
    if (err instanceof LedgerAccountError) return { error: err.message };
    throw err;
  }
}

export async function setLedgerAccountActiveAction(accountId: string, isActive: boolean): Promise<ActionResult> {
  const user = await requireUser();
  // Deactivating an account is an approval-level decision (it can hide a
  // real balance from every report), the same tier closePeriod/reopenPeriod
  // already sit at; activating is a lower-risk undo, but kept at the same
  // gate for one consistent rule rather than two.
  assertCan(user.role, "accounting", "approve");

  try {
    await setLedgerAccountActive({ accountId, isActive, userId: user.id });
    revalidatePath("/accounting");
    return { success: true };
  } catch (err) {
    if (err instanceof LedgerAccountError) return { error: err.message };
    throw err;
  }
}
