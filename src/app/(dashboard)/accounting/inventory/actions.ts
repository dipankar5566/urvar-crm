"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createStockValuation,
  deleteStockValuationDraft,
  postStockValuation,
  cancelStockValuation,
  StockValuationError,
} from "@/lib/accounting/stock-valuation";
import { CostingError } from "@/lib/accounting/costing";

type ActionResult = { error: string } | { success: true };

export type DraftLineInput = {
  productId: string;
  quantityOnHand: string;
  unitCost?: string;
};

export async function createStockValuationAction(input: {
  periodId: string;
  valuationDate: string;
  notes?: string;
  lines: DraftLineInput[];
}): Promise<ActionResult & { valuationId?: string }> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const lines = input.lines.filter((l) => l.quantityOnHand.trim() !== "");
  if (lines.length === 0) return { error: "Add at least one product with a quantity." };

  try {
    const { valuationId } = await createStockValuation(
      {
        periodId: input.periodId,
        valuationDate: new Date(input.valuationDate),
        notes: input.notes?.trim() || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantityOnHand: l.quantityOnHand,
          unitCost: l.unitCost?.trim() || undefined,
        })),
        createdById: user.id,
      },
    );
    revalidatePath("/accounting/inventory");
    return { success: true, valuationId };
  } catch (err) {
    if (err instanceof StockValuationError || err instanceof CostingError) return { error: err.message };
    throw err;
  }
}

export async function deleteStockValuationDraftAction(valuationId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  try {
    await deleteStockValuationDraft({ valuationId, deletedById: user.id });
  } catch (err) {
    if (err instanceof StockValuationError) return { error: err.message };
    throw err;
  }
  revalidatePath("/accounting/inventory");
  return { success: true };
}

export async function postStockValuationAction(valuationId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  try {
    await postStockValuation({ valuationId, postedById: user.id });
  } catch (err) {
    if (err instanceof StockValuationError) return { error: err.message };
    throw err;
  }
  revalidatePath("/accounting/inventory");
  revalidatePath(`/accounting/inventory/${valuationId}`);
  revalidatePath("/accounting/journal");
  return { success: true };
}

export async function cancelStockValuationAction(
  valuationId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  if (input.reason.trim().length < 3) return { error: "Give a reason for cancelling." };

  try {
    await cancelStockValuation({ valuationId, reason: input.reason, cancelledById: user.id });
  } catch (err) {
    if (err instanceof StockValuationError) return { error: err.message };
    throw err;
  }
  revalidatePath("/accounting/inventory");
  revalidatePath(`/accounting/inventory/${valuationId}`);
  revalidatePath("/accounting/journal");
  return { success: true };
}
