import { CustomerType, DealerTier } from "@/generated/prisma/enums";

export const IMPORT_TARGET_FIELDS = [
  "name",
  "phone",
  "customerType",
  "state",
  "district",
  "companyName",
  "contactPerson",
  "whatsapp",
  "email",
  "pincode",
  "address",
  "gstNumber",
  "panNumber",
  "creditLimit",
  "outstandingAmount",
  "dealerTier",
  "territoryAssigned",
] as const;

export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

export const IMPORT_FIELD_DEFS: { key: ImportTargetField; label: string; required: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "phone", label: "Phone", required: true },
  { key: "customerType", label: "Customer Type", required: false },
  { key: "state", label: "State", required: true },
  { key: "district", label: "District", required: true },
  { key: "companyName", label: "Company Name", required: false },
  { key: "contactPerson", label: "Contact Person", required: false },
  { key: "whatsapp", label: "WhatsApp Number", required: false },
  { key: "email", label: "Email", required: false },
  { key: "pincode", label: "Pincode", required: false },
  { key: "address", label: "Address", required: false },
  { key: "gstNumber", label: "GST Number", required: false },
  { key: "panNumber", label: "PAN Number", required: false },
  { key: "creditLimit", label: "Credit Limit", required: false },
  { key: "outstandingAmount", label: "Outstanding Amount", required: false },
  { key: "dealerTier", label: "Dealer Tier", required: false },
  { key: "territoryAssigned", label: "Territory Assigned", required: false },
];

/** target field -> source spreadsheet header (undefined/"" = unmapped) */
export type ColumnMapping = Partial<Record<ImportTargetField, string>>;

/** raw cell value (trimmed, as found in the sheet) -> CRM enum value */
export type ValueMapping = {
  customerType: Record<string, string>;
  dealerTier: Record<string, string>;
};

const CUSTOMER_TYPE_KEYWORDS: [RegExp, CustomerType][] = [
  [/farm/i, CustomerType.B2C_FARMER],
  [/distrib/i, CustomerType.B2B_DISTRIBUTOR],
  [/dealer/i, CustomerType.B2B_DEALER],
  [/agri.?input/i, CustomerType.AGRI_INPUT_SHOP],
  [/retail|shop/i, CustomerType.B2B_RETAILER],
  [/fpo|coop/i, CustomerType.FPO_COOPERATIVE],
  [/ngo/i, CustomerType.NGO],
  [/govt|government|tender/i, CustomerType.GOVERNMENT],
  [/corporate/i, CustomerType.CORPORATE_FARM],
  [/plantation/i, CustomerType.PLANTATION],
];

const DEALER_TIER_KEYWORDS: [RegExp, DealerTier][] = [
  [/gold/i, DealerTier.GOLD],
  [/silver/i, DealerTier.SILVER],
  [/bronze/i, DealerTier.BRONZE],
];

export function guessCustomerType(value: string): CustomerType | null {
  for (const [pattern, type] of CUSTOMER_TYPE_KEYWORDS) {
    if (pattern.test(value)) return type;
  }
  return null;
}

export function guessDealerTier(value: string): DealerTier | null {
  for (const [pattern, tier] of DEALER_TIER_KEYWORDS) {
    if (pattern.test(value)) return tier;
  }
  return null;
}

/** Distinct, non-blank, trimmed values found in `header` across all rows. */
export function distinctValues(rows: Record<string, string>[], header: string): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const v = row[header];
    if (v !== undefined && String(v).trim() !== "") set.add(String(v).trim());
  }
  return [...set];
}

/**
 * Applies the column + value mapping to one raw spreadsheet row, producing
 * the plain-string input shape `customerFormSchema` expects. Does not
 * validate — callers run the result through `customerFormSchema.safeParse`.
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

  const customerTypeRaw = get("customerType");
  const dealerTierRaw = get("dealerTier");

  return {
    name: get("name"),
    phone: get("phone"),
    // Customer Type is optional on import — fall back to the same default
    // the database uses when a sheet doesn't carry this data.
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
    gstNumber: get("gstNumber"),
    panNumber: get("panNumber"),
    creditLimit: get("creditLimit"),
    outstandingAmount: get("outstandingAmount"),
    dealerTier: dealerTierRaw ? valueMapping.dealerTier[dealerTierRaw] : undefined,
    territoryAssigned: get("territoryAssigned"),
  };
}
