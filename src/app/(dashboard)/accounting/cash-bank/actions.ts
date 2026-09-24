"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createCashBankTransaction,
  cancelCashBankTransaction,
  CashBankError,
  type CreateCashBankTransactionInput,
} from "@/lib/accounting/cash-bank";

type ActionResult = { error: string } | { success: true; transactionId?: string };

const baseFields = {
  txnDate: z.string().min(1, "Date is required"),
  amount: z.coerce.number().positive("Amount must be greater than zero"),
  reference: z.string().optional(),
  notes: z.string().optional(),
};

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DEPOSIT"), bankAccountId: z.string().min(1), ...baseFields }),
  z.object({ type: z.literal("WITHDRAWAL"), bankAccountId: z.string().min(1), ...baseFields }),
  z.object({
    type: z.literal("TRANSFER"),
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    ...baseFields,
  }),
  z.object({
    type: z.literal("BANK_CHARGE"),
    bankAccountId: z.string().min(1),
    expenseAccountId: z.string().min(1),
    ...baseFields,
  }),
  z.object({
    type: z.literal("INTEREST_INCOME"),
    bankAccountId: z.string().min(1),
    incomeAccountId: z.string().min(1),
    ...baseFields,
  }),
  z.object({
    type: z.literal("CASH_ADJUSTMENT"),
    direction: z.enum(["SHORTAGE", "OVERAGE"]),
    adjustmentAccountId: z.string().min(1),
    ...baseFields,
  }),
]);

export async function recordCashBankTransactionAction(
  input: z.infer<typeof inputSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createCashBankTransaction({
      ...data,
      txnDate: new Date(data.txnDate),
      reference: data.reference?.trim() || null,
      notes: data.notes?.trim() || null,
      createdById: user.id,
    } as CreateCashBankTransactionInput);
    revalidatePath("/accounting/cash-bank");
    return { success: true, transactionId: result.transactionId };
  } catch (err) {
    if (err instanceof CashBankError) return { error: err.message };
    throw err;
  }
}

const cancelSchema = z.object({
  transactionId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the cancellation."),
});

export async function cancelCashBankTransactionAction(
  input: z.infer<typeof cancelSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelCashBankTransaction({
      transactionId: parsed.data.transactionId,
      reason: parsed.data.reason,
      cancelledById: user.id,
    });
    revalidatePath("/accounting/cash-bank");
    return { success: true };
  } catch (err) {
    if (err instanceof CashBankError) return { error: err.message };
    throw err;
  }
}
