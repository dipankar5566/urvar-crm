import { describe, it, expect } from "vitest";
import { weightedAverageCost, weightedAverageCosts } from "@/lib/accounting/costing";
import { toAmountString } from "@/lib/accounting/money";
import {
  withRollback, testUserId, testProduct, testSupplier, testPurchaseInvoice,
} from "./helpers/db";

describe("weightedAverageCost()", () => {
  it("returns null when the product has no cost-relevant purchase history", async () => {
    await withRollback(async (tx) => {
      const product = await testProduct(tx);
      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(cost).toBeNull();
    });
  });

  it("returns null while the only purchase is still DRAFT", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "DRAFT",
        items: [{ productId: product.id, quantity: "10", unitPrice: "100" }],
      });

      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(cost).toBeNull();
    });
  });

  it("ignores a CANCELLED purchase invoice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "CANCELLED",
        items: [{ productId: product.id, quantity: "10", unitPrice: "100" }],
      });

      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(cost).toBeNull();
    });
  });

  it("returns the unit price exactly for a single posted purchase", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        items: [{ productId: product.id, quantity: "10", unitPrice: "150.00" }],
      });

      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(cost).not.toBeNull();
      expect(toAmountString(cost!)).toBe("150.00");
    });
  });

  it("weights across multiple purchases at different prices and quantities", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      // 10 units @ 100 = 1000, then 30 units @ 200 = 6000. Total 7000 / 40 = 175.
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        items: [{ productId: product.id, quantity: "10", unitPrice: "100" }],
      });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        items: [{ productId: product.id, quantity: "30", unitPrice: "200" }],
      });

      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(toAmountString(cost!)).toBe("175.00");
    });
  });

  it("counts PARTIALLY_PAID and PAID invoices, not just POSTED", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "PAID",
        items: [{ productId: product.id, quantity: "5", unitPrice: "80" }],
      });

      const cost = await weightedAverageCost(product.id, new Date(), tx);
      expect(toAmountString(cost!)).toBe("80.00");
    });
  });

  it("excludes a purchase dated after the as-of date", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const product = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      const early = new Date(2026, 3, 1);
      const late = new Date(2026, 8, 1);

      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        invoiceDate: early,
        items: [{ productId: product.id, quantity: "10", unitPrice: "100" }],
      });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        invoiceDate: late,
        items: [{ productId: product.id, quantity: "10", unitPrice: "500" }],
      });

      const asOfBeforeLate = new Date(2026, 4, 1);
      const cost = await weightedAverageCost(product.id, asOfBeforeLate, tx);
      expect(toAmountString(cost!)).toBe("100.00");
    });
  });
});

describe("weightedAverageCosts() (batch)", () => {
  it("returns a cost only for products with purchase history, keyed by productId", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const withHistory = await testProduct(tx);
      const withoutHistory = await testProduct(tx);
      const supplier = await testSupplier(tx, { userId });
      await testPurchaseInvoice(tx, {
        userId,
        supplierId: supplier.id,
        status: "POSTED",
        items: [{ productId: withHistory.id, quantity: "4", unitPrice: "250" }],
      });

      const costs = await weightedAverageCosts([withHistory.id, withoutHistory.id], new Date(), tx);
      expect(toAmountString(costs.get(withHistory.id)!)).toBe("250.00");
      expect(costs.has(withoutHistory.id)).toBe(false);
    });
  });

  it("returns an empty map for an empty product list", async () => {
    await withRollback(async (tx) => {
      const costs = await weightedAverageCosts([], new Date(), tx);
      expect(costs.size).toBe(0);
    });
  });
});
