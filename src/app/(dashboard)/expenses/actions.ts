"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan, assertCanApprove } from "@/lib/permissions";
import { createExpense, approveExpense, rejectExpense, cancelExpense, ExpenseError } from "@/lib/accounting/expenses";
import { prisma } from "@/lib/prisma";
import { assertExpenseAttachmentUploadAllowed, saveDocument, UploadRejected } from "@/lib/documents";

type ActionResult = { error: string } | { success: true; expenseId?: string };

/**
 * Uploads a receipt/bill attachment ahead of the expense itself, exactly the
 * two-step pattern purchases/actions.ts uses for its invoice scan: the File
 * row is created unattached (`relatedExpenseId: null`) so its cuid can name
 * the bytes on disk, and createExpense() links it to the new Expense in the
 * same transaction once the rest of the form is submitted. An abandoned
 * upload stays unreachable through /api/documents, so nothing leaks.
 */
export async function uploadExpenseAttachmentAction(
  formData: FormData,
): Promise<{ fileId: string } | { error: string }> {
  const user = await requireUser();
  assertCan(user.role, "expenses", "write");

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file uploaded." };

  try {
    assertExpenseAttachmentUploadAllowed(file);
  } catch (err) {
    if (err instanceof UploadRejected) return { error: err.message };
    throw err;
  }

  const record = await prisma.file.create({
    data: {
      fileName: file.name,
      filePath: "",
      mimeType: file.type,
      sizeBytes: file.size,
      category: "ATTACHMENT",
      uploadedById: user.id,
    },
    select: { id: true },
  });
  const filePath = await saveDocument(record.id, file.type, Buffer.from(await file.arrayBuffer()));
  await prisma.file.update({ where: { id: record.id }, data: { filePath } });

  return { fileId: record.id };
}

const itemSchema = z.object({
  description: z.string().min(1, "Every line needs a description"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unitPrice: z.coerce.number().min(0, "Price cannot be negative"),
  taxRatePercent: z.coerce.number().min(0).max(100).optional(),
});

const createSchema = z
  .object({
    expenseDate: z.string().min(1, "Date is required"),
    categoryAccountId: z.string().min(1, "Select a category"),
    payeeName: z.string().min(1, "Payee is required"),
    description: z.string().optional(),
    // Legacy flat-amount path. Mutually exclusive with `items` — the refine
    // below requires exactly one.
    amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
    items: z.array(itemSchema).optional(),
    isGstApplicable: z.boolean().optional(),
    claimInputCredit: z.boolean().optional(),
    transportAmount: z.coerce.number().min(0).optional(),
    method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
    paymentAccountId: z.string().min(1, "Select where this was paid from"),
    // An already-uploaded receipt/bill photo to attach.
    fileId: z.string().optional(),
  })
  .refine((data) => (data.items?.length ?? 0) > 0 || data.amount !== undefined, {
    message: "Enter an amount or add at least one line item.",
    path: ["amount"],
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
      items: data.items,
      isGstApplicable: data.isGstApplicable,
      claimInputCredit: data.claimInputCredit,
      transportAmount: data.transportAmount,
      method: data.method,
      paymentAccountId: data.paymentAccountId,
      fileId: data.fileId,
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
