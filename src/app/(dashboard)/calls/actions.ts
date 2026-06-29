"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { callLogSchema, type CallLogInput } from "@/lib/validations/call";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

export async function logCall(
  target: { leadId: string } | { customerId: string },
  input: CallLogInput,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "calls", "write");
  const parsed = callLogSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  if ("leadId" in target) {
    const leadScope = can(user.role, "leads", "read");
    const lead = await prisma.lead.findFirst({
      where: { id: target.leadId, ...scopeWhere(leadScope, user, "assignedToId") },
    });
    if (!lead) return { error: "Lead not found or access denied." };

    const call = await prisma.call.create({
      data: {
        leadId: target.leadId,
        userId: user.id,
        direction: data.direction as never,
        outcome: data.outcome as never,
        durationSeconds: data.durationSeconds,
        notes: data.notes,
      },
    });

    await prisma.leadActivity.create({
      data: {
        leadId: target.leadId,
        type: "CALL_LOGGED",
        description: `${data.direction === "INBOUND" ? "Inbound" : "Outbound"} call — ${data.outcome.replaceAll("_", " ")}.`,
        createdById: user.id,
      },
    });

    revalidatePath(`/leads/${target.leadId}`);
    revalidatePath("/calls");
    revalidatePath("/dashboard");

    await logAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "Call",
      entityId: call.id,
      newValue: { leadId: target.leadId, direction: data.direction, outcome: data.outcome },
    });

    return { success: true, id: call.id };
  }

  const customerScope = can(user.role, "customers", "read");
  const customer = await prisma.customer.findFirst({
    where: { id: target.customerId, ...scopeWhere(customerScope, user, "assignedToId") },
  });
  if (!customer) return { error: "Customer not found or access denied." };

  const call = await prisma.call.create({
    data: {
      customerId: target.customerId,
      userId: user.id,
      direction: data.direction as never,
      outcome: data.outcome as never,
      durationSeconds: data.durationSeconds,
      notes: data.notes,
    },
  });

  revalidatePath(`/customers/${target.customerId}`);
  revalidatePath("/calls");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Call",
    entityId: call.id,
    newValue: { customerId: target.customerId, direction: data.direction, outcome: data.outcome },
  });

  return { success: true, id: call.id };
}
