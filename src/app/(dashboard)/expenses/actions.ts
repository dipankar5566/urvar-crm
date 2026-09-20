"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan, assertCanApprove } from "@/lib/permissions";
import { createExpense, approveExpense, rejectExpense, cancelExpense, ExpenseError } from "@/lib/accounting/expenses";
import { prisma } from "@/lib/prisma";

type ActionResult = { error: string } | { success: true; expenseId?: string };

const createSchema = z.object({
  expenseDate: z.string().min(1, "Date is required"),
  categoryAccountId: z.string().min(1, "Select a category"),
  payeeName: z.string().min(1, "Payee is required"),
  description: z.string().optional(),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
  paymentAccountId: z.string().min(1, "Select where this was paid from"),
});
export type CreateExpenseFormInput = z.infer<typeof createSchema>;

export async function createExpenseAction(input: CreateExpenseFormInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "expenses", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createExpense({
      expenseDate: new Date(data.expenseDate),
      categoryAccountId: data.categoryAccountId,
      payeeName: data.payeeName,
      description: data.description || null,
      amount: data.amount,
      method: data.method,
      paymentAccountId: data.paymentAccountId,
      createdById: user.id,
    });

    revalidatePath("/expenses");
    return { success: true, expenseId: result.expenseId };
  } catch (err) {
    if (err instanceof ExpenseError) return { error: err.message };
    throw err;
  }
}

export async function approveExpenseAction(expenseId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "expenses", "approve");

  const expense = await prisma.expense.findUnique({ where: { id: expenseId }, select: { createdById: true } });
  if (!expense) return { error: "Expense not found." };

  try {
    // assertCanApprove enforces separation of duties: the submitter cannot
    // also be the approver, except for the Super Admin exemption.
    assertCanApprove(user.role, "expenses", user.id, expense.createdById);
    await approveExpense({ expenseId, approverRole: user.role, approvedById: user.id });
    revalidatePath("/expenses");
    revalidatePath(`/expenses/${expenseId}`);
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof ExpenseError || err instanceof Error) return { error: err.message };
    throw err;
  }
}

const rejectSchema = z.object({ reason: z.string().min(3, "Give a reason for rejecting.") });

export async function rejectExpenseAction(
  expenseId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "expenses", "approve");

  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await rejectExpense({ expenseId, reason: parsed.data.reason, rejectedById: user.id });
    revalidatePath("/expenses");
    revalidatePath(`/expenses/${expenseId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ExpenseError) return { error: err.message };
    throw err;
  }
}

const cancelSchema = z.object({ reason: z.string().min(3, "Give a reason for cancelling.") });

export async function cancelExpenseAction(
  expenseId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "expenses", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelExpense({ expenseId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath("/expenses");
    revalidatePath(`/expenses/${expenseId}`);
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof ExpenseError) return { error: err.message };
    throw err;
  }
}
