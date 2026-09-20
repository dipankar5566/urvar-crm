import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { div, money, type Money } from "./money";

/**
 * Weighted-average product costing (Phase 4).
 *
 * The CRM runs periodic, not perpetual, inventory costing — see the schema
 * comment above `StockValuation`. This module answers one question: "what
 * has this product cost us to buy, on average, as of a given date?" It never
 * answers "how many are left" — that is the ERP's job and is out of scope
 * here (the postgres_fdw contract to read it live has never been wired into
 * production; see docs/ACCOUNTING_IMPLEMENTATION_PLAN.md).
 */

export class CostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostingError";
  }
}

/** Purchase invoice statuses whose lines represent real, booked cost. */
const COST_RELEVANT_PURCHASE_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

/**
 * Weighted-average cost per unit for a product, from its own posted purchase
 * history up to (and including) `asOfDate`.
 *
 * `PurchaseInvoiceItem.lineTotal` is the pre-tax taxable value (GST is split
 * separately at the header and posted to GST_INPUT_*, never to the item), so
 * this average excludes recoverable input tax by construction — exactly the
 * right cost basis for a registered regular taxpayer claiming ITC.
 *
 * Returns `null` when the product has no cost-relevant purchase on file as of
 * that date. A `null` means "unknown," never "zero" — callers must not
 * substitute a default.
 */
export async function weightedAverageCost(
  productId: string,
  asOfDate: Date,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money | null> {
  const agg = await db.purchaseInvoiceItem.aggregate({
    where: {
      productId,
      invoice: {
        status: { in: [...COST_RELEVANT_PURCHASE_STATUSES] },
        invoiceDate: { lte: asOfDate },
      },
    },
    _sum: { lineTotal: true, quantity: true },
  });

  const totalCost = agg._sum.lineTotal;
  const totalQty = agg._sum.quantity;
  if (!totalCost || !totalQty || money(totalQty).isZero()) return null;

  return div(totalCost, totalQty);
}

/**
 * Weighted-average cost for several products at once, as of the same date.
 * One query instead of N — used when pricing every line of an invoice or
 * every product in a stock valuation.
 */
export async function weightedAverageCosts(
  productIds: string[],
  asOfDate: Date,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, Money>> {
  const result = new Map<string, Money>();
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length === 0) return result;

  const rows = await db.purchaseInvoiceItem.groupBy({
    by: ["productId"],
    where: {
      productId: { in: uniqueIds },
      invoice: {
        status: { in: [...COST_RELEVANT_PURCHASE_STATUSES] },
        invoiceDate: { lte: asOfDate },
      },
    },
    _sum: { lineTotal: true, quantity: true },
  });

  for (const row of rows) {
    if (!row.productId) continue;
    const totalCost = row._sum.lineTotal;
    const totalQty = row._sum.quantity;
    if (!totalCost || !totalQty || money(totalQty).isZero()) continue;
    result.set(row.productId, div(totalCost, totalQty));
  }
  return result;
}
