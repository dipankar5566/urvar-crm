"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopedWhere } from "@/lib/permissions";
import {
  createInvoiceFromOrder, cancelInvoice, InvoicingError,
} from "@/lib/accounting/invoicing";
import { TaxRateError } from "@/lib/accounting/tax";

type ActionResult = { error: string } | { success: true; invoiceId?: string };

const lineSchema = z.object({
  orderItemId: z.string().min(1),
  quantity: z.coerce.number().positive().optional(),
});

const createInvoiceSchema = z.object({
  orderId: z.string().min(1, "Select an order"),
  invoiceDate: z.string().min(1, "Invoice date is required"),
  dueDate: z.string().optional().or(z.literal("")),
  lines: z.array(lineSchema).optional(),
  freightAmount: z.coerce.number().nonnegative().optional(),
  discountAmount: z.coerce.number().nonnegative().optional(),
  notes: z.string().optional(),
  termsAndConditions: z.string().optional(),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/**
 * Wraps createInvoiceFromOrder with the CRM's own auth and scope layer. The
 * accounting service itself has no idea about roles or territories — that
 * belongs here, at the boundary, the same way createQuotation checks scope
 * before calling computeTotals.
 */
export async function createInvoiceAction(input: CreateInvoiceInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createInvoiceSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  // An accounting write on an order the caller cannot even see is not "their"
  // invoice to raise. Orders don't have their own module; scope through
  // quotations/customers read access on the order's owner, mirroring how
  // assertTargetInScope does it for quotations.
  const orderScope = can(user.role, "quotations", "read");
  const order = await prisma.order.findFirst({
    where: scopedWhere(orderScope, user, "createdById", { id: input.orderId }),
  });
  if (!order) return { error: "Order not found or access denied." };

  try {
    const result = await createInvoiceFromOrder({
      orderId: data.orderId,
      invoiceDate: new Date(data.invoiceDate),
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      lines: data.lines,
      freightAmount: data.freightAmount,
      discountAmount: data.discountAmount,
      notes: data.notes || null,
      termsAndConditions: data.termsAndConditions || null,
      createdById: user.id,
    });

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${result.invoiceId}`);
    revalidatePath("/accounting/journal");
    return { success: true, invoiceId: result.invoiceId };
  } catch (err) {
    if (err instanceof InvoicingError || err instanceof TaxRateError) {
      return { error: err.message };
    }
    throw err;
  }
}

const cancelSchema = z.object({ reason: z.string().min(3, "Give a reason for cancelling.") });

export async function cancelInvoiceAction(
  invoiceId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "accounting", "approve");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const invoice = await prisma.salesInvoice.findFirst({
    where: scopedWhere(scope, user, "createdById", { id: invoiceId }),
  });
  if (!invoice) return { error: "Invoice not found or access denied." };

  try {
    await cancelInvoice({ invoiceId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/accounting/journal");
    return { success: true };
  } catch (err) {
    if (err instanceof InvoicingError) return { error: err.message };
    throw err;
  }
}
