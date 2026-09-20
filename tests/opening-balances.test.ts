import { describe, it, expect } from "vitest";
import {
  createOpeningSalesInvoice, createOpeningPurchaseInvoice, OpeningBalanceError,
} from "@/lib/accounting/opening-balances";
import { customerReceivable } from "@/lib/accounting/receivables";
import { supplierPayable } from "@/lib/accounting/payables";
import { gstOutwardSupplyRegister, profitAndLoss } from "@/lib/accounting/financial-reports";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, testCustomer, testSupplier,
} from "./helpers/db";

describe("createOpeningSalesInvoice()", () => {
  it("posts a balanced entry to AR and Opening Balance Equity, never revenue", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx, { state: "West Bengal" });

      const result = await createOpeningSalesInvoice(
        { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-A", invoiceDate: date, amount: "19300", createdById: userId },
        tx,
      );

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("19300.00");

      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe("19300.00");

      const pnl = await profitAndLoss(date, date, tx);
      expect(pnl.income).toHaveLength(0);
    });
  });

  it("carries the source system's invoice number rather than allocating a new one", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx, { state: "West Bengal" });

      const result = await createOpeningSalesInvoice(
        { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-A", invoiceDate: date, amount: "100", createdById: userId },
        tx,
      );
      expect(result.invoiceNumber).toBe("VYP-S-TEST-FIXTURE-A");
    });
  });

  it("refuses a zero or negative amount", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx, { state: "West Bengal" });

      await expect(
        createOpeningSalesInvoice(
          { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-ZERO", invoiceDate: date, amount: "0", createdById: userId },
          tx,
        ),
      ).rejects.toThrow(OpeningBalanceError);
    });
  });

  it("refuses to import the same source invoice number twice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx, { state: "West Bengal" });

      await createOpeningSalesInvoice(
        { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-B", invoiceDate: date, amount: "2400", createdById: userId },
        tx,
      );
      await expect(
        createOpeningSalesInvoice(
          { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-B", invoiceDate: date, amount: "2400", createdById: userId },
          tx,
        ),
      ).rejects.toThrow(OpeningBalanceError);
    });
  });

  it("is excluded from the GST outward-supply register", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx, { state: "West Bengal" });

      await createOpeningSalesInvoice(
        { customerId: customer.id, sourceInvoiceNumber: "TEST-FIXTURE-A", invoiceDate: date, amount: "19300", createdById: userId },
        tx,
      );

      const rows = await gstOutwardSupplyRegister(date, date, tx);
      expect(rows).toHaveLength(0);
    });
  });
});

describe("createOpeningPurchaseInvoice()", () => {
  it("posts a balanced entry to AP and Opening Balance Equity, never purchases", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });

      const result = await createOpeningPurchaseInvoice(
        { supplierId: supplier.id, sourceReference: "TEST-FIXTURE-PURCHASE", invoiceDate: date, amount: "15436", createdById: userId },
        tx,
      );

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));

      const pnl = await profitAndLoss(date, date, tx);
      expect(pnl.expenses).toHaveLength(0);

      expect(toAmountString(await supplierPayable(supplier.id, tx))).toBe("15436.00");
    });
  });

  it("refuses to import the same source reference twice for the same supplier", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });

      await createOpeningPurchaseInvoice(
        { supplierId: supplier.id, sourceReference: "TEST-FIXTURE-PURCHASE", invoiceDate: date, amount: "100", createdById: userId },
        tx,
      );
      await expect(
        createOpeningPurchaseInvoice(
          { supplierId: supplier.id, sourceReference: "TEST-FIXTURE-PURCHASE", invoiceDate: date, amount: "100", createdById: userId },
          tx,
        ),
      ).rejects.toThrow(OpeningBalanceError);
    });
  });
});
