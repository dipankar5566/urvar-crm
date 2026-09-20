import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { weightedAverageCosts } from "./costing";
import { money, mul, round, roundToScale, sum, type Money } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * Periodic closing-stock valuation (Phase 4).
 *
 * One valuation per FinancialPeriod. Posting it does two things in the same
 * journal entry set: reverses the immediately preceding period's valuation
 * (so last period's closing stock becomes this period's opening stock, the
 * standard trading-account roll-forward) and posts this period's own closing
 * value as Dr Inventory / Cr COGS. See the schema comment above
 * `StockValuation` for why this is periodic rather than a per-invoice entry.
 */

export class StockValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockValuationError";
  }
}

export type CreateStockValuationLineInput = {
  productId: string;
  quantityOnHand: string | number;
  /**
   * Overrides the computed weighted-average cost. Required when the product
   * has no cost-relevant purchase history yet — the system never invents a
   * cost, so a line with neither this nor purchase history is refused.
   */
  unitCost?: string | number;
};

export type CreateStockValuationInput = {
  periodId: string;
  valuationDate: Date;
  lines: CreateStockValuationLineInput[];
  notes?: string | null;
  createdById: string;
};

export async function createStockValuation(
  input: CreateStockValuationInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ valuationId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ valuationId: string }> => {
    const period = await tx.financialPeriod.findUnique({ where: { id: input.periodId } });
    if (!period) throw new StockValuationError("Financial period not found.");

    const existing = await tx.stockValuation.findUnique({ where: { periodId: input.periodId } });
    if (existing) {
      throw new StockValuationError(
        `${period.label} already has a stock valuation (status: ${existing.status}). ` +
          `Cancel it before creating another.`,
      );
    }

    if (input.lines.length === 0) throw new StockValuationError("Add at least one product line.");
    const productIds = input.lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new StockValuationError("Each product can appear only once in a valuation.");
    }

    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });
    const productNames = new Map(products.map((p) => [p.id, p.name]));
    for (const id of productIds) {
      if (!productNames.has(id)) throw new StockValuationError(`Product ${id} does not exist.`);
    }

    const computedCosts = await weightedAverageCosts(productIds, input.valuationDate, tx);

    const preparedLines = input.lines.map((l) => {
      const qty = money(l.quantityOnHand);
      if (qty.isNegative()) {
        throw new StockValuationError(`Quantity on hand for ${productNames.get(l.productId)} cannot be negative.`);
      }
      let unitCost: Money;
      let costSource: "WEIGHTED_AVERAGE" | "MANUAL";
      const manual = l.unitCost !== undefined && l.unitCost !== null && String(l.unitCost).trim() !== "";
      if (manual) {
        unitCost = roundToScale(l.unitCost!, 4);
        costSource = "MANUAL";
      } else {
        const computed = computedCosts.get(l.productId);
        if (!computed) {
          throw new StockValuationError(
            `${productNames.get(l.productId)} has no purchase history as of ` +
              `${input.valuationDate.toISOString().slice(0, 10)} — supply a manual unit cost for this line.`,
          );
        }
        unitCost = roundToScale(computed, 4);
        costSource = "WEIGHTED_AVERAGE";
      }
      const value = round(mul(qty, unitCost));
      return { productId: l.productId, quantityOnHand: qty, unitCost, costSource, value };
    });

    const totalValue = round(sum(preparedLines.map((l) => l.value)));
    const company = await requireCompany(tx);

    const valuation = await tx.stockValuation.create({
      data: {
        companyId: company.id,
        periodId: input.periodId,
        valuationDate: input.valuationDate,
        totalValue,
        notes: input.notes ?? null,
        createdById: input.createdById,
        lines: { create: preparedLines },
      },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "StockValuation",
        entityId: valuation.id,
        newValue: { periodLabel: period.label, totalValue: totalValue.toFixed(2), lineCount: preparedLines.length },
      },
      tx,
    );

    return { valuationId: valuation.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Only a DRAFT valuation can be deleted outright — nothing has posted yet. */
export async function deleteStockValuationDraft(
  input: { valuationId: string; deletedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const valuation = await tx.stockValuation.findUnique({ where: { id: input.valuationId } });
    if (!valuation) throw new StockValuationError("Stock valuation not found.");
    if (valuation.status !== "DRAFT") {
      throw new StockValuationError(
        "Only a DRAFT valuation can be deleted — a posted one must be cancelled instead, " +
          "which reverses it rather than erasing it.",
      );
    }
    await tx.stockValuation.delete({ where: { id: valuation.id } });
    await logAudit(
      {
        userId: input.deletedById,
        action: "DELETE",
        entityType: "StockValuation",
        entityId: valuation.id,
        oldValue: { periodId: valuation.periodId, totalValue: valuation.totalValue.toFixed(2) },
      },
      tx,
    );
  };
  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type PostStockValuationInput = {
  valuationId: string;
  postedById: string;
};

export type PostStockValuationResult = {
  journalEntryId: string;
  journalEntryNumber: string;
};

export async function postStockValuation(
  input: PostStockValuationInput,
  existingTx?: Prisma.TransactionClient,
): Promise<PostStockValuationResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostStockValuationResult> => {
    const valuation = await tx.stockValuation.findUnique({
      where: { id: input.valuationId },
      include: { lines: true, period: true },
    });
    if (!valuation) throw new StockValuationError("Stock valuation not found.");
    if (valuation.status !== "DRAFT") {
      throw new StockValuationError(`Only a DRAFT valuation can be posted; this one is ${valuation.status}.`);
    }
    if (valuation.lines.length === 0) throw new StockValuationError("This valuation has no lines to post.");

    // Reverse the immediately preceding posted valuation, dated at the start
    // of THIS period, so last period's closing stock becomes this period's
    // opening stock — the standard trading-account roll-forward. Dated at
    // this period's start (not the earlier period's own dates) because that
    // earlier period may already be CLOSED, and reverseJournalEntry exists
    // precisely to let a correction land in a still-open later period.
    const previous = await tx.stockValuation.findFirst({
      where: {
        companyId: valuation.companyId,
        status: "POSTED",
        period: { startDate: { lt: valuation.period.startDate } },
      },
      orderBy: { period: { startDate: "desc" } },
      include: { period: true },
    });

    if (previous) {
      if (!previous.postedEntryId) {
        throw new StockValuationError(
          `${previous.period.label}'s valuation is POSTED but has no journal entry on file — data inconsistency, stopping rather than guessing.`,
        );
      }
      await reverseJournalEntry(
        {
          entryId: previous.postedEntryId,
          reason: `Opening stock for ${valuation.period.label}, carried forward from ${previous.period.label}'s closing stock.`,
          postedById: input.postedById,
          reversalDate: valuation.period.startDate,
        },
        tx,
      );
    }

    const totalValue = round(valuation.totalValue);
    const posted = await postJournalEntry(
      {
        entryDate: valuation.valuationDate,
        narration: `Closing stock valuation for ${valuation.period.label}`,
        sourceType: "STOCK_MOVEMENT",
        sourceId: valuation.id,
        idempotencyKey: `STOCK_VALUATION:${valuation.id}:1`,
        postedById: input.postedById,
        lines: [
          { accountKey: "INVENTORY_FINISHED_GOODS", debit: totalValue },
          { accountKey: "COGS", credit: totalValue },
        ],
      },
      tx,
    );

    await tx.stockValuation.update({
      where: { id: valuation.id },
      data: { status: "POSTED", postedEntryId: posted.entryId, postedAt: new Date() },
    });

    await logAudit(
      {
        userId: input.postedById,
        action: "POST",
        entityType: "StockValuation",
        entityId: valuation.id,
        newValue: {
          periodLabel: valuation.period.label,
          totalValue: totalValue.toFixed(2),
          reversedPreviousValuationId: previous?.id ?? null,
        },
      },
      tx,
    );

    return { journalEntryId: posted.entryId, journalEntryNumber: posted.entryNumber };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelStockValuationInput = {
  valuationId: string;
  reason: string;
  cancelledById: string;
};

/**
 * Cancel a posted valuation by reversing its journal entry. Refuses once a
 * later period's valuation has already reversed it as part of its own
 * posting — cancel that later one first, the same "unwind in order" rule
 * every other reversal-based document in this codebase follows.
 */
export async function cancelStockValuation(
  input: CancelStockValuationInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const valuation = await tx.stockValuation.findUnique({ where: { id: input.valuationId } });
    if (!valuation) throw new StockValuationError("Stock valuation not found.");
    if (valuation.status === "CANCELLED") throw new StockValuationError("This valuation is already cancelled.");
    if (valuation.status !== "POSTED") throw new StockValuationError("Only a posted valuation can be cancelled.");
    if (!valuation.postedEntryId) throw new StockValuationError("This valuation was never posted.");

    const entry = await tx.journalEntry.findUnique({
      where: { id: valuation.postedEntryId },
      select: { status: true },
    });
    if (entry?.status === "REVERSED") {
      throw new StockValuationError(
        "This valuation has already been superseded by a later period's closing stock. Cancel the later valuation first.",
      );
    }

    await reverseJournalEntry(
      { entryId: valuation.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    await tx.stockValuation.update({
      where: { id: valuation.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "StockValuation",
        entityId: valuation.id,
        oldValue: { status: valuation.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
