import { describe, it, expect } from "vitest";
import {
  createStockValuation, deleteStockValuationDraft, postStockValuation, cancelStockValuation,
  StockValuationError,
} from "@/lib/accounting/stock-valuation";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, testProduct, testSupplier, testPurchaseInvoice,
} from "./helpers/db";
import type { Prisma } from "@/generated/prisma/client";

/** Two distinct OPEN financial periods, ordered by start date, for roll-forward tests. */
async function twoOpenPeriods(tx: Prisma.TransactionClient) {
  const periods = await tx.financialPeriod.findMany({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
    take: 2,
  });
  if (periods.length < 2) {
    throw new Error("Need at least two OPEN financial periods. Run npm run db:seed-accounting and open the FY.");
  }
  return periods as [typeof periods[number], typeof periods[number]];
}

describe("createStockValuation()", () => {
  it("computes value from a manual unit cost when no purchase history exists", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "20", unitCost: "45.50" }],
          createdById: userId,
        },
        tx,
      );

      const valuation = await tx.stockValuation.findUniqueOrThrow({
        where: { id: valuationId },
        include: { lines: true },
      });
      expect(valuation.status).toBe("DRAFT");
      expect(toAmountString(valuation.totalValue)).toBe("910.00");
      expect(valuation.lines[0].costSource).toBe("MANUAL");
    });
  });

  it("uses the weighted-average cost when no manual override is given", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, status: "POSTED", invoiceDate: period.startDate,
        items: [{ productId: product.id, quantity: "10", unitPrice: "60" }],
      });

      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "5" }],
          createdById: userId,
        },
        tx,
      );

      const valuation = await tx.stockValuation.findUniqueOrThrow({
        where: { id: valuationId },
        include: { lines: true },
      });
      expect(valuation.lines[0].costSource).toBe("WEIGHTED_AVERAGE");
      // unitCost is stored at 4dp (Decimal(14,4)), not the 2dp money scale —
      // toAmountString() would silently truncate it, so compare the raw value.
      expect(valuation.lines[0].unitCost.toFixed(4)).toBe("60.0000");
      expect(toAmountString(valuation.totalValue)).toBe("300.00");
    });
  });

  it("refuses a product with no purchase history and no manual cost", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      await expect(
        createStockValuation(
          {
            periodId: period.id,
            valuationDate: period.endDate,
            lines: [{ productId: product.id, quantityOnHand: "5" }],
            createdById: userId,
          },
          tx,
        ),
      ).rejects.toThrow(StockValuationError);
    });
  });

  it("refuses a duplicate product within one valuation", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      await expect(
        createStockValuation(
          {
            periodId: period.id,
            valuationDate: period.endDate,
            lines: [
              { productId: product.id, quantityOnHand: "5", unitCost: "10" },
              { productId: product.id, quantityOnHand: "3", unitCost: "10" },
            ],
            createdById: userId,
          },
          tx,
        ),
      ).rejects.toThrow(StockValuationError);
    });
  });

  it("refuses a second valuation for a period that already has one", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "5", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );

      await expect(
        createStockValuation(
          {
            periodId: period.id,
            valuationDate: period.endDate,
            lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
            createdById: userId,
          },
          tx,
        ),
      ).rejects.toThrow(StockValuationError);
    });
  });

  it("refuses a negative quantity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      await expect(
        createStockValuation(
          {
            periodId: period.id,
            valuationDate: period.endDate,
            lines: [{ productId: product.id, quantityOnHand: "-1", unitCost: "10" }],
            createdById: userId,
          },
          tx,
        ),
      ).rejects.toThrow(StockValuationError);
    });
  });
});

describe("deleteStockValuationDraft()", () => {
  it("deletes a DRAFT valuation outright", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );

      await deleteStockValuationDraft({ valuationId, deletedById: userId }, tx);
      const gone = await tx.stockValuation.findUnique({ where: { id: valuationId } });
      expect(gone).toBeNull();
    });
  });

  it("refuses to delete a POSTED valuation", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId, postedById: userId }, tx);

      await expect(deleteStockValuationDraft({ valuationId, deletedById: userId }, tx)).rejects.toThrow(
        StockValuationError,
      );
    });
  });
});

describe("postStockValuation()", () => {
  it("posts a balanced Dr Inventory / Cr COGS entry for the total value", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "10", unitCost: "25" }],
          createdById: userId,
        },
        tx,
      );

      const result = await postStockValuation({ valuationId, postedById: userId }, tx);

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("250.00");
      expect(toAmountString(sum(lines.map((l) => l.credit)))).toBe("250.00");

      const valuation = await tx.stockValuation.findUniqueOrThrow({ where: { id: valuationId } });
      expect(valuation.status).toBe("POSTED");
      expect(valuation.postedEntryId).toBe(result.journalEntryId);
    });
  });

  it("refuses to post a valuation with no lines", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      // Bypass createStockValuation's own "at least one line" guard to reach
      // postStockValuation's own defense directly.
      const company = await tx.company.findFirstOrThrow();
      const empty = await tx.stockValuation.create({
        data: { companyId: company.id, periodId: period.id, valuationDate: period.endDate, totalValue: "0", createdById: userId },
      });

      await expect(postStockValuation({ valuationId: empty.id, postedById: userId }, tx)).rejects.toThrow(
        StockValuationError,
      );
    });
  });

  it("refuses to post an already-posted valuation twice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId, postedById: userId }, tx);

      await expect(postStockValuation({ valuationId, postedById: userId }, tx)).rejects.toThrow(
        StockValuationError,
      );
    });
  });

  it("reverses the previous period's posted valuation, dated at this period's start", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period1, period2] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      const v1 = await createStockValuation(
        {
          periodId: period1.id,
          valuationDate: period1.endDate,
          lines: [{ productId: product.id, quantityOnHand: "10", unitCost: "30" }],
          createdById: userId,
        },
        tx,
      );
      const posted1 = await postStockValuation({ valuationId: v1.valuationId, postedById: userId }, tx);

      const v2 = await createStockValuation(
        {
          periodId: period2.id,
          valuationDate: period2.endDate,
          lines: [{ productId: product.id, quantityOnHand: "4", unitCost: "30" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId: v2.valuationId, postedById: userId }, tx);

      const original = await tx.journalEntry.findUniqueOrThrow({
        where: { id: posted1.journalEntryId },
        include: { reversedBy: true },
      });
      expect(original.status).toBe("REVERSED");
      expect(original.reversedBy).not.toBeNull();
      expect(original.reversedBy!.entryDate.toISOString().slice(0, 10)).toBe(
        period2.startDate.toISOString().slice(0, 10),
      );
    });
  });
});

describe("cancelStockValuation()", () => {
  it("reverses a posted valuation and marks it CANCELLED", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);
      const { valuationId } = await createStockValuation(
        {
          periodId: period.id,
          valuationDate: period.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId, postedById: userId }, tx);

      await cancelStockValuation({ valuationId, reason: "Recount found an error.", cancelledById: userId }, tx);

      const valuation = await tx.stockValuation.findUniqueOrThrow({ where: { id: valuationId } });
      expect(valuation.status).toBe("CANCELLED");
    });
  });

  it("refuses to cancel a valuation already superseded by a later period's posting", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const [period1, period2] = await twoOpenPeriods(tx);
      const product = await testProduct(tx);

      const v1 = await createStockValuation(
        {
          periodId: period1.id,
          valuationDate: period1.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId: v1.valuationId, postedById: userId }, tx);

      const v2 = await createStockValuation(
        {
          periodId: period2.id,
          valuationDate: period2.endDate,
          lines: [{ productId: product.id, quantityOnHand: "1", unitCost: "10" }],
          createdById: userId,
        },
        tx,
      );
      await postStockValuation({ valuationId: v2.valuationId, postedById: userId }, tx);

      await expect(
        cancelStockValuation({ valuationId: v1.valuationId, reason: "Too late.", cancelledById: userId }, tx),
      ).rejects.toThrow(StockValuationError);
    });
  });
});
