"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createLoan,
  recordLoanRepayment,
  cancelLoanRepayment,
  cancelLoan,
  LoanError,
} from "@/lib/accounting/loans";
import { suggestEmi, LoanScheduleError } from "@/lib/accounting/loan-schedule";
import { toAmountString } from "@/lib/accounting/money";

type ActionResult = { error: string } | { success: true; loanId?: string; repaymentId?: string };

const createSchema = z.object({
  lenderName: z.string().min(1, "Lender name is required"),
  lenderReference: z.string().optional(),
  disbursedToAccountId: z.string().min(1, "Select where the loan was disbursed to"),
  principal: z.coerce.number().positive("Principal must be greater than zero"),
  annualRatePercent: z.coerce.number().min(0, "Interest rate cannot be negative"),
  tenureMonths: z.coerce.number().int().positive("Tenure must be a whole number of months"),
  startDate: z.string().min(1, "Start date is required"),
  emiAmount: z.coerce.number().positive("Instalment amount must be greater than zero"),
  notes: z.string().optional(),
});

export async function createLoanAction(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createLoan({
      ...data,
      lenderReference: data.lenderReference?.trim() || null,
      startDate: new Date(data.startDate),
      notes: data.notes?.trim() || null,
      createdById: user.id,
    });
    revalidatePath("/accounting/loans");
    return { success: true, loanId: result.loanId };
  } catch (err) {
    if (err instanceof LoanError) return { error: err.message };
    throw err;
  }
}

const suggestSchema = z.object({
  principal: z.coerce.number().positive(),
  annualRatePercent: z.coerce.number().min(0),
  tenureMonths: z.coerce.number().int().positive(),
});

/** Server-side only: loan-schedule.ts pulls in money.ts (Prisma.Decimal), which a client component cannot import. */
export async function suggestEmiAction(
  input: z.infer<typeof suggestSchema>,
): Promise<{ error: string } | { success: true; emi: string }> {
  await requireUser();
  const parsed = suggestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const emi = suggestEmi(parsed.data.principal, parsed.data.annualRatePercent, parsed.data.tenureMonths);
    return { success: true, emi: toAmountString(emi) };
  } catch (err) {
    if (err instanceof LoanScheduleError) return { error: err.message };
    throw err;
  }
}

const repaymentSchema = z.object({
  loanId: z.string().min(1),
  installmentNumber: z.coerce.number().int().positive(),
  paidDate: z.string().min(1, "Date is required"),
  paidFromAccountId: z.string().min(1, "Select which account this was paid from"),
});

export async function recordLoanRepaymentAction(input: z.infer<typeof repaymentSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = repaymentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await recordLoanRepayment({
      loanId: data.loanId,
      installmentNumber: data.installmentNumber,
      paidDate: new Date(data.paidDate),
      paidFromAccountId: data.paidFromAccountId,
      createdById: user.id,
    });
    revalidatePath(`/accounting/loans/${data.loanId}`);
    revalidatePath("/accounting/loans");
    return { success: true, repaymentId: result.repaymentId };
  } catch (err) {
    if (err instanceof LoanError) return { error: err.message };
    throw err;
  }
}

const cancelRepaymentSchema = z.object({
  repaymentId: z.string().min(1),
  loanId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the cancellation."),
});

export async function cancelLoanRepaymentAction(input: z.infer<typeof cancelRepaymentSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = cancelRepaymentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelLoanRepayment({
      repaymentId: parsed.data.repaymentId,
      reason: parsed.data.reason,
      cancelledById: user.id,
    });
    revalidatePath(`/accounting/loans/${parsed.data.loanId}`);
    revalidatePath("/accounting/loans");
    return { success: true };
  } catch (err) {
    if (err instanceof LoanError) return { error: err.message };
    throw err;
  }
}

const cancelLoanSchema = z.object({
  loanId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the cancellation."),
});

export async function cancelLoanAction(input: z.infer<typeof cancelLoanSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = cancelLoanSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelLoan({ loanId: parsed.data.loanId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath(`/accounting/loans/${parsed.data.loanId}`);
    revalidatePath("/accounting/loans");
    return { success: true };
  } catch (err) {
    if (err instanceof LoanError) return { error: err.message };
    throw err;
  }
}
