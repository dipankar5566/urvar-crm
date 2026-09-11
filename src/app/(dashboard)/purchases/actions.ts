"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { assertUploadAllowed, saveDocument, UploadRejected } from "@/lib/documents";
import { extractFromDocument, SarvamVisionError, type ExtractField } from "@/lib/sarvam-vision";

/**
 * Supplier invoice intake.
 *
 * The procurement side of the Sarvam Vision work: photograph or scan a
 * supplier's invoice and have its header and line items read out rather than
 * retyped. As everywhere else in this feature, extraction only proposes — a
 * person checks the numbers before anything is recorded, because a misread
 * quantity or rate here becomes a wrong cost figure.
 */

const INVOICE_FIELDS: ExtractField[] = [
  { name: "supplierName", description: "Name of the supplier or vendor issuing this invoice" },
  { name: "supplierGst", description: "The supplier's GST identification number" },
  { name: "supplierPhone", description: "The supplier's contact phone number" },
  { name: "invoiceNumber", description: "The invoice number printed on the document" },
  { name: "invoiceDate", description: "Invoice date in YYYY-MM-DD format" },
  { name: "subtotal", description: "Subtotal before tax, digits only" },
  { name: "taxAmount", description: "Total tax or GST amount, digits only" },
  { name: "totalAmount", description: "Final invoice total payable, digits only" },
  {
    name: "lineItems",
    description:
      "Every product line on the invoice as a JSON array. Each element must be an object with keys: description, quantity, unitPrice, lineTotal. Use digits only for the three numeric values.",
  },
];

export type ExtractedLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type ExtractedInvoice = {
  supplierName: string;
  supplierGst: string;
  supplierPhone: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  lines: ExtractedLine[];
  fileId: string;
};

const PLACEHOLDER = /^(n\/?a|none|nil|not (mentioned|provided|given|specified|available)|unknown|-+)$/i;

function text(value: unknown): string {
  if (value === null || value === undefined || typeof value === "object") return "";
  const trimmed = String(value).trim();
  return PLACEHOLDER.test(trimmed) ? "" : trimmed;
}

/** Amounts come back as "₹ 1,23,456.00", "1234.56" or a number. */
function money(value: unknown): number {
  const cleaned = text(value).replace(/[^\d.]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Line items may arrive as a real array or as a JSON string. */
function parseLines(value: unknown): ExtractedLine[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        description: text(row.description),
        quantity: money(row.quantity),
        unitPrice: money(row.unitPrice),
        lineTotal: money(row.lineTotal),
      };
    })
    .filter((line) => line.description !== "");
}

/** Reads a supplier invoice and returns what it says, recording nothing yet. */
export async function extractInvoiceAction(
  formData: FormData,
): Promise<{ invoice: ExtractedInvoice } | { error: string }> {
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file uploaded." };

  try {
    assertUploadAllowed(file);
  } catch (err) {
    if (err instanceof UploadRejected) return { error: err.message };
    throw err;
  }

  let fields: Record<string, unknown>;
  try {
    ({ fields } = await extractFromDocument(file, INVOICE_FIELDS));
  } catch (err) {
    if (err instanceof SarvamVisionError) return { error: err.message };
    console.error("Invoice extraction failed", err);
    return { error: "Could not read that invoice. Try a clearer scan or a PDF." };
  }

  // Stored now, attached to the invoice on save. Kept even if the user
  // abandons the form — an unattached file is unreachable through
  // /api/documents, so it leaks nothing.
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

  return {
    invoice: {
      supplierName: text(fields.supplierName),
      supplierGst: text(fields.supplierGst),
      supplierPhone: text(fields.supplierPhone),
      invoiceNumber: text(fields.invoiceNumber),
      invoiceDate: text(fields.invoiceDate),
      subtotal: money(fields.subtotal),
      taxAmount: money(fields.taxAmount),
      totalAmount: money(fields.totalAmount),
      lines: parseLines(fields.lineItems),
      fileId: record.id,
    },
  };
}

export type SaveInvoiceInput = {
  supplierName: string;
  supplierGst?: string;
  supplierPhone?: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  lines: ExtractedLine[];
  fileId?: string;
};

/** Next code in the SUP-0001 sequence, matching the leadNumber convention. */
async function nextSupplierCode(): Promise<string> {
  const latest = await prisma.supplier.findFirst({
    orderBy: { supplierCode: "desc" },
    select: { supplierCode: true },
  });
  const current = Number.parseInt(latest?.supplierCode.replace(/\D/g, "") ?? "0", 10);
  return `SUP-${String(current + 1).padStart(4, "0")}`;
}

export async function createPurchaseInvoice(
  input: SaveInvoiceInput,
): Promise<{ invoiceId: string } | { error: string }> {
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  const supplierName = input.supplierName.trim();
  if (!supplierName) return { error: "Supplier name is required." };
  if (!input.invoiceNumber.trim()) return { error: "Invoice number is required." };

  const invoiceDate = new Date(input.invoiceDate);
  if (Number.isNaN(invoiceDate.getTime())) return { error: "Enter a valid invoice date." };

  const lines = input.lines.filter((l) => l.description.trim() !== "");
  if (lines.length === 0) return { error: "Add at least one line item." };

  // Match an existing supplier by name before creating another. Invoices are
  // captured one at a time over months, so without this the same supplier
  // accumulates a duplicate record per invoice.
  const existing = await prisma.supplier.findFirst({
    where: { name: { equals: supplierName, mode: "insensitive" } },
    select: { id: true },
  });
  const supplierId =
    existing?.id ??
    (
      await prisma.supplier.create({
        data: {
          supplierCode: await nextSupplierCode(),
          name: supplierName,
          gstNumber: input.supplierGst?.trim() || null,
          phone: input.supplierPhone?.trim() || null,
          createdById: user.id,
        },
        select: { id: true },
      })
    ).id;

  try {
    const invoice = await prisma.purchaseInvoice.create({
      data: {
        invoiceNumber: input.invoiceNumber.trim(),
        supplierId,
        invoiceDate,
        subtotal: input.subtotal,
        taxAmount: input.taxAmount,
        totalAmount: input.totalAmount,
        createdById: user.id,
        items: {
          create: lines.map((line) => ({
            description: line.description.trim(),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        },
      },
      select: { id: true },
    });

    if (input.fileId) {
      await prisma.file.updateMany({
        where: { id: input.fileId, uploadedById: user.id, relatedPurchaseInvoiceId: null },
        data: { relatedPurchaseInvoiceId: invoice.id },
      });
    }

    await logAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "PurchaseInvoice",
      entityId: invoice.id,
      newValue: {
        invoiceNumber: input.invoiceNumber,
        supplierName,
        totalAmount: input.totalAmount,
        lineCount: lines.length,
      },
    });

    revalidatePath("/purchases");
    return { invoiceId: invoice.id };
  } catch (err) {
    // The @@unique([supplierId, invoiceNumber]) guard — the likeliest
    // mistake when invoices are captured by photographing them.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { error: "That invoice number is already recorded for this supplier." };
    }
    throw err;
  }
}
