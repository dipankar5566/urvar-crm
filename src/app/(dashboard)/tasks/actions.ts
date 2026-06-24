"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, scopeWhere } from "@/lib/permissions";
import { taskCreateSchema, type TaskCreateInput } from "@/lib/validations/task";
import { notifyUser } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

export async function createTask(
  input: TaskCreateInput,
  relatedLeadId?: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "tasks", "write");
  const parsed = taskCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  if (data.assignedToId !== user.id && scope !== "all") {
    return { error: "You cannot assign tasks to other users." };
  }

  const task = await prisma.task.create({
    data: {
      title: data.title,
      description: data.description,
      assignedToId: data.assignedToId,
      assignedById: user.id,
      relatedLeadId: relatedLeadId ?? null,
      priority: data.priority as never,
      dueAt: data.dueAt ? new Date(data.dueAt) : null,
    },
  });

  if (relatedLeadId) {
    await prisma.leadActivity.create({
      data: {
        leadId: relatedLeadId,
        type: "TASK_CREATED",
        description: `Task created: ${data.title}`,
        createdById: user.id,
      },
    });
    revalidatePath(`/leads/${relatedLeadId}`);
  }

  revalidatePath("/tasks");
  revalidatePath("/dashboard");

  await notifyUser({
    userId: data.assignedToId,
    actingUserId: user.id,
    type: "TASK_ASSIGNED",
    title: `New task: ${data.title}`,
    body: `${user.name} assigned you a task.`,
    relatedLeadId,
  });

  await logAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Task",
    entityId: task.id,
    newValue: { title: data.title, assignedToId: data.assignedToId },
  });

  return { success: true, id: task.id };
}

export async function updateTaskStatus(
  id: string,
  status: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "tasks", "write");

  const existing = await prisma.task.findFirst({
    where: { id, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Task not found or access denied." };

  await prisma.task.update({
    where: { id },
    data: {
      status: status as never,
      completedAt: status === "DONE" ? new Date() : null,
    },
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (existing.relatedLeadId) revalidatePath(`/leads/${existing.relatedLeadId}`);

  await logAudit({
    userId: user.id,
    action: "STATUS_CHANGE",
    entityType: "Task",
    entityId: id,
    oldValue: { status: existing.status },
    newValue: { status },
  });

  return { success: true };
}
