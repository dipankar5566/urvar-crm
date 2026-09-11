/**
 * Turns a photographed or scanned enquiry document into one candidate lead
 * row, shaped exactly like a row parsed from a spreadsheet.
 *
 * That shape is the whole point. The spreadsheet importer already solves the
 * hard parts — duplicate-phone detection against both leads and customers,
 * Zod validation, re-checking server-side rather than trusting the client,
 * and a preview the user confirms before anything is written. Producing the
 * same `Record<string, string>` lets a document ride that path instead of
 * growing a second, less careful one.
 *
 * Because the keys we ask Sarvam for are the importer's own field names, the
 * column mapping is the identity map — there is no header-guessing step for
 * documents, unlike a spreadsheet whose columns could be called anything.
 */
import { extractFromDocument, type ExtractField } from "./sarvam-vision";
import { IMPORT_FIELD_DEFS, type ColumnMapping, type ImportTargetField } from "./lead-import";

/**
 * What to look for. Descriptions are the only instruction the model gets, so
 * they carry the domain knowledge: that this is an Indian agri-input
 * business, that phone numbers are ten digits, that "quantity" means
 * fertiliser volume rather than a line count.
 *
 * Deliberately narrower than IMPORT_TARGET_FIELDS: the money estimates
 * (expectedMonthlyValue, estimatedValue) and the enum fields (source,
 * customerType) are left out. A model guessing a rupee figure off a
 * handwritten form would be inventing revenue data, and the enums are better
 * set by the rep than inferred.
 */
const DOCUMENT_FIELDS: ExtractField[] = [
  { name: "name", description: "Full name of the person or farmer making the enquiry" },
  { name: "phone", description: "Their primary contact phone number. Indian mobile, 10 digits, no country code or spaces" },
  { name: "whatsapp", description: "A WhatsApp number, only if given separately from the main phone number" },
  { name: "companyName", description: "Company, firm, shop or FPO name, if any" },
  { name: "contactPerson", description: "A named contact person at the company, if different from the main name" },
  { name: "email", description: "Email address, if given" },
  { name: "state", description: "Indian state, e.g. West Bengal" },
  { name: "district", description: "District within the state, e.g. Nadia" },
  { name: "pincode", description: "Six digit postal PIN code" },
  { name: "address", description: "Street or village address" },
  { name: "interestedProducts", description: "Fertiliser or agri-input products they are interested in" },
  { name: "expectedQuantity", description: "How much product they need, including the unit, e.g. 5 tons per month" },
  { name: "cropInterest", description: "Crops they grow or are asking about, e.g. paddy, jute" },
  { name: "remarks", description: "Any other notes, requirements or timing mentioned" },
];

/**
 * Documents are extracted straight into the importer's own field names, so
 * each target field maps to the identically-named key.
 */
export const DOCUMENT_COLUMN_MAPPING: ColumnMapping = Object.fromEntries(
  IMPORT_FIELD_DEFS.map((def) => [def.key, def.key]),
) as ColumnMapping;

/** Field names we asked for, so the UI can show what was and wasn't found. */
export const DOCUMENT_EXTRACT_FIELDS: ImportTargetField[] = DOCUMENT_FIELDS.map(
  (f) => f.name as ImportTargetField,
);

/** Phone numbers arrive as "+91 98765 43210", "9876543210 " and worse. The
 * CRM stores plain 10-digit Indian mobile numbers (see validations/lead.ts),
 * so normalise here rather than failing validation on formatting. */
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Models often fill a blank field with "N/A" or "not mentioned" rather than
 * omitting it. Those would otherwise pass validation as real values. */
const PLACEHOLDER = /^(n\/?a|none|nil|not (mentioned|provided|given|specified|available)|unknown|-+)$/i;

/**
 * Extracts one candidate lead row from a document.
 *
 * Returns values as strings keyed by import field name — the same shape a
 * spreadsheet row arrives in — so it can be handed straight to
 * validateImportRows/commitImport.
 */
export async function extractLeadFromDocument(
  file: File,
  language = "en-IN",
): Promise<{ row: Record<string, string>; pagesProcessed: number | null }> {
  const { fields, pagesProcessed } = await extractFromDocument(file, DOCUMENT_FIELDS, language);

  const row: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    // Extraction can return numbers or nested objects; the importer expects
    // flat strings, and a stringified object is worse than nothing.
    if (typeof value === "object") continue;

    const text = String(value).trim();
    if (text === "" || PLACEHOLDER.test(text)) continue;

    row[key] = key === "phone" || key === "whatsapp" ? normalizePhone(text) : text;
  }

  return { row, pagesProcessed };
}
