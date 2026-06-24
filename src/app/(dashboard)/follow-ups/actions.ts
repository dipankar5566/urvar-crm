"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import {
  followUpCreateSchema,
  followUpRescheduleSchema,
  type FollowUpCreateInput,
  type FollowUpRescheduleInput,
} from "@/lib/validations/followup";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

export async function createFollowUp(
  leadId: string,
  input: FollowUpCreateInput,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "followups", "write");
  const parsed = followUpCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const leadScope = can(user.role, "leads", "read");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(leadScope, user, "assignedToId") },
  });
  if (!lead) return { error: "Lead not found or access denied." };

  const followUp = await prisma.followUp.create({
    data: {
      leadId,
      assignedToId: user.id,
      dueAt: new Date(data.dueAt),
      priority: data.priority as never,
      notes: data.notes,
    },
  });

  await prisma.leadActivity.create({
    data: {
      leadId,
      type: "FOLLOWUP_LOGGED",
      description: `Follow-up scheduled for ${new Date(data.dueAt).toLocaleDateString()}.`,
      createdById: user.id,
    },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "FollowUp",
    entityId: followUp.id,
    newValue: { leadId, dueAt: data.dueAt, priority: data.priority },
  });

  return { success: true, id: followUp.id };
}

export async function completeFollowUp(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "followups", "write");

  const existing = await prisma.followUp.findFirst({
    where: { id, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Follow-up not found or access denied." };

  await prisma.followUp.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  if (existing.leadId) {
    await prisma.leadActivity.create({
      data: {
        leadId: existing.leadId,
        type: "FOLLOWUP_COMPLETED",
        description: "Follow-up marked complete.",
        createdById: user.id,
      },
    });
    revalidatePath(`/leads/${existing.leadId}`);
  }

  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "COMPLETE",
    entityType: "FollowUp",
    entityId: id,
  });

  return { success: true };
}

export async function cancelFollowUp(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "followups", "write");

  const existing = await prisma.followUp.findFirst({
    where: { id, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Follow-up not found or access denied." };

  await prisma.followUp.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");
  if (existing.leadId) revalidatePath(`/leads/${existing.leadId}`);

  await logAudit({
    userId: user.id,
    action: "CANCEL",
    entityType: "FollowUp",
    entityId: id,
  });

  return { success: true };
}

export async function rescheduleFollowUp(
  id: string,
  input: FollowUpRescheduleInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "followups", "write");
  const parsed = followUpRescheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const existing = await prisma.followUp.findFirst({
    where: { id, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Follow-up not found or access denied." };

  const [, created] = await prisma.$transaction([
    prisma.followUp.update({
      where: { id },
      data: { status: "RESCHEDULED" },
    }),
    prisma.followUp.create({
      data: {
        leadId: existing.leadId,
        customerId: existing.customerId,
        assignedToId: existing.assignedToId,
        priority: existing.priority,
        dueAt: new Date(parsed.data.dueAt),
        notes: existing.notes,
      },
    }),
  ]);

  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");
  if (existing.leadId) revalidatePath(`/leads/${existing.leadId}`);

  await logAudit({
    userId: user.id,
    action: "RESCHEDULE",
    entityType: "FollowUp",
    entityId: id,
    oldValue: { dueAt: existing.dueAt },
    newValue: { dueAt: parsed.data.dueAt, newFollowUpId: created.id },
  });

  return { success: true, id: created.id };
}
