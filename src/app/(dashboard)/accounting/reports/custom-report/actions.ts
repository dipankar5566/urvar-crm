"use server";

import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  runCustomReport,
  saveCustomReportDefinition,
  deleteCustomReportDefinition,
  CustomReportError,
  type CustomReportResult,
} from "@/lib/accounting/custom-report";

type ActionResult = { error: string } | { success: true };

export async function runCustomReportAction(input: {
  from: string;
  to: string;
  columns: string[];
  transactionTypes: string[];
  partyContains: string;
  minAmount: string;
  maxAmount: string;
}): Promise<{ error: string } | ({ success: true } & CustomReportResult)> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  if (!input.from || !input.to) return { error: "Pick a date range." };
  if (input.columns.length === 0) return { error: "Pick at least one column." };

  const result = await runCustomReport(new Date(input.from), new Date(input.to), input.columns, {
    transactionTypes: input.transactionTypes,
    partyContains: input.partyContains || null,
    minAmount: input.minAmount || undefined,
    maxAmount: input.maxAmount || undefined,
  });
  return { success: true, ...result };
}

export async function saveCustomReportDefinitionAction(input: {
  name: string;
  columns: string[];
  transactionTypes: string[];
  partyContains: string;
  minAmount: string;
  maxAmount: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  try {
    await saveCustomReportDefinition({
      name: input.name,
      columns: input.columns,
      transactionTypes: input.transactionTypes,
      partyContains: input.partyContains || null,
      minAmount: input.minAmount || undefined,
      maxAmount: input.maxAmount || undefined,
      createdById: user.id,
    });
    return { success: true };
  } catch (err) {
    if (err instanceof CustomReportError) return { error: err.message };
    throw err;
  }
}

export async function deleteCustomReportDefinitionAction(id: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  try {
    await deleteCustomReportDefinition({ id, deletedById: user.id });
    return { success: true };
  } catch (err) {
    if (err instanceof CustomReportError) return { error: err.message };
    throw err;
  }
}
