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
import { extractLeadFromDocument } from "@/lib/lead-document-extract";
import { assertUploadAllowed, saveDocument, UploadRejected } from "@/lib/documents";
import { SarvamVisionError } from "@/lib/sarvam-vision";

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
      // Deleted records don't block a re-import: their phone number is free
      // to use again, which is the point of having deleted them.
      ? prisma.lead.findMany({
          where: { phone: { in: phonesToCheck }, deletedAt: null },
          select: { phone: true, leadNumber: true },
        })
      : Promise.resolve([]),
    phonesToCheck.length
      ? prisma.customer.findMany({
          where: { phone: { in: phonesToCheck }, deletedAt: null },
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

export type DocumentExtractResult =
  | { row: Record<string, string>; fileId: string; pagesProcessed: number | null }
  | { error: string };

/**
 * Reads one enquiry document and returns a candidate lead row.
 *
 * The row is deliberately NOT written anywhere. It goes back to the wizard
 * and through the same validate-and-confirm path a spreadsheet row takes,
 * because extraction from a photograph of handwriting is wrong often enough
 * that a human has to see it first.
 *
 * The document itself IS stored, so a rep can check the original against
 * what was captured.
 */
export async function extractLeadFromDocumentAction(formData: FormData): Promise<DocumentExtractResult> {
  const user = await requireUser();
  try {
    assertImportRole(user.role);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file uploaded." };

  try {
    assertUploadAllowed(file);
  } catch (err) {
    if (err instanceof UploadRejected) return { error: err.message };
    throw err;
  }

  let extracted: Awaited<ReturnType<typeof extractLeadFromDocument>>;
  try {
    extracted = await extractLeadFromDocument(file);
  } catch (err) {
    if (err instanceof SarvamVisionError) return { error: err.message };
    console.error("Document extraction failed", err);
    return { error: "Could not read that document. Try a clearer photo or a PDF." };
  }

  // Stored only after extraction succeeds, so a failed read doesn't leave an
  // orphaned file on disk. The row is created first so its id names the file
  // and the two can never drift apart.
  const record = await prisma.file.create({
    data: {
      fileName: file.name,
      filePath: "",
      mimeType: file.type,
      sizeBytes: file.size,
      category: "ATTACHMENT",
      uploadedById: user.id,
    },
    select: { id: true },
  });
  const filePath = await saveDocument(record.id, file.type, Buffer.from(await file.arrayBuffer()));
  await prisma.file.update({ where: { id: record.id }, data: { filePath } });

  return { row: extracted.row, fileId: record.id, pagesProcessed: extracted.pagesProcessed };
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
  /** Document this row came from, when the source was a scan rather than a
   * spreadsheet. Attaching it to the created lead is what makes it readable
   * afterwards: /api/documents denies any file that isn't reachable through
   * a record the caller can see, so an unattached upload stays invisible. */
  attachFileId?: string,
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
  let firstCreatedLeadId: string | null = null;
  const errors: { rowIndex: number; reason: string }[] = [];

  for (const verdict of verdicts) {
    if (verdict.status !== "READY") continue;
    const data = readyData.get(verdict.rowIndex);
    if (!data) continue;
    try {
      const lead = await insertLeadRecord(data, null, user.id);
      firstCreatedLeadId ??= lead.id;
      createdCount++;
    } catch {
      errors.push({ rowIndex: verdict.rowIndex, reason: "Could not create this lead." });
    }
  }

  if (attachFileId && firstCreatedLeadId) {
    // Scoped to this user's own upload so a guessed id can't attach someone
    // else's document to a lead. updateMany rather than update because a
    // mismatch should be a silent no-op, not a crash after leads were made.
    await prisma.file.updateMany({
      where: { id: attachFileId, uploadedById: user.id, relatedLeadId: null },
      data: { relatedLeadId: firstCreatedLeadId },
    });
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
