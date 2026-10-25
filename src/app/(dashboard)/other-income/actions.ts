"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan, assertCanApprove } from "@/lib/permissions";
import { createOtherIncome, approveOtherIncome, rejectOtherIncome, cancelOtherIncome, OtherIncomeError } from "@/lib/accounting/other-income";
import { prisma } from "@/lib/prisma";

/**
 * Vyapar parity step 6 (docs/VYAPAR_PARITY_SPEC.md D8, R11). Mirrors
 * expenses/actions.ts, minus the receipt-photo attachment flow — Other
 * Income entries are miscellaneous and infrequent; there's no OCR intake
 * to speak of, unlike a supplier bill or expense receipt.
 */

type ActionResult = { error: string } | { success: true; otherIncomeId?: string };

const itemSchema = z.object({
  description: z.string().min(1, "Every line needs a description"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unitPrice: z.coerce.number().min(0, "Price cannot be negative"),
  taxRatePercent: z.coerce.number().min(0).max(100).optional(),
});

const createSchema = z
  .object({
    incomeDate: z.string().min(1, "Date is required"),
    categoryAccountId: z.string().min(1, "Select a category"),
    payerName: z.string().min(1, "Payer is required"),
    description: z.string().optional(),
    amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
    items: z.array(itemSchema).optional(),
    isGstApplicable: z.boolean().optional(),
    method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
    depositAccountId: z.string().min(1, "Select where this was received into"),
  })
  .refine((data) => (data.items?.length ?? 0) > 0 || data.amount !== undefined, {
    message: "Enter an amount or add at least one line item.",
    path: ["amount"],
  });
export type CreateOtherIncomeFormInput = z.infer<typeof createSchema>;

export async function createOtherIncomeAction(input: CreateOtherIncomeFormInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createOtherIncome({
      incomeDate: new Date(data.incomeDate),
      categoryAccountId: data.categoryAccountId,
      payerName: data.payerName,
      description: data.description || null,
      amount: data.amount,
      items: data.items,
      isGstApplicable: data.isGstApplicable,
      method: data.method,
      depositAccountId: data.depositAccountId,
      createdById: user.id,
    });

    revalidatePath("/other-income");
    return { success: true, otherIncomeId: result.otherIncomeId };
  } catch (err) {
    if (err instanceof OtherIncomeError) return { error: err.message };
    throw err;
  }
}

export async function approveOtherIncomeAction(otherIncomeId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "approve");

  const income = await prisma.otherIncome.findUnique({ where: { id: otherIncomeId }, select: { createdById: true } });
  if (!income) return { error: "Other income entry not found." };

  try {
    assertCanApprove(user.role, "otherIncome", user.id, income.createdById);
    await approveOtherIncome({ otherIncomeId, approverRole: user.role, approvedById: user.id });
    revalidatePath("/other-income");
    revalidatePath(`/other-income/${otherIncomeId}`);
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof OtherIncomeError || err instanceof Error) return { error: err.message };
    throw err;
  }
}

const rejectSchema = z.object({ reason: z.string().min(3, "Give a reason for rejecting.") });

export async function rejectOtherIncomeAction(otherIncomeId: string, input: { reason: string }): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "approve");

  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await rejectOtherIncome({ otherIncomeId, reason: parsed.data.reason, rejectedById: user.id });
    revalidatePath("/other-income");
    revalidatePath(`/other-income/${otherIncomeId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof OtherIncomeError) return { error: err.message };
    throw err;
  }
}

const cancelSchema = z.object({ reason: z.string().min(3, "Give a reason for cancelling.") });

export async function cancelOtherIncomeAction(otherIncomeId: string, input: { reason: string }): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelOtherIncome({ otherIncomeId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath("/other-income");
    revalidatePath(`/other-income/${otherIncomeId}`);
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof OtherIncomeError) return { error: err.message };
    throw err;
  }
}
