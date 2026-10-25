import { describe, it, expect } from "vitest";
import { postPurchaseInvoice, cancelPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, testSupplier, testPurchaseInvoice, ensureVerifiedTaxRate,
} from "./helpers/db";

describe("postPurchaseInvoice(): intra-state", () => {
  it("splits tax into CGST+SGST and posts a balanced entry", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000.00", taxAmount: "50.00", totalAmount: "1050.00",
      });

      const result = await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("POSTED");
      expect(updated.isInterState).toBe(false);
      expect(toAmountString(updated.cgstAmount)).toBe("25.00");
      expect(toAmountString(updated.sgstAmount)).toBe("25.00");
      expect(toAmountString(updated.igstAmount)).toBe("0.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(
        toAmountString(sum(lines.map((l) => l.credit))),
      );
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("1050.00");
    });
  });

  it("folds an odd-paisa rounding drift into SGST so the split always sums exactly", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      // 33.33 / 2 = 16.665 each way; rounds to 16.67 + 16.67 = 33.34, one
      // paisa over 33.33 — the drift-correction must claw it back.
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        subtotal: "666.60", taxAmount: "33.33", totalAmount: "699.93",
      });

      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);
      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      const total = updated.cgstAmount.plus(updated.sgstAmount);
      expect(toAmountString(total)).toBe("33.33");
    });
  });
});

describe("postPurchaseInvoice(): inter-state", () => {
  it("puts the full tax into IGST", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "Karnataka" }); // company is West Bengal
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000.00", taxAmount: "50.00", totalAmount: "1050.00",
      });

      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);
      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.isInterState).toBe(true);
      expect(toAmountString(updated.igstAmount)).toBe("50.00");
      expect(toAmountString(updated.cgstAmount)).toBe("0.00");
    });
  });
});

describe("postPurchaseInvoice(): refuses to guess", () => {
  it("refuses to post while the supplier has no state on file", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: null });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date });

      await expect(
        postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx),
      ).rejects.toThrow(/no state on file/i);
    });
  });

  it("refuses to post something already posted", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date });

      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);
      await expect(
        postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx),
      ).rejects.toThrow(/only a draft invoice/i);
    });
  });
});

describe("cancelPurchaseInvoice()", () => {
  it("reverses the posting and marks the invoice cancelled", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date });
      const posted = await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      await cancelPurchaseInvoice({ invoiceId: invoice.id, reason: "Duplicate scan", cancelledById: userId }, tx);

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(updated.status).toBe("CANCELLED");
      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: posted.journalEntryId } });
      expect(entry.status).toBe("REVERSED");
    });
  });

  it("refuses to cancel an invoice with a payment allocated", async () => {
    await withRollback(async (tx) => {
      const { recordSupplierPayment } = await import("@/lib/accounting/supplier-payments");
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const invoice = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date, totalAmount: "1050.00" });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const cash = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "1121" } });
      await recordSupplierPayment({
        supplierId: supplier.id, paymentDate: date, amount: "1050.00", method: "BANK_TRANSFER",
        paymentAccountId: cash.id, allocations: [{ invoiceId: invoice.id, amount: "1050.00" }],
        createdById: userId,
      }, tx);

      await expect(
        cancelPurchaseInvoice({ invoiceId: invoice.id, reason: "Too late", cancelledById: userId }, tx),
      ).rejects.toThrow(/payments allocated/i);
    });
  });
});

describe("postPurchaseInvoice(): line-priced path (Vyapar parity step 5, G14)", () => {
  it("prices every line through the tax engine and overrides the header's OCR-read totals when every line has an HSN", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      await ensureVerifiedTaxRate(tx, "9999PGST", 18);

      // Header entered from a misread OCR scan (deliberately wrong) — the
      // line-priced path must override it with the real figures below.
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        subtotal: "1", taxAmount: "1", totalAmount: "2",
        items: [{ quantity: "3", unitPrice: "600", hsnCode: "9999PGST" }],
      });

      const result = await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      // 3 x 600 = 1800 taxable, 18% = 324 (CGST 162 + SGST 162, intra-state).
      expect(toAmountString(updated.subtotal)).toBe("1800.00");
      expect(toAmountString(updated.taxAmount)).toBe("324.00");
      expect(toAmountString(updated.totalAmount)).toBe("2124.00");
      expect(toAmountString(updated.cgstAmount)).toBe("162.00");
      expect(toAmountString(updated.sgstAmount)).toBe("162.00");
      expect(updated.supplierGstin).toBe(supplier.gstNumber);
      expect(updated.placeOfSupply).toBe("West Bengal");

      const item = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(toAmountString(item.taxableValue!)).toBe("1800.00");
      expect(Number(item.taxRatePercent)).toBe(18);
      expect(toAmountString(item.cgstAmount!)).toBe("162.00");

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("2124.00");
    });
  });

  it("falls back to the header-blended split when even one line has no HSN", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      await ensureVerifiedTaxRate(tx, "9999PGST2", 18);

      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        subtotal: "1000", taxAmount: "50", totalAmount: "1050",
        items: [
          { quantity: "1", unitPrice: "600", hsnCode: "9999PGST2" },
          { quantity: "1", unitPrice: "400" }, // no HSN — forces the fallback
        ],
      });

      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);
      const updated = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      // Unchanged header figures, exactly as before this step shipped.
      expect(toAmountString(updated.subtotal)).toBe("1000.00");
      expect(toAmountString(updated.taxAmount)).toBe("50.00");
      expect(toAmountString(updated.totalAmount)).toBe("1050.00");

      const items = await tx.purchaseInvoiceItem.findMany({ where: { invoiceId: invoice.id } });
      expect(items.every((i) => i.taxRatePercent === null)).toBe(true);
    });
  });

  it("refuses to post when a line's HSN has no verified tax rate", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        items: [{ quantity: "1", unitPrice: "100", hsnCode: "NOVERIFIEDRATE" }],
      });
      await expect(postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx)).rejects.toThrow(/verified GST rate/i);
    });
  });
});
