"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { canBulkImport } from "@/lib/permissions";
import { leadFormSchema, type LeadFormValues } from "@/lib/validations/lead";
import { insertLeadRecord } from "@/app/(dashboard)/leads/actions";
import { logAudit } from "@/lib/audit";
import {
  buildRowInput,
  type ColumnMapping,
  type ValueMapping,
} from "@/lib/lead-import";

export type RowVerdict =
  | { rowIndex: number; status: "READY"; name: string; phone: string }
  | { rowIndex: number; status: "MISSING_FIELD"; reason: string }
  | { rowIndex: number; status: "DUPLICATE"; reason: string };

function assertImportRole(role: string) {
  if (!canBulkImport(role as never)) {
    throw new Error("Only Super Admin or Sales Manager can bulk-import leads.");
  }
}

async function evaluateRows(
  rawRows: Record<string, string>[],
  columnMapping: ColumnMapping,
  valueMapping: ValueMapping,
): Promise<{ verdicts: RowVerdict[]; readyData: Map<number, LeadFormValues> }> {
  const candidates = rawRows.map((raw) => buildRowInput(raw, columnMapping, valueMapping));
  const phonesToCheck = candidates
    .map((c) => c.phone)
    .filter((p): p is string => !!p);

  const [existingLeads, existingCustomers] = await Promise.all([
    phonesToCheck.length
      ? prisma.lead.findMany({
          where: { phone: { in: phonesToCheck } },
          select: { phone: true, leadNumber: true },
        })
      : Promise.resolve([]),
    phonesToCheck.length
      ? prisma.customer.findMany({
          where: { phone: { in: phonesToCheck } },
          select: { phone: true, customerNumber: true },
        })
      : Promise.resolve([]),
  ]);
  const leadByPhone = new Map(existingLeads.map((l) => [l.phone, l.leadNumber]));
  const customerByPhone = new Map(existingCustomers.map((c) => [c.phone, c.customerNumber]));
  const seenPhones = new Set<string>();

  const verdicts: RowVerdict[] = [];
  const readyData = new Map<number, LeadFormValues>();

  candidates.forEach((input, rowIndex) => {
    const phone = input.phone;
    if (phone && leadByPhone.has(phone)) {
      verdicts.push({
        rowIndex,
        status: "DUPLICATE",
        reason: `Matches existing lead ${leadByPhone.get(phone)}`,
      });
      return;
    }
    if (phone && customerByPhone.has(phone)) {
      verdicts.push({
        rowIndex,
        status: "DUPLICATE",
        reason: `Matches existing customer ${customerByPhone.get(phone)}`,
      });
      return;
    }
    if (phone && seenPhones.has(phone)) {
      verdicts.push({
        rowIndex,
        status: "DUPLICATE",
        reason: "Duplicate phone number elsewhere in this file",
      });
      return;
    }

    const parsed = leadFormSchema.safeParse(input);
    if (!parsed.success) {
      verdicts.push({
        rowIndex,
        status: "MISSING_FIELD",
        reason: parsed.error.issues[0]?.message ?? "Invalid row",
      });
      return;
    }

    if (phone) seenPhones.add(phone);
    readyData.set(rowIndex, parsed.data);
    verdicts.push({ rowIndex, status: "READY", name: parsed.data.name, phone: parsed.data.phone });
  });

  return { verdicts, readyData };
}

export async function validateImportRows(
  rawRows: Record<string, string>[],
  columnMapping: ColumnMapping,
  valueMapping: ValueMapping,
): Promise<{ verdicts: RowVerdict[] } | { error: string }> {
  const user = await requireUser();
  try {
    assertImportRole(user.role);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const { verdicts } = await evaluateRows(rawRows, columnMapping, valueMapping);
  return { verdicts };
}

export async function commitImport(
  rawRows: Record<string, string>[],
  columnMapping: ColumnMapping,
  valueMapping: ValueMapping,
): Promise<
  | { createdCount: number; skippedCount: number; errors: { rowIndex: number; reason: string }[] }
  | { error: string }
> {
  const user = await requireUser();
  try {
    assertImportRole(user.role);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const { verdicts, readyData } = await evaluateRows(rawRows, columnMapping, valueMapping);

  let createdCount = 0;
  const errors: { rowIndex: number; reason: string }[] = [];

  for (const verdict of verdicts) {
    if (verdict.status !== "READY") continue;
    const data = readyData.get(verdict.rowIndex);
    if (!data) continue;
    try {
      await insertLeadRecord(data, null, user.id);
      createdCount++;
    } catch {
      errors.push({ rowIndex: verdict.rowIndex, reason: "Could not create this lead." });
    }
  }

  await logAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Lead",
    entityId: "BULK_IMPORT",
    newValue: { createdCount, totalRows: rawRows.length },
  });

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");

  return { createdCount, skippedCount: rawRows.length - createdCount, errors };
}
