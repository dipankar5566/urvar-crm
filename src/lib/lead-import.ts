import { CustomerType, LeadSource } from "@/generated/prisma/enums";

export { guessCustomerType, distinctValues } from "@/lib/customer-import";

export const IMPORT_TARGET_FIELDS = [
  "name",
  "phone",
  "source",
  "customerType",
  "state",
  "district",
  "companyName",
  "contactPerson",
  "whatsapp",
  "email",
  "pincode",
  "address",
  "interestedProducts",
  "expectedQuantity",
  "expectedMonthlyValue",
  "estimatedValue",
  "cropInterest",
  "remarks",
] as const;

export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

export const IMPORT_FIELD_DEFS: { key: ImportTargetField; label: string; required: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "phone", label: "Phone", required: true },
  { key: "source", label: "Lead Source", required: false },
  { key: "customerType", label: "Customer Type", required: false },
  { key: "state", label: "State", required: true },
  { key: "district", label: "District", required: true },
  { key: "companyName", label: "Company Name", required: false },
  { key: "contactPerson", label: "Contact Person", required: false },
  { key: "whatsapp", label: "WhatsApp Number", required: false },
  { key: "email", label: "Email", required: false },
  { key: "pincode", label: "Pincode", required: false },
  { key: "address", label: "Address", required: false },
  { key: "interestedProducts", label: "Interested Products", required: false },
  { key: "expectedQuantity", label: "Expected Quantity", required: false },
  { key: "expectedMonthlyValue", label: "Expected Monthly Value", required: false },
  { key: "estimatedValue", label: "Estimated Value", required: false },
  { key: "cropInterest", label: "Crop Interest", required: false },
  { key: "remarks", label: "Remarks", required: false },
];

/** target field -> source spreadsheet header (undefined/"" = unmapped) */
export type ColumnMapping = Partial<Record<ImportTargetField, string>>;

/** raw cell value (trimmed, as found in the sheet) -> CRM enum value */
export type ValueMapping = {
  source: Record<string, string>;
  customerType: Record<string, string>;
};

const LEAD_SOURCE_KEYWORDS: [RegExp, LeadSource][] = [
  [/website|web site/i, LeadSource.WEBSITE],
  [/meta|facebook|instagram/i, LeadSource.META_ADS],
  [/google/i, LeadSource.GOOGLE_ADS],
  [/trade ?show|exhibition/i, LeadSource.TRADE_SHOW],
  [/referral/i, LeadSource.REFERRAL],
  [/distrib/i, LeadSource.DISTRIBUTOR],
  [/call|phone/i, LeadSource.DIRECT_CALL],
  [/whatsapp/i, LeadSource.WHATSAPP],
  [/organic|search/i, LeadSource.ORGANIC_SEARCH],
  [/govt|government|tender/i, LeadSource.GOVERNMENT_TENDER],
];

export function guessLeadSource(value: string): LeadSource | null {
  for (const [pattern, source] of LEAD_SOURCE_KEYWORDS) {
    if (pattern.test(value)) return source;
  }
  return null;
}

/**
 * Applies the column + value mapping to one raw spreadsheet row, producing
 * the plain-string input shape `leadFormSchema` expects. Does not validate —
 * callers run the result through `leadFormSchema.safeParse`.
 */
export function buildRowInput(
  raw: Record<string, string>,
  columnMapping: ColumnMapping,
  valueMapping: ValueMapping,
): Record<ImportTargetField, string | undefined> {
  const get = (field: ImportTargetField): string | undefined => {
    const header = columnMapping[field];
    if (!header) return undefined;
    const value = raw[header];
    if (value === undefined) return undefined;
    const trimmed = String(value).trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const sourceRaw = get("source");
  const customerTypeRaw = get("customerType");

  return {
    name: get("name"),
    phone: get("phone"),
    // Source/Customer Type are optional on import — fall back to the same
    // defaults the database uses when a sheet doesn't carry this data.
    source: (sourceRaw && valueMapping.source[sourceRaw]) || LeadSource.DIRECT_CALL,
    customerType:
      (customerTypeRaw && valueMapping.customerType[customerTypeRaw]) || CustomerType.B2C_FARMER,
    state: get("state"),
    district: get("district"),
    companyName: get("companyName"),
    contactPerson: get("contactPerson"),
    whatsapp: get("whatsapp"),
    email: get("email"),
    pincode: get("pincode"),
    address: get("address"),
    interestedProducts: get("interestedProducts"),
    expectedQuantity: get("expectedQuantity"),
    expectedMonthlyValue: get("expectedMonthlyValue"),
    estimatedValue: get("estimatedValue"),
    cropInterest: get("cropInterest"),
    remarks: get("remarks"),
  };
}
