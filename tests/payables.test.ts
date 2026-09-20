import { describe, it, expect } from "vitest";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import { recordSupplierPayment } from "@/lib/accounting/supplier-payments";
import { supplierPayable, allSupplierPayables } from "@/lib/accounting/payables";
import { toAmountString } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, testSupplier, testPurchaseInvoice } from "./helpers/db";

describe("supplierPayable(): R1's mirror on the AP side", () => {
  it("is zero for a supplier with no invoices", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const supplier = await testSupplier(tx, { userId });
      expect(toAmountString(await supplierPayable(supplier.id, tx))).toBe("0.00");
    });
  });

  it("equals the invoice total right after posting, before any payment", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, totalAmount: "1050.00",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      expect(toAmountString(await supplierPayable(supplier.id, tx))).toBe("1050.00");
    });
  });

  it("drops as payments are allocated", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, totalAmount: "1050.00",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const cash = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
      await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "400.00", method: "CASH",
        paymentAccountId: cash.id, allocations: [{ invoiceId: invoice.id, amount: "400.00" }],
        createdById: userId,
      }, tx);

      expect(toAmountString(await supplierPayable(supplier.id, tx))).toBe("650.00");
    });
  });

  it("is unaffected by another supplier's invoices", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplierA = await testSupplier(tx, { userId });
      const supplierB = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplierB.id, invoiceDate: date,
        subtotal: "500.00", taxAmount: "0", totalAmount: "500.00",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      expect(toAmountString(await supplierPayable(supplierA.id, tx))).toBe("0.00");
    });
  });
});

describe("allSupplierPayables()", () => {
  it("lists only suppliers with a non-zero balance", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplierWithBalance = await testSupplier(tx, { userId });
      const supplierWithoutBalance = await testSupplier(tx, { userId });

      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplierWithBalance.id, invoiceDate: date,
        subtotal: "777.00", taxAmount: "0", totalAmount: "777.00",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const rows = await allSupplierPayables(tx);
      const ids = rows.map((r) => r.supplierId);
      expect(ids).toContain(supplierWithBalance.id);
      expect(ids).not.toContain(supplierWithoutBalance.id);

      const row = rows.find((r) => r.supplierId === supplierWithBalance.id);
      expect(row!.ledgerPayable).toBe("777.00");
    });
  });
});
