"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, scopeWhere } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { assertUploadAllowed, saveDocument, documentUrl, UploadRejected } from "@/lib/documents";
import { extractFromDocument, SarvamVisionError, type ExtractField } from "@/lib/sarvam-vision";

/**
 * Attaching a document to an existing lead, and offering what it says as
 * suggested edits.
 *
 * The hard rule here is that extraction never writes to the lead. A scan of
 * handwriting will sometimes read a number wrong, and silently replacing a
 * good value with a bad one is far worse than extracting nothing at all. So
 * this returns suggestions, the rep picks which to accept, and a separate
 * action applies only those.
 */

/** Only fields where a document is a plausible source of truth. Notably not
 * name or phone: those identify the lead, and overwriting them from a scan
 * could silently repoint a record at a different person. */
const SUGGESTABLE = [
  "companyName",
  "contactPerson",
  "email",
  "district",
  "pincode",
  "address",
  "interestedProducts",
  "expectedQuantity",
  "cropInterest",
  "remarks",
] as const;

type SuggestableField = (typeof SUGGESTABLE)[number];

const DOCUMENT_FIELDS: ExtractField[] = [
  { name: "companyName", description: "Company, firm, shop or FPO name" },
  { name: "contactPerson", description: "Named contact person at the company" },
  { name: "email", description: "Email address" },
  { name: "district", description: "District within the state" },
  { name: "pincode", description: "Six digit postal PIN code" },
  { name: "address", description: "Street or village address" },
  { name: "interestedProducts", description: "Fertiliser or agri-input products mentioned" },
  { name: "expectedQuantity", description: "Quantity required, including the unit" },
  { name: "cropInterest", description: "Crops mentioned" },
  { name: "remarks", description: "Other notes, requirements or timing mentioned" },
];

const PLACEHOLDER = /^(n\/?a|none|nil|not (mentioned|provided|given|specified|available)|unknown|-+)$/i;

export type FieldSuggestion = {
  field: SuggestableField;
  /** What the document says. */
  suggested: string;
  /** What the lead says today, so the rep can see what would change. */
  current: string | null;
};

export type AttachResult =
  | { fileId: string; fileUrl: string; suggestions: FieldSuggestion[] }
  | { error: string };

async function loadWritableLead(leadId: string) {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null, ...scopeWhere(scope, user, "assignedToId") },
  });
  return { user, lead };
}

/** Uploads a document against a lead and reads suggestions out of it. */
export async function attachLeadDocument(leadId: string, formData: FormData): Promise<AttachResult> {
  const { user, lead } = await loadWritableLead(leadId);
  if (!lead) return { error: "Lead not found or access denied." };

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file uploaded." };

  try {
    assertUploadAllowed(file);
  } catch (err) {
    if (err instanceof UploadRejected) return { error: err.message };
    throw err;
  }

  let extracted: Record<string, unknown>;
  try {
    ({ fields: extracted } = await extractFromDocument(file, DOCUMENT_FIELDS));
  } catch (err) {
    if (err instanceof SarvamVisionError) return { error: err.message };
    console.error("Lead document extraction failed", err);
    return { error: "Could not read that document. Try a clearer photo or a PDF." };
  }

  const record = await prisma.file.create({
    data: {
      fileName: file.name,
      filePath: "",
      mimeType: file.type,
      sizeBytes: file.size,
      category: "ATTACHMENT",
      relatedLeadId: lead.id,
      uploadedById: user.id,
    },
    select: { id: true },
  });
  const filePath = await saveDocument(record.id, file.type, Buffer.from(await file.arrayBuffer()));
  await prisma.file.update({ where: { id: record.id }, data: { filePath } });

  const current = lead as unknown as Record<string, string | null>;
  const suggestions: FieldSuggestion[] = [];
  for (const field of SUGGESTABLE) {
    const raw = extracted[field];
    if (raw === null || raw === undefined || typeof raw === "object") continue;
    const suggested = String(raw).trim();
    if (suggested === "" || PLACEHOLDER.test(suggested)) continue;
    // Nothing to suggest if the lead already says exactly this.
    if ((current[field] ?? "") === suggested) continue;
    suggestions.push({ field, suggested, current: current[field] ?? null });
  }

  revalidatePath(`/leads/${leadId}`);
  return { fileId: record.id, fileUrl: documentUrl(record.id), suggestions };
}

/**
 * Applies the suggestions the rep ticked. Nothing else is touched — the
 * payload is filtered against SUGGESTABLE server-side rather than trusted,
 * so a crafted request cannot reach `phone`, `assignedToId` or anything
 * outside that list.
 */
export async function applyExtractedFields(
  leadId: string,
  accepted: Record<string, string>,
): Promise<{ updatedCount: number } | { error: string }> {
  const { user, lead } = await loadWritableLead(leadId);
  if (!lead) return { error: "Lead not found or access denied." };

  const data: Record<string, string> = {};
  for (const field of SUGGESTABLE) {
    const value = accepted[field];
    if (typeof value === "string" && value.trim() !== "") data[field] = value.trim();
  }
  if (Object.keys(data).length === 0) return { updatedCount: 0 };

  const before = lead as unknown as Record<string, unknown>;
  await prisma.lead.update({ where: { id: lead.id }, data });

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Lead",
    entityId: lead.id,
    oldValue: Object.fromEntries(Object.keys(data).map((k) => [k, before[k] ?? null])),
    newValue: { ...data, source: "document-extraction" },
  });

  revalidatePath(`/leads/${leadId}`);
  return { updatedCount: Object.keys(data).length };
}

/** Documents already attached to this lead, for the detail page. */
export async function listLeadDocuments(leadId: string) {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "read");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null, ...scopeWhere(scope, user, "assignedToId") },
    select: { id: true },
  });
  if (!lead) return [];

  const files = await prisma.file.findMany({
    where: { relatedLeadId: lead.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
  return files.map((f) => ({ ...f, url: documentUrl(f.id) }));
}
