import { describe, it, expect } from "vitest";
import { gstr1Report, gstr2Report, gstr3bReport, gstTaxRateReport } from "@/lib/accounting/gstr-reports";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import {
  withRollback,
  testUserId,
  openPeriodDate,
  ensureVerifiedTaxRate,
  testProduct,
  testCustomer,
  testSupplier,
  testOrderWithLine,
  testPurchaseInvoice,
} from "./helpers/db";

/**
 * Vyapar parity step 5 (docs/VYAPAR_PARITY_SPEC.md §3.3, R13–R16).
 *
 * Reproduces the same single-sale, single-purchase scenario the real
 * Vyapar app's GSTR-1/2/3B exports were captured from
 * (`vyapar/rea-test-reports/GSTR{1,2,3B} Report_10_26_to_10_26.xlsx`) and
 * checks every figure against them: taxable 2000/1800, CGST+SGST 180/180
 * and 162/162 (intra-state, 18%), HSN quantity 2/3, "Inputs" ITC eligibility
 * carrying the full tax into "Availed ITC". Both parties are unregistered
 * (no GSTIN) in the oracle scenario, so this also exercises the b2cs/b2bur
 * paths rather than b2b — a second fixture below adds a registered
 * customer and supplier to exercise b2b/b2b.
 */

async function baseScenario(tx: Parameters<typeof testUserId>[0]) {
  const userId = await testUserId(tx);
  const date = await openPeriodDate(tx);
  await ensureVerifiedTaxRate(tx, "9999GSTR", 18);
  const product = await testProduct(tx, { hsnCode: "9999GSTR", mrp: 1000 });

  const customer = await testCustomer(tx);
  const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 2, unitPrice: 1000 });
  const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

  const supplier = await testSupplier(tx, { userId });
  const purchase = await testPurchaseInvoice(tx, {
    userId, supplierId: supplier.id, invoiceDate: date,
    items: [{ quantity: 3, unitPrice: 600, hsnCode: "9999GSTR" }],
  });
  await postPurchaseInvoice({ invoiceId: purchase.id, postedById: userId }, tx);

  const from = new Date(date.getFullYear(), date.getMonth(), 1);
  const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { userId, date, from, to, customer, supplier, invoice, purchase };
}

describe("gstr1Report() — matches GSTR1 Report_10_26_to_10_26.xlsx", () => {
  it("main sheet: one Sale row with the oracle's exact taxable/CGST/SGST", async () => {
    await withRollback(async (tx) => {
      const { from, to, invoice, customer } = await baseScenario(tx);
      const sheets = await gstr1Report(from, to, tx);
      const main = sheets.find((s) => s.name === "GSTR1 Report")!;
      const row = main.rows.find((r) => r["Invoice No."] === invoice.invoiceNumber)!;
      expect(row).toBeDefined();
      expect(row["Party Name"]).toBe(customer.name);
      expect(row["Taxable value"]).toBe(2000);
      expect(row["Central Tax Amount"]).toBe(180);
      expect(row["State/UT Tax Amount"]).toBe(180);
      expect(row["Integrated Tax Amount"]).toBe(0);
      expect(row.Rate).toBe(18);
      expect(row["Reverse Charge"]).toBe("N");
    });
  });

  it("an unregistered customer lands in b2cs, not b2b, aggregated by place of supply + rate", async () => {
    await withRollback(async (tx) => {
      const { from, to } = await baseScenario(tx);
      const sheets = await gstr1Report(from, to, tx);
      expect(sheets.find((s) => s.name === "b2b")!.rows).toHaveLength(0);
      const b2cs = sheets.find((s) => s.name === "b2cs")!.rows;
      expect(b2cs).toHaveLength(1);
      expect(b2cs[0].Type).toBe("OE");
      expect(b2cs[0].Rate).toBe(18);
      expect(b2cs[0]["Taxable Value"]).toBe(2000);
    });
  });

  it("hsn(b2c) carries the oracle's exact quantity and tax split; hsn(b2b) is empty", async () => {
    await withRollback(async (tx) => {
      const { from, to } = await baseScenario(tx);
      const sheets = await gstr1Report(from, to, tx);
      expect(sheets.find((s) => s.name === "hsn(b2b)")!.rows).toHaveLength(0);
      const hsnB2c = sheets.find((s) => s.name === "hsn(b2c)")!.rows;
      expect(hsnB2c).toHaveLength(1);
      expect(hsnB2c[0].HSN).toBe("9999GSTR");
      expect(hsnB2c[0]["Total Quantity"]).toBe(2);
      expect(hsnB2c[0]["Central Tax Amount"]).toBe(180);
      expect(hsnB2c[0]["State/UT Tax Amount"]).toBe(180);
    });
  });

  it("docs sheet reports the SALES_INVOICE serial range from DocumentSeries", async () => {
    await withRollback(async (tx) => {
      const { from, to, invoice } = await baseScenario(tx);
      const sheets = await gstr1Report(from, to, tx);
      const docs = sheets.find((s) => s.name === "docs")!.rows;
      expect(docs).toHaveLength(1);
      expect(docs[0]["Sr. No. To"]).toContain(invoice.invoiceNumber.split("/").pop());
    });
  });

  it("a GSTIN-holding customer lands in b2b, not b2cs", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "9999GSTRB2B", 18);
      const product = await testProduct(tx, { hsnCode: "9999GSTRB2B", mrp: 1000 });
      const customer = await testCustomer(tx, { gstNumber: "19AAAAA0000A1Z5" });
      const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 1000 });
      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);

      const from = new Date(date.getFullYear(), date.getMonth(), 1);
      const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const sheets = await gstr1Report(from, to, tx);
      const b2b = sheets.find((s) => s.name === "b2b")!.rows;
      const row = b2b.find((r) => r["Invoice Number"] === invoice.invoiceNumber);
      expect(row).toBeDefined();
      expect(row!["GSTIN/UIN of Recipient"]).toBe("19AAAAA0000A1Z5");
      expect(sheets.find((s) => s.name === "hsn(b2b)")!.rows).toHaveLength(1);
    });
  });
});

describe("gstr2Report() — matches GSTR2 Report_10_26_to_10_26.xlsx", () => {
  it("main sheet + b2bur: one Purchase row with the oracle's exact taxable/CGST/SGST and ITC eligibility", async () => {
    await withRollback(async (tx) => {
      const { from, to, purchase, supplier } = await baseScenario(tx);
      const sheets = await gstr2Report(from, to, tx);

      const main = sheets.find((s) => s.name === "GSTR2 Report")!;
      const mainRow = main.rows.find((r) => r["Invoice No."] === purchase.invoiceNumber)!;
      expect(mainRow["Taxable value"]).toBe(1800);
      expect(mainRow["Central Tax Amount"]).toBe(162);
      expect(mainRow["State/UT Tax Amount"]).toBe(162);

      expect(sheets.find((s) => s.name === "b2b")!.rows).toHaveLength(0);
      const b2bur = sheets.find((s) => s.name === "b2bur")!.rows;
      const row = b2bur.find((r) => r["Invoice Number"] === purchase.invoiceNumber)!;
      expect(row["Supplier Name"]).toBe(supplier.name);
      expect(row["Supply Type"]).toBe("Intra State");
      expect(row["Eligibility For ITC"]).toBe("Inputs");
      // "Inputs" is eligible — the full tax carries into Availed ITC.
      expect(row["Availed ITC Central Tax"]).toBe(162);
      expect(row["Availed ITC State/UT Tax"]).toBe(162);
    });
  });

  it("an INELIGIBLE invoice shows Availed ITC = 0 even though tax was paid", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "9999GSTRINE", 18);
      const supplier = await testSupplier(tx, { userId });
      const purchase = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        items: [{ quantity: 1, unitPrice: 1000, hsnCode: "9999GSTRINE" }],
      });
      await tx.purchaseInvoice.update({ where: { id: purchase.id }, data: { itcEligibility: "INELIGIBLE" } });
      await postPurchaseInvoice({ invoiceId: purchase.id, postedById: userId }, tx);

      const from = new Date(date.getFullYear(), date.getMonth(), 1);
      const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const sheets = await gstr2Report(from, to, tx);
      const row = sheets.find((s) => s.name === "b2bur")!.rows.find((r) => r["Invoice Number"] === purchase.invoiceNumber)!;
      expect(row["Eligibility For ITC"]).toBe("Ineligible");
      expect(row["Central Tax Paid"]).toBe(90);
      expect(row["Availed ITC Central Tax"]).toBe(0);
    });
  });

  it("hsnsum carries the oracle's exact quantity and tax split", async () => {
    await withRollback(async (tx) => {
      const { from, to } = await baseScenario(tx);
      const sheets = await gstr2Report(from, to, tx);
      const hsnsum = sheets.find((s) => s.name === "hsnsum")!.rows;
      expect(hsnsum).toHaveLength(1);
      expect(hsnsum[0]["Total Quantity"]).toBe(3);
      expect(hsnsum[0]["Central Tax Amount"]).toBe(162);
      expect(hsnsum[0]["State/UT Tax Amount"]).toBe(162);
    });
  });

  it("a legacy header-blended invoice (no per-line HSN) is excluded entirely", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const legacy = await testPurchaseInvoice(tx, { userId, supplierId: supplier.id, invoiceDate: date, totalAmount: "1050" });
      await postPurchaseInvoice({ invoiceId: legacy.id, postedById: userId }, tx);

      const from = new Date(date.getFullYear(), date.getMonth(), 1);
      const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const sheets = await gstr2Report(from, to, tx);
      const allRows = sheets.flatMap((s) => s.rows);
      expect(allRows.some((r) => r["Invoice No."] === legacy.invoiceNumber || r["Invoice Number"] === legacy.invoiceNumber)).toBe(false);
    });
  });
});

describe("gstr3bReport() — matches GSTR3B Report_10_26_to_10_26.xlsx", () => {
  it("table 3.1(a) and table 4(5) match the oracle exactly", async () => {
    await withRollback(async (tx) => {
      const { from, to } = await baseScenario(tx);
      const sheets = await gstr3bReport(from, to, tx);

      const t31 = sheets.find((s) => s.name === "3.1 Report")!.rows;
      const a = t31.find((r) => String(r["Nature of Supplies"]).startsWith("(a)"))!;
      expect(a["Total Taxable Value"]).toBe(2000);
      expect(a["Central Tax"]).toBe(180);
      expect(a["State/UT Tax"]).toBe(180);

      const t4 = sheets.find((s) => s.name === "4 Report")!.rows;
      const all5 = t4.find((r) => String(r.Details).startsWith("(5)"))!;
      expect(all5["Central Tax"]).toBe(162);
      expect(all5["State/UT Tax"]).toBe(162);
      const ineligible2 = t4.find((r) => r.Details === "(2) Others")!;
      expect(ineligible2["Central Tax"]).toBe(0);
    });
  });

  it("a reverse-charge purchase moves from 4(5) to 3.1(d) and 4(3)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "9999GSTRRC", 18);
      const supplier = await testSupplier(tx, { userId });
      const purchase = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date,
        items: [{ quantity: 1, unitPrice: 1000, hsnCode: "9999GSTRRC" }],
      });
      await tx.purchaseInvoice.update({ where: { id: purchase.id }, data: { isReverseCharge: true } });
      await postPurchaseInvoice({ invoiceId: purchase.id, postedById: userId }, tx);

      const from = new Date(date.getFullYear(), date.getMonth(), 1);
      const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const sheets = await gstr3bReport(from, to, tx);

      const t31d = sheets.find((s) => s.name === "3.1 Report")!.rows.find((r) => String(r["Nature of Supplies"]).startsWith("(d)"))!;
      expect(t31d["Central Tax"]).toBe(90);

      const t4 = sheets.find((s) => s.name === "4 Report")!.rows;
      expect(t4.find((r) => String(r.Details).startsWith("(3)"))!["Central Tax"]).toBe(90);
      expect(t4.find((r) => String(r.Details).startsWith("(5)"))!["Central Tax"]).toBe(0);
    });
  });

  it("table 5 and the zero-rated/exempt rows of 3.1 are always present and zero", async () => {
    await withRollback(async (tx) => {
      const { from, to } = await baseScenario(tx);
      const sheets = await gstr3bReport(from, to, tx);
      expect(sheets.find((s) => s.name === "5 Report")!.rows).toHaveLength(2);
      const t31 = sheets.find((s) => s.name === "3.1 Report")!.rows;
      expect(t31.find((r) => String(r["Nature of Supplies"]).startsWith("(b)"))!["Total Taxable Value"]).toBe(0);
      expect(t31.find((r) => String(r["Nature of Supplies"]).startsWith("(c)"))!["Total Taxable Value"]).toBe(0);
      expect(t31.find((r) => String(r["Nature of Supplies"]).startsWith("(e)"))!["Total Taxable Value"]).toBe(0);
    });
  });
});

describe("gstTaxRateReport()", () => {
  it("lists a verified rate with its verification status", async () => {
    await withRollback(async (tx) => {
      await ensureVerifiedTaxRate(tx, "9999GSTRRATE", 12);
      const sheets = await gstTaxRateReport(tx);
      const row = sheets[0].rows.find((r) => r.HSN === "9999GSTRRATE")!;
      expect(row).toBeDefined();
      expect(row["Rate %"]).toBe(12);
      expect(row.Verified).toBe("Yes");
    });
  });
});
