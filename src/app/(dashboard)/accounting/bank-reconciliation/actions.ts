"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  importBankStatement,
  matchStatementLine,
  unmatchStatementLine,
  ignoreStatementLine,
  restoreStatementLine,
  deleteStatementImport,
  saveStatementColumnMap,
  createTransactionFromStatementLine,
  ReconciliationError,
  type StatementRow,
} from "@/lib/accounting/bank-reconciliation";

type ActionResult = { error: string } | { success: true };
type ImportActionResult = { error: string } | { success: true; importBatch: string; imported: number; autoMatched: number };

/**
 * Accepts ISO (2026-10-26), Indian dd/mm/yyyy or dd-mm-yyyy, and falls back
 * to whatever Date() itself can parse.
 *
 * The dd/mm/yyyy branch is built at local noon, not local midnight: every
 * display in this feature reads the date back with `toISOString().slice(0,
 * 10)`, and a server running in a timezone ahead of UTC (IST included) turns
 * local midnight into the previous UTC day — a statement dated 25/10 was
 * showing as 24/10 in the UI. Noon is clear of that boundary in every real
 * timezone, the same reason `tests/helpers/db.ts`'s `openPeriodDate()` does
 * this.
 */
function parseStatementDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type StatementColumnMap = {
  date: string;
  description: string;
  withdrawal: string;
  deposit: string;
  reference?: string;
};

/**
 * Commit an already-parsed file. The file itself is parsed once, client-side
 * of this call, by `POST /api/accounting/bank-reconciliation/parse` (headers
 * are needed before the column-mapping UI can even be drawn) — this action
 * takes the resulting rows as plain JSON rather than re-parsing the file, the
 * same two-step shape the leads importer already uses.
 */
export async function importBankStatementRowsAction(input: {
  bankAccountId: string;
  columnMap: StatementColumnMap;
  rows: Record<string, string>[];
}): Promise<ImportActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const { bankAccountId, columnMap } = input;
  if (!bankAccountId) return { error: "No bank account selected." };
  if (!columnMap.date || !columnMap.description || !columnMap.withdrawal || !columnMap.deposit) {
    return { error: "Map Date, Description, Withdrawal and Deposit before importing." };
  }
  if (input.rows.length === 0) return { error: "No data rows to import." };

  const rows: StatementRow[] = [];
  input.rows.forEach((row) => {
    const txnDate = parseStatementDate(row[columnMap.date] ?? "");
    if (!txnDate) return;
    rows.push({
      txnDate,
      description: row[columnMap.description] ?? "",
      reference: columnMap.reference ? row[columnMap.reference] : null,
      withdrawal: row[columnMap.withdrawal] || 0,
      deposit: row[columnMap.deposit] || 0,
    });
  });

  if (rows.length === 0) {
    return { error: "Every row's date column failed to parse — check the column mapping." };
  }

  try {
    await saveStatementColumnMap({ bankAccountId, columnMap, savedById: user.id });
    const result = await importBankStatement({ bankAccountId, rows, createdById: user.id });
    revalidatePath(`/accounting/bank-reconciliation/${bankAccountId}`);
    return { success: true, ...result };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function matchStatementLineAction(input: { statementLineId: string; journalLineId: string }): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    await matchStatementLine({ ...input, matchedById: user.id });
    revalidatePath("/accounting/bank-reconciliation");
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function unmatchStatementLineAction(statementLineId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    await unmatchStatementLine({ statementLineId, unmatchedById: user.id });
    revalidatePath("/accounting/bank-reconciliation");
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function ignoreStatementLineAction(statementLineId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    await ignoreStatementLine({ statementLineId, ignoredById: user.id });
    revalidatePath("/accounting/bank-reconciliation");
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function restoreStatementLineAction(statementLineId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    await restoreStatementLine({ statementLineId, restoredById: user.id });
    revalidatePath("/accounting/bank-reconciliation");
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function deleteStatementImportAction(input: { bankAccountId: string; importBatch: string }): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    await deleteStatementImport({ ...input, deletedById: user.id });
    revalidatePath(`/accounting/bank-reconciliation/${input.bankAccountId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}

export async function createTransactionFromStatementLineAction(
  input:
    | { statementLineId: string; type: "BANK_CHARGE"; expenseAccountId: string }
    | { statementLineId: string; type: "INTEREST_INCOME"; incomeAccountId: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  try {
    if (input.type === "BANK_CHARGE") {
      await createTransactionFromStatementLine({ ...input, createdById: user.id });
    } else {
      await createTransactionFromStatementLine({ ...input, createdById: user.id });
    }
    revalidatePath("/accounting/bank-reconciliation");
    return { success: true };
  } catch (err) {
    if (err instanceof ReconciliationError) return { error: err.message };
    throw err;
  }
}
