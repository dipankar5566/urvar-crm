import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Named posting roles, resolved to real ledger accounts through the
 * `AccountMapping` table.
 *
 * The point is that no account id or account code ever appears at a call
 * site. A posting says "debit AR_TRADE"; which account that is stays a
 * configuration decision an accountant can change without a deploy, and a
 * missing mapping fails loudly at boot instead of silently posting somewhere
 * plausible six months later.
 */
export const ACCOUNT_KEYS = [
  // Receivables / payables control accounts
  "AR_TRADE",
  "AP_TRADE",
  "ADVANCE_FROM_CUSTOMER",
  "ADVANCE_TO_SUPPLIER",

  // Revenue
  "SALES_REVENUE",
  "SALES_RETURNS",
  "FREIGHT_RECOVERED",
  "DISCOUNT_ALLOWED",

  // Direct expenses
  "FREIGHT_INWARD",

  // Output GST (collected on sales, owed to the government)
  "GST_OUTPUT_CGST",
  "GST_OUTPUT_SGST",
  "GST_OUTPUT_IGST",
  "GST_OUTPUT_CESS",

  // Input GST (paid on purchases, claimable as ITC)
  "GST_INPUT_CGST",
  "GST_INPUT_SGST",
  "GST_INPUT_IGST",
  "GST_INPUT_CESS",

  // Money
  "CASH_ON_HAND",
  "BANK_DEFAULT",

  // Inventory / cost
  "INVENTORY_FINISHED_GOODS",
  "INVENTORY_RAW_MATERIAL",
  "COGS",
  "PURCHASES",

  // Adjustments
  "ROUND_OFF",
  "OPENING_BALANCE_EQUITY",

  // Phase 9 — Cash, Bank, Loans & Fixed Assets
  "INTEREST_EXPENSE",
  "ASSET_DISPOSAL_GAIN_LOSS",
  "CASH_SHORT_OVER",
] as const;

export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export type AccountMap = ReadonlyMap<AccountKey, string>;

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Load every mapping in one query.
 *
 * Deliberately not memoised: an admin may remap an account at runtime, and a
 * stale module-level cache in a long-lived `next start` process would keep
 * posting to the old account with no signal. Postings are rare and this is a
 * single indexed read, so the cache would buy nothing worth that risk.
 */
export async function loadAccountMap(db: Db = prisma): Promise<AccountMap> {
  const rows = await db.accountMapping.findMany({
    select: { key: true, accountId: true },
  });
  return new Map(rows.map((r) => [r.key as AccountKey, r.accountId]));
}

/** Resolve one key, or throw naming the key that is missing. */
export function requireAccount(map: AccountMap, key: AccountKey): string {
  const id = map.get(key);
  if (!id) {
    throw new Error(
      `No ledger account is mapped to "${key}". Run the chart-of-accounts seed, ` +
        `or set the mapping under Accounting → Account mappings.`,
    );
  }
  return id;
}

export type MappingValidation = {
  ok: boolean;
  missing: AccountKey[];
  /** Mapped to an account that cannot receive postings — a real misconfiguration. */
  notPostable: { key: AccountKey; code: string; name: string }[];
  /** Mapped to an account that has been deactivated. */
  inactive: { key: AccountKey; code: string; name: string }[];
};

/**
 * Check that every key resolves to an active, postable account.
 *
 * Called by the accounting settings page and by the seed's verification step.
 * A mapping pointing at a parent (non-postable) account is the failure mode
 * worth catching early: it posts fine and quietly double-counts in every
 * rolled-up report.
 */
export async function validateAccountMappings(db: Db = prisma): Promise<MappingValidation> {
  const rows = await db.accountMapping.findMany({
    select: {
      key: true,
      account: { select: { code: true, name: true, isPostable: true, isActive: true } },
    },
  });
  const byKey = new Map(rows.map((r) => [r.key as AccountKey, r.account]));

  const missing: AccountKey[] = [];
  const notPostable: MappingValidation["notPostable"] = [];
  const inactive: MappingValidation["inactive"] = [];

  for (const key of ACCOUNT_KEYS) {
    const account = byKey.get(key);
    if (!account) {
      missing.push(key);
      continue;
    }
    if (!account.isPostable) notPostable.push({ key, code: account.code, name: account.name });
    if (!account.isActive) inactive.push({ key, code: account.code, name: account.name });
  }

  return {
    ok: missing.length === 0 && notPostable.length === 0 && inactive.length === 0,
    missing,
    notPostable,
    inactive,
  };
}
