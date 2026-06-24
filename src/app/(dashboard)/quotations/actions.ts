"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import {
  quotationFormSchema,
  quotationStatusSchema,
  type QuotationFormInput,
  type QuotationStatusInput,
} from "@/lib/validations/quotation";
import { generateOrderNumber, generateQuotationNumber } from "@/lib/id-sequences";
import { notifyUser } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

type ComputedItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
  gstPercent: number;
};

async function computeTotals(
  items: { productId: string; quantity: number; unitPrice: number; discountPercent: number }[],
  overallDiscountPercent: number,
  freightAmount: number,
) {
  const products = await prisma.product.findMany({
    where: { id: { in: items.map((i) => i.productId) } },
    select: { id: true, gstPercent: true, isActive: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  const computedItems: ComputedItem[] = items.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) throw new Error("One or more selected products no longer exist.");
    const lineSubtotal = item.quantity * item.unitPrice;
    const lineTotal = lineSubtotal - lineSubtotal * (item.discountPercent / 100);
    return {
      ...item,
      lineTotal,
      gstPercent: Number(product.gstPercent),
    };
  });

  const subtotal = computedItems.reduce((sum, i) => sum + i.lineTotal, 0);
  const discountAmount = subtotal * (overallDiscountPercent / 100);
  const taxAmount = computedItems.reduce((sum, i) => {
    const taxableLine = i.lineTotal * (1 - overallDiscountPercent / 100);
    return sum + taxableLine * (i.gstPercent / 100);
  }, 0);
  const totalAmount = subtotal - discountAmount + taxAmount + freightAmount;

  return { computedItems, subtotal, discountAmount, taxAmount, totalAmount };
}

async function assertTargetInScope(
  user: Awaited<ReturnType<typeof requireUser>>,
  customerId: string | null,
  leadId: string | null,
) {
  if (customerId) {
    const scope = can(user.role, "customers", "read");
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
    });
    if (!customer) throw new Error("Customer not found or access denied.");
    return customer;
  }
  if (leadId) {
    const scope = can(user.role, "leads", "read");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
    });
    if (!lead) throw new Error("Lead not found or access denied.");
    return lead;
  }
  return null;
}

export async function createQuotation(input: QuotationFormInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "quotations", "write");
  const parsed = quotationFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  try {
    await assertTargetInScope(user, data.customerId, data.leadId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Access denied." };
  }

  let totals;
  try {
    totals = await computeTotals(data.items, data.discountPercent, data.freightAmount);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not price this quotation." };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const quotationNumber = await generateQuotationNumber();
      const quotation = await prisma.quotation.create({
        data: {
          quotationNumber,
          customerId: data.customerId,
          leadId: data.leadId,
          createdById: user.id,
          validUntil: data.validUntil ? new Date(data.validUntil) : null,
          subtotal: totals.subtotal,
          discountPercent: data.discountPercent,
          discountAmount: totals.discountAmount,
          freightAmount: data.freightAmount,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          termsAndConditions: data.termsAndConditions,
          notes: data.notes,
          items: {
            create: totals.computedItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discountPercent: item.discountPercent,
              lineTotal: item.lineTotal,
            })),
          },
        },
      });

      if (data.leadId) {
        await prisma.leadActivity.create({
          data: {
            leadId: data.leadId,
            type: "QUOTATION_CREATED",
            description: `Quotation ${quotationNumber} created.`,
            createdById: user.id,
          },
        });
      }

      revalidatePath("/quotations");
      if (data.customerId) revalidatePath(`/customers/${data.customerId}`);
      if (data.leadId) revalidatePath(`/leads/${data.leadId}`);
      revalidatePath("/dashboard");

      await logAudit({
        userId: user.id,
        action: "CREATE",
        entityType: "Quotation",
        entityId: quotation.id,
        newValue: { quotationNumber, totalAmount: totals.totalAmount },
      });

      return { success: true, id: quotation.id };
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 2) continue;
      throw err;
    }
  }
  return { error: "Could not create quotation. Please try again." };
}

export async function updateQuotation(
  quotationId: string,
  input: QuotationFormInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "quotations", "write");
  const parsed = quotationFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.quotation.findFirst({
    where: { id: quotationId, ...scopeWhere(scope, user, "createdById") },
  });
  if (!existing) return { error: "Quotation not found or access denied." };
  if (existing.status !== "DRAFT") {
    return { error: "Only draft quotations can be edited." };
  }

  try {
    await assertTargetInScope(user, data.customerId, data.leadId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Access denied." };
  }

  let totals;
  try {
    totals = await computeTotals(data.items, data.discountPercent, data.freightAmount);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not price this quotation." };
  }

  await prisma.$transaction([
    prisma.quotationItem.deleteMany({ where: { quotationId } }),
    prisma.quotation.update({
      where: { id: quotationId },
      data: {
        customerId: data.customerId,
        leadId: data.leadId,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        subtotal: totals.subtotal,
        discountPercent: data.discountPercent,
        discountAmount: totals.discountAmount,
        freightAmount: data.freightAmount,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
        termsAndConditions: data.termsAndConditions,
        notes: data.notes,
        items: {
          create: totals.computedItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountPercent: item.discountPercent,
            lineTotal: item.lineTotal,
          })),
        },
      },
    }),
  ]);

  revalidatePath("/quotations");
  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Quotation",
    entityId: quotationId,
    oldValue: { totalAmount: existing.totalAmount },
    newValue: { totalAmount: totals.totalAmount },
  });

  return { success: true };
}

export async function updateQuotationStatus(
  quotationId: string,
  input: QuotationStatusInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "quotations", "write");
  const parsed = quotationStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { status } = parsed.data;

  const existing = await prisma.quotation.findFirst({
    where: { id: quotationId, ...scopeWhere(scope, user, "createdById") },
    include: { items: true, customer: true },
  });
  if (!existing) return { error: "Quotation not found or access denied." };

  let createdOrderId: string | null = null;

  if (status === "ACCEPTED") {
    if (!existing.customerId || !existing.customer) {
      return {
        error: "Convert the lead to a customer before accepting this quotation.",
      };
    }
    if (existing.status !== "SENT") {
      return { error: "Only sent quotations can be accepted." };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const orderNumber = await generateOrderNumber();
        const [, order] = await prisma.$transaction([
          prisma.quotation.update({
            where: { id: quotationId },
            data: { status: "ACCEPTED", respondedAt: new Date() },
          }),
          prisma.order.create({
            data: {
              orderNumber,
              quotationId,
              customerId: existing.customerId!,
              leadId: existing.leadId,
              totalAmount: existing.totalAmount,
              state: existing.customer.state,
              district: existing.customer.district,
              createdById: user.id,
            },
          }),
        ]);
        createdOrderId = order.id;
        break;
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < 2) continue;
        throw err;
      }
    }
  } else {
    const data: { status: typeof status; sentAt?: Date; respondedAt?: Date } = { status };
    if (status === "SENT") data.sentAt = new Date();
    if (status === "REJECTED") data.respondedAt = new Date();
    await prisma.quotation.update({ where: { id: quotationId }, data });
  }

  await logAudit({
    userId: user.id,
    action: "STATUS_CHANGE",
    entityType: "Quotation",
    entityId: quotationId,
    oldValue: { status: existing.status },
    newValue: { status, orderId: createdOrderId },
  });

  if (existing.leadId) {
    await prisma.leadActivity.create({
      data: {
        leadId: existing.leadId,
        type: status === "SENT" ? "QUOTATION_SENT" : "STATUS_CHANGE",
        description: `Quotation ${existing.quotationNumber} marked ${status}.`,
        createdById: user.id,
      },
    });
  }

  if (existing.createdById !== user.id) {
    await notifyUser({
      userId: existing.createdById,
      actingUserId: user.id,
      type: "QUOTATION_RESPONSE",
      title: `Quotation ${existing.quotationNumber} ${status.toLowerCase()}`,
      body: `${user.name} marked quotation ${existing.quotationNumber} as ${status}.`,
      relatedCustomerId: existing.customerId ?? undefined,
      relatedLeadId: existing.leadId ?? undefined,
    });
  }

  revalidatePath("/quotations");
  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath("/dashboard");
  if (existing.customerId) revalidatePath(`/customers/${existing.customerId}`);
  return { success: true };
}
