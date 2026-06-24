import { prisma } from "@/lib/prisma";

type AuditInput = {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
};

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export async function logAudit(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      oldValue: toJsonSafe(input.oldValue) as never,
      newValue: toJsonSafe(input.newValue) as never,
    },
  });
}
