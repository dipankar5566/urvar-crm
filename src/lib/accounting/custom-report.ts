import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logAudit } from "@/lib/audit";
import { allTransactionsReport, type AllTransactionsRow } from "./transaction-reports";
import { gt, lt, money, toAmountString, type MoneyInput } from "./money";

/**
 * Custom Report (docs/VYAPAR_PARITY_SPEC.md §3.5) — "a user picks columns
 * and filters over R3's dataset. Saved definitions per user."
 *
 * Deliberately a thin filter/projection over `allTransactionsReport()`
 * (R3), never a separate query — the whole point of "over R3's dataset" is
 * that a custom report can never show a figure the All Transactions Report
 * itself disagrees with.
 */

export class CustomReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomReportError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

export const CUSTOM_REPORT_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "referenceNo", label: "Reference No" },
  { key: "partyName", label: "Party Name" },
  { key: "categoryName", label: "Category Name" },
  { key: "transactionType", label: "Type" },
  { key: "total", label: "Total" },
  { key: "paymentType", label: "Payment Type" },
  { key: "paid", label: "Paid" },
  { key: "received", label: "Received" },
  { key: "balance", label: "Balance" },
  { key: "description", label: "Description" },
] as const;

export type CustomReportColumnKey = (typeof CUSTOM_REPORT_COLUMNS)[number]["key"];
const COLUMN_KEYS: readonly string[] = CUSTOM_REPORT_COLUMNS.map((c) => c.key);

export const CUSTOM_REPORT_TRANSACTION_TYPES: AllTransactionsRow["transactionType"][] = [
  "Sale",
  "Purchase",
  "Payment-In",
  "Payment-Out",
  "Expense",
  "Loan Disbursement",
  "Loan Repayment",
  "Processing Fee",
  "Charges",
  "Top-up",
];

export type CustomReportFilter = {
  /** Empty or omitted = every type. */
  transactionTypes?: string[];
  partyContains?: string | null;
  minAmount?: MoneyInput;
  maxAmount?: MoneyInput;
};

function flattenRow(row: AllTransactionsRow): Record<CustomReportColumnKey, string> {
  return {
    date: row.date.toLocaleDateString("en-IN"),
    referenceNo: row.referenceNo ?? "",
    partyName: row.partyName ?? "",
    categoryName: row.categoryName ?? "",
    transactionType: row.transactionType,
    total: toAmountString(row.total),
    paymentType: row.paymentType ?? "",
    paid: row.paid ? toAmountString(row.paid) : "",
    received: row.received ? toAmountString(row.received) : "",
    balance: row.balance ? toAmountString(row.balance) : "",
    description: row.description ?? "",
  };
}

/** Only the known, valid keys — a stale saved definition naming a column that no longer exists is dropped silently rather than crashing the report. */
export function sanitizeColumns(columns: string[]): CustomReportColumnKey[] {
  const valid = columns.filter((c): c is CustomReportColumnKey => COLUMN_KEYS.includes(c));
  return valid.length > 0 ? valid : CUSTOM_REPORT_COLUMNS.map((c) => c.key);
}

export type CustomReportResult = {
  columns: { key: CustomReportColumnKey; label: string }[];
  rows: Record<string, string>[];
};

export async function runCustomReport(
  fromDate: Date,
  toDate: Date,
  columns: string[],
  filter: CustomReportFilter,
  db: Db = prisma,
): Promise<CustomReportResult> {
  const rows = await allTransactionsReport(fromDate, toDate, db);
  const partyContains = filter.partyContains?.trim().toLowerCase() || null;
  const types = filter.transactionTypes?.filter(Boolean) ?? [];

  const filtered = rows.filter((r) => {
    if (types.length > 0 && !types.includes(r.transactionType)) return false;
    if (partyContains && !(r.partyName ?? "").toLowerCase().includes(partyContains)) return false;
    if (filter.minAmount !== undefined && filter.minAmount !== null && lt(r.total, money(filter.minAmount))) return false;
    if (filter.maxAmount !== undefined && filter.maxAmount !== null && gt(r.total, money(filter.maxAmount))) return false;
    return true;
  });

  const colDefs = CUSTOM_REPORT_COLUMNS.filter((c) => sanitizeColumns(columns).includes(c.key));
  const outRows = filtered.map((r) => {
    const flat = flattenRow(r);
    const out: Record<string, string> = {};
    for (const c of colDefs) out[c.label] = flat[c.key];
    return out;
  });

  return { columns: colDefs.map(({ key, label }) => ({ key, label })), rows: outRows };
}

export type SavedCustomReport = {
  id: string;
  name: string;
  columns: string[];
  transactionTypes: string[];
  partyContains: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  createdAt: Date;
};

export async function listCustomReportDefinitions(createdById: string, db: Db = prisma): Promise<SavedCustomReport[]> {
  const rows = await db.customReportDefinition.findMany({ where: { createdById }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    columns: r.columns,
    transactionTypes: r.transactionTypes,
    partyContains: r.partyContains,
    minAmount: r.minAmount ? toAmountString(r.minAmount) : null,
    maxAmount: r.maxAmount ? toAmountString(r.maxAmount) : null,
    createdAt: r.createdAt,
  }));
}

export async function saveCustomReportDefinition(
  input: {
    name: string;
    columns: string[];
    transactionTypes: string[];
    partyContains?: string | null;
    minAmount?: MoneyInput;
    maxAmount?: MoneyInput;
    createdById: string;
  },
  existingTx?: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ id: string }> => {
    const name = input.name.trim();
    if (!name) throw new CustomReportError("Give this report a name.");
    const columns = sanitizeColumns(input.columns);

    const row = await tx.customReportDefinition.create({
      data: {
        name,
        columns,
        transactionTypes: input.transactionTypes.filter(Boolean),
        partyContains: input.partyContains?.trim() || null,
        minAmount: input.minAmount !== undefined && input.minAmount !== null ? money(input.minAmount) : null,
        maxAmount: input.maxAmount !== undefined && input.maxAmount !== null ? money(input.maxAmount) : null,
        createdById: input.createdById,
      },
    });

    await logAudit(
      { userId: input.createdById, action: "CREATE", entityType: "CustomReportDefinition", entityId: row.id, newValue: { name, columns } },
      tx,
    );
    return { id: row.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Only the definition's own owner may delete it — "saved definitions per user", not a shared list anyone can prune. */
export async function deleteCustomReportDefinition(
  input: { id: string; deletedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const row = await tx.customReportDefinition.findUnique({ where: { id: input.id } });
    if (!row) throw new CustomReportError("That saved report does not exist.");
    if (row.createdById !== input.deletedById) throw new CustomReportError("You can only delete your own saved reports.");

    await tx.customReportDefinition.delete({ where: { id: input.id } });
    await logAudit(
      { userId: input.deletedById, action: "DELETE", entityType: "CustomReportDefinition", entityId: input.id, oldValue: { name: row.name } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
