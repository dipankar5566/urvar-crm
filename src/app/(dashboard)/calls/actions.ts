"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { callLogSchema, type CallLogInput } from "@/lib/validations/call";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

export async function logCall(
  leadId: string,
  input: CallLogInput,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "calls", "write");
  const parsed = callLogSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const leadScope = can(user.role, "leads", "read");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(leadScope, user, "assignedToId") },
  });
  if (!lead) return { error: "Lead not found or access denied." };

  const call = await prisma.call.create({
    data: {
      leadId,
      userId: user.id,
      direction: data.direction as never,
      outcome: data.outcome as never,
      durationSeconds: data.durationSeconds,
      notes: data.notes,
    },
  });

  await prisma.leadActivity.create({
    data: {
      leadId,
      type: "CALL_LOGGED",
      description: `${data.direction === "INBOUND" ? "Inbound" : "Outbound"} call — ${data.outcome.replaceAll("_", " ")}.`,
      createdById: user.id,
    },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/calls");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Call",
    entityId: call.id,
    newValue: { leadId, direction: data.direction, outcome: data.outcome },
  });

  return { success: true, id: call.id };
}
