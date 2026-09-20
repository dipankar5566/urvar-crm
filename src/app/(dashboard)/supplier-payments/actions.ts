"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { recordSupplierPayment, cancelSupplierPayment, SupplierPaymentError } from "@/lib/accounting/supplier-payments";

type ActionResult = { error: string } | { success: true; paymentId?: string };

const allocationSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.coerce.number().positive(),
});

const recordPaymentSchema = z.object({
  supplierId: z.string().min(1, "Select a supplier"),
  paymentDate: z.string().min(1, "Payment date is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
  reference: z.string().optional(),
  paymentAccountId: z.string().min(1, "Select where this was paid from"),
  allocations: z.array(allocationSchema).optional(),
  notes: z.string().optional(),
});
export type RecordSupplierPaymentFormInput = z.infer<typeof recordPaymentSchema>;

export async function recordSupplierPaymentAction(
  input: RecordSupplierPaymentFormInput,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  const parsed = recordPaymentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
  if (!supplier) return { error: "Supplier not found." };

  try {
    const result = await recordSupplierPayment({
      supplierId: data.supplierId,
      paymentDate: new Date(data.paymentDate),
      amount: data.amount,
      method: data.method,
      reference: data.reference || null,
      paymentAccountId: data.paymentAccountId,
      allocations: data.allocations,
      notes: data.notes || null,
      createdById: user.id,
    });

    revalidatePath("/supplier-payments");
    revalidatePath("/purchases");
    revalidatePath("/accounting/journal");
    return { success: true, paymentId: result.paymentId };
  } catch (err) {
    if (err instanceof SupplierPaymentError) return { error: err.message };
    throw err;
  }
}

const cancelSchema = z.object({ reason: z.string().min(3, "Give a reason for cancelling.") });

export async function cancelSupplierPaymentAction(
  paymentId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "purchases", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelSupplierPayment({ paymentId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath("/supplier-payments");
    revalidatePath("/purchases");
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof SupplierPaymentError) return { error: err.message };
    throw err;
  }
}
