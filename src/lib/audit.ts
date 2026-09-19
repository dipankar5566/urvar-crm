import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

type AuditInput = {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
};

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Write an audit row.
 *
 * `db` lets a caller pass the transaction client it is already inside, so the
 * audit row commits or rolls back with the change it describes. Financial
 * postings always do this: an audit trail that can be missing the entry it
 * was meant to record is not an audit trail. The default keeps the ~35
 * existing CRM call sites working unchanged, where a standalone write is
 * acceptable because the business record is the source of truth anyway.
 */
export async function logAudit(input: AuditInput, db: Db = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      oldValue: toJsonSafe(input.oldValue) as never,
      newValue: toJsonSafe(input.newValue) as never,
      ipAddress: input.ipAddress ?? null,
    },
  });
}
