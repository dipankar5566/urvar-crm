/**
 * The starting chart of accounts for an Indian trading/manufacturing company.
 *
 * Plain data, no Prisma import, so the seed runner under `scripts/` can pull
 * it in with a relative path (tsx does not resolve the `@/` alias — see
 * prisma/seed.ts for the same constraint).
 *
 * Codes are the stable identity. Names may be edited by an accountant; codes
 * may not, because `DEFAULT_ACCOUNT_MAPPINGS` and every report grouping
 * resolve through them.
 *
 * Grouping accounts are `isPostable: false` — they exist to subtotal their
 * children, and posting to one would double-count it against them.
 */

export type LedgerAccountTypeName = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type NormalBalanceName = "DEBIT" | "CREDIT";

export type SeedAccount = {
  code: string;
  name: string;
  type: LedgerAccountTypeName;
  /** Parent's code. Omitted for a top-level account. */
  parent?: string;
  /** Defaults from `type`; set explicitly only for a contra account. */
  normalBalance?: NormalBalanceName;
  /** Grouping accounts are false. Defaults true. */
  isPostable?: boolean;
  description?: string;
};

/** Which side increases a normal (non-contra) account of this type. */
export function defaultNormalBalance(type: LedgerAccountTypeName): NormalBalanceName {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

const GROUP = { isPostable: false } as const;

export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  // ---------------------------------------------------------------- ASSETS
  { code: "1000", name: "Assets", type: "ASSET", ...GROUP },
  { code: "1100", name: "Current Assets", type: "ASSET", parent: "1000", ...GROUP },

  { code: "1110", name: "Cash on Hand", type: "ASSET", parent: "1100" },
  { code: "1120", name: "Bank Accounts", type: "ASSET", parent: "1100", ...GROUP },
  { code: "1121", name: "Bank - Current Account", type: "ASSET", parent: "1120" },
  {
    code: "1122",
    name: "Bank - Flipkart Settlement",
    type: "ASSET",
    parent: "1120",
    description:
      "Marketplace settlement balance, kept separate from the real bank account " +
      "for reconciliation against Flipkart's own statements. Added during the " +
      "Vyapar opening-balance migration, 2026-09-20.",
  },

  {
    code: "1130",
    name: "Accounts Receivable",
    type: "ASSET",
    parent: "1100",
    description:
      "Control account for trade debtors. Per-customer balances come from the " +
      "partyType/partyId on each journal line, not from a column on Customer.",
  },
  { code: "1140", name: "Advances to Suppliers", type: "ASSET", parent: "1100" },

  { code: "1150", name: "Input GST (ITC)", type: "ASSET", parent: "1100", ...GROUP },
  { code: "1151", name: "Input CGST", type: "ASSET", parent: "1150" },
  { code: "1152", name: "Input SGST", type: "ASSET", parent: "1150" },
  { code: "1153", name: "Input IGST", type: "ASSET", parent: "1150" },
  { code: "1154", name: "Input Cess", type: "ASSET", parent: "1150" },

  {
    code: "1160",
    name: "Inventory",
    type: "ASSET",
    parent: "1100",
    ...GROUP,
    description:
      "Quantities live in the ERP (urvar_erp). These accounts hold value only, " +
      "and are not posted to until Phase 4 settles how cost reaches the CRM.",
  },
  { code: "1161", name: "Inventory - Finished Goods", type: "ASSET", parent: "1160" },
  { code: "1162", name: "Inventory - Raw Materials", type: "ASSET", parent: "1160" },
  { code: "1163", name: "Inventory - Packaging Materials", type: "ASSET", parent: "1160" },

  { code: "1200", name: "Fixed Assets", type: "ASSET", parent: "1000", ...GROUP },
  { code: "1210", name: "Plant & Machinery", type: "ASSET", parent: "1200" },
  { code: "1220", name: "Furniture & Fixtures", type: "ASSET", parent: "1200" },
  { code: "1230", name: "Vehicles", type: "ASSET", parent: "1200" },
  {
    code: "1290",
    name: "Accumulated Depreciation",
    type: "ASSET",
    parent: "1200",
    normalBalance: "CREDIT",
    description: "Contra-asset: reduces the carrying value of fixed assets.",
  },

  // ----------------------------------------------------------- LIABILITIES
  { code: "2000", name: "Liabilities", type: "LIABILITY", ...GROUP },
  { code: "2100", name: "Current Liabilities", type: "LIABILITY", parent: "2000", ...GROUP },

  {
    code: "2110",
    name: "Accounts Payable",
    type: "LIABILITY",
    parent: "2100",
    description: "Control account for trade creditors.",
  },
  { code: "2120", name: "Advances from Customers", type: "LIABILITY", parent: "2100" },

  { code: "2130", name: "Output GST Payable", type: "LIABILITY", parent: "2100", ...GROUP },
  { code: "2131", name: "Output CGST", type: "LIABILITY", parent: "2130" },
  { code: "2132", name: "Output SGST", type: "LIABILITY", parent: "2130" },
  { code: "2133", name: "Output IGST", type: "LIABILITY", parent: "2130" },
  { code: "2134", name: "Output Cess", type: "LIABILITY", parent: "2130" },

  { code: "2140", name: "TDS Payable", type: "LIABILITY", parent: "2100" },
  { code: "2150", name: "Salaries Payable", type: "LIABILITY", parent: "2100" },
  { code: "2160", name: "Other Payables", type: "LIABILITY", parent: "2100" },

  { code: "2200", name: "Long-term Liabilities", type: "LIABILITY", parent: "2000", ...GROUP },
  { code: "2210", name: "Loans", type: "LIABILITY", parent: "2200" },

  // ---------------------------------------------------------------- EQUITY
  { code: "3000", name: "Equity", type: "EQUITY", ...GROUP },
  { code: "3100", name: "Share Capital", type: "EQUITY", parent: "3000" },
  { code: "3200", name: "Retained Earnings", type: "EQUITY", parent: "3000" },
  {
    code: "3300",
    name: "Opening Balance Equity",
    type: "EQUITY",
    parent: "3000",
    description:
      "Contra side of every migrated opening balance. An opening invoice posts " +
      "here, never to revenue - that income was already recognised in Vyapar " +
      "and already sits in a filed GSTR. Should net to zero once the opening " +
      "trial balance is complete and signed off.",
  },

  // ---------------------------------------------------------------- INCOME
  { code: "4000", name: "Income", type: "INCOME", ...GROUP },
  { code: "4100", name: "Sales Revenue", type: "INCOME", parent: "4000" },
  { code: "4200", name: "Freight Recovered", type: "INCOME", parent: "4000" },
  {
    code: "4300",
    name: "Sales Returns",
    type: "INCOME",
    parent: "4000",
    normalBalance: "DEBIT",
    description: "Contra-revenue: reduces sales.",
  },
  {
    code: "4400",
    name: "Discount Allowed",
    type: "INCOME",
    parent: "4000",
    normalBalance: "DEBIT",
    description: "Contra-revenue.",
  },
  { code: "4900", name: "Other Income", type: "INCOME", parent: "4000" },
  {
    code: "4910",
    name: "Rounding Difference",
    type: "INCOME",
    parent: "4000",
    description:
      "Absorbs the sub-rupee adjustment when an invoice total is rounded to " +
      "the nearest rupee. Carries either side.",
  },

  // -------------------------------------------------------------- EXPENSES
  { code: "5000", name: "Expenses", type: "EXPENSE", ...GROUP },
  { code: "5100", name: "Cost of Goods Sold", type: "EXPENSE", parent: "5000" },
  { code: "5200", name: "Purchases", type: "EXPENSE", parent: "5000" },

  { code: "5300", name: "Direct Expenses", type: "EXPENSE", parent: "5000", ...GROUP },
  { code: "5310", name: "Freight Inward", type: "EXPENSE", parent: "5300" },
  { code: "5320", name: "Wages - Production", type: "EXPENSE", parent: "5300" },
  { code: "5330", name: "Power & Fuel", type: "EXPENSE", parent: "5300" },

  { code: "5400", name: "Operating Expenses", type: "EXPENSE", parent: "5000", ...GROUP },
  { code: "5410", name: "Salaries & Wages", type: "EXPENSE", parent: "5400" },
  { code: "5420", name: "Rent", type: "EXPENSE", parent: "5400" },
  { code: "5430", name: "Electricity", type: "EXPENSE", parent: "5400" },
  { code: "5440", name: "Telephone & Internet", type: "EXPENSE", parent: "5400" },
  { code: "5450", name: "Travel & Conveyance", type: "EXPENSE", parent: "5400" },
  { code: "5460", name: "Office Expenses", type: "EXPENSE", parent: "5400" },
  { code: "5470", name: "Repairs & Maintenance", type: "EXPENSE", parent: "5400" },
  { code: "5480", name: "Professional & Legal Fees", type: "EXPENSE", parent: "5400" },
  { code: "5490", name: "Bank Charges", type: "EXPENSE", parent: "5400" },

  { code: "5500", name: "Selling & Distribution", type: "EXPENSE", parent: "5000", ...GROUP },
  { code: "5510", name: "Freight Outward", type: "EXPENSE", parent: "5500" },
  { code: "5520", name: "Marketing & Advertising", type: "EXPENSE", parent: "5500" },
  { code: "5530", name: "Commission", type: "EXPENSE", parent: "5500" },

  { code: "5600", name: "Depreciation", type: "EXPENSE", parent: "5000" },
];

/**
 * Posting role -> account code. These are the accounts the posting service
 * resolves by name, so every one of them must exist and be postable.
 */
export const DEFAULT_ACCOUNT_MAPPINGS: Record<string, string> = {
  AR_TRADE: "1130",
  AP_TRADE: "2110",
  ADVANCE_FROM_CUSTOMER: "2120",
  ADVANCE_TO_SUPPLIER: "1140",

  SALES_REVENUE: "4100",
  SALES_RETURNS: "4300",
  FREIGHT_RECOVERED: "4200",
  DISCOUNT_ALLOWED: "4400",

  GST_OUTPUT_CGST: "2131",
  GST_OUTPUT_SGST: "2132",
  GST_OUTPUT_IGST: "2133",
  GST_OUTPUT_CESS: "2134",

  GST_INPUT_CGST: "1151",
  GST_INPUT_SGST: "1152",
  GST_INPUT_IGST: "1153",
  GST_INPUT_CESS: "1154",

  CASH_ON_HAND: "1110",
  BANK_DEFAULT: "1121",

  INVENTORY_FINISHED_GOODS: "1161",
  INVENTORY_RAW_MATERIAL: "1162",
  COGS: "5100",
  PURCHASES: "5200",

  ROUND_OFF: "4910",
  OPENING_BALANCE_EQUITY: "3300",
};
