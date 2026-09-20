"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopedWhere } from "@/lib/permissions";
import { recordReceipt, cancelReceipt, ReceiptError } from "@/lib/accounting/receipts";

type ActionResult = { error: string } | { success: true; receiptId?: string };

const allocationSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.coerce.number().positive(),
});

const recordReceiptSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  receiptDate: z.string().min(1, "Receipt date is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
  reference: z.string().optional(),
  depositAccountId: z.string().min(1, "Select where this was deposited"),
  allocations: z.array(allocationSchema).optional(),
  notes: z.string().optional(),
});
export type RecordReceiptFormInput = z.infer<typeof recordReceiptSchema>;

export async function recordReceiptAction(input: RecordReceiptFormInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = recordReceiptSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const customerScope = can(user.role, "customers", "read");
  const customer = await prisma.customer.findFirst({
    where: scopedWhere(customerScope, user, "assignedToId", { id: data.customerId, deletedAt: null }),
  });
  if (!customer) return { error: "Customer not found or access denied." };

  try {
    const result = await recordReceipt({
      customerId: data.customerId,
      receiptDate: new Date(data.receiptDate),
      amount: data.amount,
      method: data.method,
      reference: data.reference || null,
      depositAccountId: data.depositAccountId,
      allocations: data.allocations,
      notes: data.notes || null,
      createdById: user.id,
    });

    revalidatePath("/receipts");
    revalidatePath("/invoices");
    revalidatePath(`/customers/${data.customerId}`);
    revalidatePath("/accounting/journal");
    return { success: true, receiptId: result.receiptId };
  } catch (err) {
    if (err instanceof ReceiptError) return { error: err.message };
    throw err;
  }
}

const cancelSchema = z.object({ reason: z.string().min(3, "Give a reason for cancelling.") });

export async function cancelReceiptAction(
  receiptId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "accounting", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const receipt = await prisma.receipt.findFirst({
    where: scopedWhere(scope, user, "createdById", { id: receiptId }),
  });
  if (!receipt) return { error: "Receipt not found or access denied." };

  try {
    await cancelReceipt({ receiptId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath("/receipts");
    revalidatePath("/invoices");
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof ReceiptError) return { error: err.message };
    throw err;
  }
}
