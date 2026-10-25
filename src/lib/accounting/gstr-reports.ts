import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { gstOutwardSupplyRegister } from "./financial-reports";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { DOCUMENT_TYPES } from "./numbering";
import { add, money, sum, toAmountString, type Money, type MoneyInput } from "./money";

/**
 * Vyapar parity step 5 (docs/VYAPAR_PARITY_SPEC.md §3.3, R13–R16): GSTR-1,
 * GSTR-2, GSTR-3B and the GST Tax Rate report.
 *
 * Labelled "for review, not for filing" everywhere these are surfaced — see
 * the spec's own framing. Every sheet here was shaped against a real
 * Vyapar GSTR-1/2/3B export (`vyapar/rea-test-reports/GSTR*.xlsx`), not
 * guessed at from the GST portal's documentation, but several sheets
 * Vyapar's own test export carried are not implemented because Urvar has
 * no data behind them — documented inline at each one, not silently
 * dropped.
 *
 * Returns `ReportSheet[]` directly (not Money-typed rows some other
 * function then flattens) — unlike `report-registry.ts`'s other entries,
 * these functions exist only to produce a portal-format export, so there
 * is no second consumer that would want Decimal precision back.
 */

type Db = Prisma.TransactionClient | typeof prisma;
export type ExportRow = Record<string, string | number>;
export type ReportSheet = { name: string; rows: ExportRow[] };

const n = (m: MoneyInput): number => Number(toAmountString(m));
const dmy = (d: Date): string =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

const ITC_LABELS: Record<string, string> = {
  INPUTS: "Inputs",
  CAPITAL_GOODS: "Capital goods",
  INPUT_SERVICES: "Input services",
  INELIGIBLE: "Ineligible",
};

// ============================================================ R13 — GSTR-1

type SaleGroup = {
  invoiceNumber: string;
  invoiceDate: Date;
  partyName: string;
  gstin: string | null;
  placeOfSupply: string;
  rate: number;
  taxable: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
};

/**
 * Every GSTR-1 sheet this scenario can support. Not implemented, because
 * Urvar has no data behind them (confirmed against the oracle, which
 * carries the sheet but every figure is zero/empty for a domestic-only,
 * non-e-commerce, non-exporting company exactly like Urvar): `b2cl`
 * (large B2C — a dying provision, and Urvar's catalogue has no invoice
 * near its threshold), `exp` (exports), `at`/`atadj` (advances received —
 * not tracked separately from the invoice they're later applied to).
 */
export async function gstr1Report(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ReportSheet[]> {
  const outward = await gstOutwardSupplyRegister(fromDate, toDate, db);

  const byInvoiceRate = new Map<string, SaleGroup>();
  for (const r of outward) {
    const key = `${r.invoiceId}:${r.taxRatePercent.toFixed(2)}`;
    const g = byInvoiceRate.get(key) ?? {
      invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate, partyName: r.customerName, gstin: r.customerGstin,
      placeOfSupply: r.placeOfSupply, rate: Number(r.taxRatePercent), taxable: money(0), cgst: money(0), sgst: money(0), igst: money(0), cess: money(0),
    };
    g.taxable = add(g.taxable, r.taxableValue);
    g.cgst = add(g.cgst, r.cgst);
    g.sgst = add(g.sgst, r.sgst);
    g.igst = add(g.igst, r.igst);
    g.cess = add(g.cess, r.cess);
    byInvoiceRate.set(key, g);
  }
  const groups = [...byInvoiceRate.values()];
  const invoiceValue = (g: SaleGroup) => n(sum([g.taxable, g.cgst, g.sgst, g.igst, g.cess]));

  const mainRows: ExportRow[] = groups.map((g) => ({
    "GSTIN/UIN": g.gstin ?? "",
    "Party Name": g.partyName,
    "Transaction Type": "Sale",
    "Invoice No.": g.invoiceNumber,
    "Invoice Date": dmy(g.invoiceDate),
    "Invoice Value": invoiceValue(g),
    Rate: g.rate,
    "Cess Rate": 0,
    "Taxable value": n(g.taxable),
    "Reverse Charge": "N",
    "Integrated Tax Amount": n(g.igst),
    "Central Tax Amount": n(g.cgst),
    "State/UT Tax Amount": n(g.sgst),
    "Cess Amount": n(g.cess),
    "Place of Supply(Name of state)": g.placeOfSupply,
  }));

  const b2bRows: ExportRow[] = groups
    .filter((g) => g.gstin)
    .map((g) => ({
      "GSTIN/UIN of Recipient": g.gstin!,
      "Receiver Name": g.partyName,
      "Invoice Number": g.invoiceNumber,
      "Invoice date": dmy(g.invoiceDate),
      "Invoice Value": invoiceValue(g),
      "Place Of Supply": g.placeOfSupply,
      "Reverse Charge": "N",
      "Invoice Type": "Regular",
      Rate: g.rate,
      "Taxable Value": n(g.taxable),
      "Cess Amount": n(g.cess),
    }));

  const b2cs = new Map<string, { placeOfSupply: string; rate: number; taxable: Money; cess: Money }>();
  for (const g of groups.filter((g) => !g.gstin)) {
    const key = `${g.placeOfSupply}:${g.rate}`;
    const e = b2cs.get(key) ?? { placeOfSupply: g.placeOfSupply, rate: g.rate, taxable: money(0), cess: money(0) };
    e.taxable = add(e.taxable, g.taxable);
    e.cess = add(e.cess, g.cess);
    b2cs.set(key, e);
  }
  const b2csRows: ExportRow[] = [...b2cs.values()].map((e) => ({
    Type: "OE",
    "Place Of Supply": e.placeOfSupply,
    "Applicable % of Tax Rate": "",
    Rate: e.rate,
    "Taxable Value": n(e.taxable),
    "Cess Amount": n(e.cess),
  }));

  const creditNotes = await db.creditNote.findMany({
    where: { cancelledAt: null, postedAt: { not: null }, noteDate: { gte: fromDate, lte: toDate } },
    include: { customer: { select: { name: true, gstNumber: true } } },
    orderBy: { noteDate: "asc" },
  });
  const noteRow = (cn: (typeof creditNotes)[number]): ExportRow => {
    const tax = sum([cn.cgstAmount, cn.sgstAmount, cn.igstAmount, cn.cessAmount]);
    const rate = cn.subtotal.isZero() ? 0 : Math.round(tax.dividedBy(cn.subtotal).times(100).toNumber());
    return {
      "GSTIN/UIN of Recipient": cn.customer.gstNumber ?? "",
      "Receiver Name": cn.customer.name,
      "Note Number": cn.creditNoteNumber,
      "Note Date": dmy(cn.noteDate),
      "Note Type": "C",
      "Place Of Supply": cn.placeOfSupply,
      "Reverse Charge": "N",
      "Note Supply Type": "B2B",
      "Note Value": n(cn.totalAmount),
      "Applicable % of Tax Rate": rate,
      Rate: rate,
      "Taxable Value": n(cn.subtotal),
      "Cess Amount": n(cn.cessAmount),
    };
  };
  const cdnrRows = creditNotes.filter((cn) => cn.customer.gstNumber).map(noteRow);
  const cdnurRows = creditNotes.filter((cn) => !cn.customer.gstNumber).map(noteRow);

  const hsnB2b = new Map<string, { taxable: Money; cgst: Money; sgst: Money; igst: Money; cess: Money; qty: Money; value: Money }>();
  const hsnB2c = new Map<string, { taxable: Money; cgst: Money; sgst: Money; igst: Money; cess: Money; qty: Money; value: Money }>();
  for (const r of outward) {
    const target = r.customerGstin ? hsnB2b : hsnB2c;
    const e = target.get(r.hsnCode) ?? { taxable: money(0), cgst: money(0), sgst: money(0), igst: money(0), cess: money(0), qty: money(0), value: money(0) };
    e.taxable = add(e.taxable, r.taxableValue);
    e.cgst = add(e.cgst, r.cgst);
    e.sgst = add(e.sgst, r.sgst);
    e.igst = add(e.igst, r.igst);
    e.cess = add(e.cess, r.cess);
    e.value = add(e.value, r.total);
    e.qty = add(e.qty, r.quantity);
    target.set(r.hsnCode, e);
  }
  const hsnRows = (map: typeof hsnB2b): ExportRow[] =>
    [...map.entries()].map(([hsn, e]) => ({
      HSN: hsn,
      Description: "",
      UQC: "OTH-OTHERS",
      "Total Quantity": n(e.qty),
      "Total Value": n(e.value),
      Rate: e.taxable.isZero() ? 0 : Math.round(sum([e.cgst, e.sgst, e.igst]).dividedBy(e.taxable).times(100).toNumber()),
      "Taxable Value": n(e.taxable),
      "Integrated Tax Amount": n(e.igst),
      "Central Tax Amount": n(e.cgst),
      "State/UT Tax Amount": n(e.sgst),
      "Cess Amount": n(e.cess),
    }));

  const exempRows: ExportRow[] = [
    { Description: "Inter-State supplies to registered persons", "Nil Rated Supplies": 0, "Exempted": 0, "Non-GST Supplies": 0 },
    { Description: "Intra-State supplies to registered persons", "Nil Rated Supplies": 0, "Exempted": 0, "Non-GST Supplies": 0 },
    { Description: "Inter-State supplies to unregistered persons", "Nil Rated Supplies": 0, "Exempted": 0, "Non-GST Supplies": 0 },
    { Description: "Intra-State supplies to unregistered persons", "Nil Rated Supplies": 0, "Exempted": 0, "Non-GST Supplies": 0 },
  ];

  const docsRows = await docsSheet(toDate, db);

  return [
    { name: "GSTR1 Report", rows: mainRows },
    { name: "b2b", rows: b2bRows },
    { name: "b2cs", rows: b2csRows },
    { name: "cdnr", rows: cdnrRows },
    { name: "cdnur", rows: cdnurRows },
    { name: "exemp", rows: exempRows },
    { name: "hsn(b2b)", rows: hsnRows(hsnB2b) },
    { name: "hsn(b2c)", rows: hsnRows(hsnB2c) },
    { name: "docs", rows: docsRows },
  ];
}

/** Document serial range + cancelled count for the "docs" sheet (R13), from DocumentSeries — the gapless, per-FY counter every invoice number already comes from. */
async function docsSheet(asOf: Date, db: Db): Promise<ExportRow[]> {
  const company = await requireCompany(db);
  const fy = financialYearOf(asOf, company.fyStartMonth);
  const series = await db.documentSeries.findUnique({
    where: { companyId_documentType_financialYear: { companyId: company.id, documentType: DOCUMENT_TYPES.SALES_INVOICE, financialYear: fy } },
  });
  if (!series || series.nextNumber <= 1) return [];
  const pad = (num: number) => String(num).padStart(series.padding, "0");
  const cancelled = await db.salesInvoice.count({ where: { status: "CANCELLED" } });
  return [
    {
      "Nature of Document": "Invoices for outward supply",
      "Sr. No. From": `${series.prefix}${pad(1)}`,
      "Sr. No. To": `${series.prefix}${pad(series.nextNumber - 1)}`,
      "Total Number": series.nextNumber - 1,
      Cancelled: cancelled,
    },
  ];
}

// ============================================================ R14 — GSTR-2

type PurchaseGroup = {
  invoiceNumber: string;
  invoiceDate: Date;
  supplierName: string;
  supplierGstin: string | null;
  placeOfSupply: string | null;
  isInterState: boolean | null;
  itcEligibility: string;
  rate: number;
  taxable: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
};

/**
 * Not implemented, same "no data behind it" reasoning as GSTR-1: `imps`/
 * `impg` (imports — Urvar has no import purchases), `at`/`atadj` (advance
 * paid under reverse charge — not tracked). `cdnr`/`cdnur` (debit notes
 * from suppliers) are returned with no rows — there is no `DebitNote`
 * model at all yet, only the `DEBIT_NOTE` enum value reserved for one.
 * Only purchases on the line-priced path (G14 — every item has an HSN)
 * contribute at all; a legacy header-blended invoice has no per-line rate
 * to report and is excluded, not guessed at.
 */
export async function gstr2Report(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ReportSheet[]> {
  const items = await db.purchaseInvoiceItem.findMany({
    where: {
      taxRatePercent: { not: null },
      invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } },
    },
    include: { invoice: { include: { supplier: { select: { name: true } } } } },
  });

  const byInvoiceRate = new Map<string, PurchaseGroup>();
  for (const item of items) {
    const inv = item.invoice;
    const key = `${item.invoiceId}:${item.taxRatePercent!.toFixed(2)}`;
    const g = byInvoiceRate.get(key) ?? {
      invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, supplierName: inv.supplier.name, supplierGstin: inv.supplierGstin,
      placeOfSupply: inv.placeOfSupply, isInterState: inv.isInterState, itcEligibility: inv.itcEligibility,
      rate: Number(item.taxRatePercent), taxable: money(0), cgst: money(0), sgst: money(0), igst: money(0), cess: money(0),
    };
    g.taxable = add(g.taxable, item.taxableValue!);
    g.cgst = add(g.cgst, item.cgstAmount!);
    g.sgst = add(g.sgst, item.sgstAmount!);
    g.igst = add(g.igst, item.igstAmount!);
    g.cess = add(g.cess, item.cessAmount!);
    byInvoiceRate.set(key, g);
  }
  const groups = [...byInvoiceRate.values()];
  const invoiceValue = (g: PurchaseGroup) => n(sum([g.taxable, g.cgst, g.sgst, g.igst, g.cess]));
  const eligible = (g: PurchaseGroup) => g.itcEligibility !== "INELIGIBLE";
  const availed = (v: Money, g: PurchaseGroup) => (eligible(g) ? n(v) : 0);

  const mainRows: ExportRow[] = groups.map((g) => ({
    "GSTIN/UIN": g.supplierGstin ?? "",
    "Party Name": g.supplierName,
    "Transaction Type": "Purchase",
    "Invoice No.": g.invoiceNumber,
    "Invoice Date": dmy(g.invoiceDate),
    "Invoice Value": invoiceValue(g),
    Rate: g.rate,
    "Cess Rate": 0,
    "Taxable value": n(g.taxable),
    "Integrated Tax Amount": n(g.igst),
    "Central Tax Amount": n(g.cgst),
    "State/UT Tax Amount": n(g.sgst),
    "Cess Amount": n(g.cess),
    "Place of Supply(Name of state)": g.placeOfSupply ?? "",
  }));

  const b2bRows: ExportRow[] = groups
    .filter((g) => g.supplierGstin)
    .map((g) => ({
      "GSTIN of Supplier": g.supplierGstin!,
      "Invoice Number": g.invoiceNumber,
      "Invoice date": dmy(g.invoiceDate),
      "Invoice Value": invoiceValue(g),
      "Place Of Supply": g.placeOfSupply ?? "",
      "Reverse Charge": "N",
      "Invoice Type": "Regular",
      Rate: g.rate,
      "Taxable Value": n(g.taxable),
      "Integrated Tax Paid": n(g.igst),
      "Central Tax Paid": n(g.cgst),
      "State/UT Tax Paid": n(g.sgst),
      "Cess Paid": n(g.cess),
      "Eligibility For ITC": ITC_LABELS[g.itcEligibility],
      "Availed ITC Integrated Tax": availed(g.igst, g),
      "Availed ITC Central Tax": availed(g.cgst, g),
      "Availed ITC State/UT Tax": availed(g.sgst, g),
      "Availed ITC Cess": availed(g.cess, g),
    }));

  const b2burRows: ExportRow[] = groups
    .filter((g) => !g.supplierGstin)
    .map((g) => ({
      "Supplier Name": g.supplierName,
      "Invoice Number": g.invoiceNumber,
      "Invoice date": dmy(g.invoiceDate),
      "Invoice Value": invoiceValue(g),
      "Place Of Supply": g.placeOfSupply ?? "",
      "Supply Type": g.isInterState ? "Inter State" : "Intra State",
      Rate: g.rate,
      "Taxable Value": n(g.taxable),
      "Integrated Tax Paid": n(g.igst),
      "Central Tax Paid": n(g.cgst),
      "State/UT Tax Paid": n(g.sgst),
      "Cess Paid": n(g.cess),
      "Eligibility For ITC": ITC_LABELS[g.itcEligibility],
      "Availed ITC Integrated Tax": availed(g.igst, g),
      "Availed ITC Central Tax": availed(g.cgst, g),
      "Availed ITC State/UT Tax": availed(g.sgst, g),
      "Availed ITC Cess": availed(g.cess, g),
    }));

  const hsnsum = new Map<string, { qty: Money; value: Money; taxable: Money; cgst: Money; sgst: Money; igst: Money; cess: Money }>();
  for (const item of items) {
    const e = hsnsum.get(item.hsnCode!) ?? { qty: money(0), value: money(0), taxable: money(0), cgst: money(0), sgst: money(0), igst: money(0), cess: money(0) };
    e.qty = add(e.qty, item.quantity);
    e.value = add(e.value, item.lineTotal);
    e.taxable = add(e.taxable, item.taxableValue!);
    e.cgst = add(e.cgst, item.cgstAmount!);
    e.sgst = add(e.sgst, item.sgstAmount!);
    e.igst = add(e.igst, item.igstAmount!);
    e.cess = add(e.cess, item.cessAmount!);
    hsnsum.set(item.hsnCode!, e);
  }
  const hsnsumRows: ExportRow[] = [...hsnsum.entries()].map(([hsn, e]) => ({
    HSN: hsn,
    Description: "",
    UQC: "OTH-OTHERS",
    "Total Quantity": n(e.qty),
    "Total Value": n(e.value),
    "Taxable Value": n(e.taxable),
    "Integrated Tax Amount": n(e.igst),
    "Central Tax Amount": n(e.cgst),
    "State/UT Tax Amount": n(e.sgst),
    "Cess Amount": n(e.cess),
  }));

  const exempRows: ExportRow[] = [
    { Description: "Inter-State supplies", "Composition taxable person": 0, "Nil Rated Supplies": 0, Exempted: 0, "Non-GST Supplies": 0 },
    { Description: "Intra-State supplies", "Composition taxable person": 0, "Nil Rated Supplies": 0, Exempted: 0, "Non-GST Supplies": 0 },
  ];
  const itcrRows: ExportRow[] = [
    "(a) Amount in terms of rule 37 (2)",
    "(b) Amount in terms of rule 42 (1) (m)",
    "(c) Amount in terms of rule 43(1) (h)",
    "(d) Amount in terms of rule 42 (2)(a)",
    "(e) Amount in terms of rule 42(2)(b)",
    "(f) On account of amount paid subsequent to reversal of ITC",
    "(g) Any other liability (Specify)",
  ].map((desc) => ({ "Description for reversal of ITC": desc, "ITC Integrated Tax Amount": 0, "ITC Central Tax Amount": 0, "ITC State/UT Tax Amount": 0, "ITC Cess Amount": 0 }));

  return [
    { name: "GSTR2 Report", rows: mainRows },
    { name: "b2b", rows: b2bRows },
    { name: "b2bur", rows: b2burRows },
    { name: "cdnr", rows: [] },
    { name: "cdnur", rows: [] },
    { name: "exemp", rows: exempRows },
    { name: "itcr", rows: itcrRows },
    { name: "hsnsum", rows: hsnsumRows },
  ];
}

// ============================================================ R15 — GSTR-3B

/**
 * Table 4(A)(1)/(2) (imports) and 4(A)(4) (ISD) are always zero — Urvar
 * tracks neither. 4(D)(1) "Section 17(5)" is always zero: `itcEligibility`
 * has no way to say *which* ineligibility rule applies, only that one does,
 * so every ineligible purchase lands in 4(D)(2) "Others". Table 5 is
 * always zero — composition/exempt/non-GST inward supplies aren't tracked.
 * 3.1(a) is gross outward supply, not net of credit notes (GSTR-1's
 * cdnr/cdnur carry those separately) — netting them needs a filing-grade
 * reconciliation this "for review" report doesn't attempt.
 */
export async function gstr3bReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ReportSheet[]> {
  const outward = await gstOutwardSupplyRegister(fromDate, toDate, db);
  const taxableA = sum(outward.map((r) => r.taxableValue));
  const igstA = sum(outward.map((r) => r.igst));
  const cgstA = sum(outward.map((r) => r.cgst));
  const sgstA = sum(outward.map((r) => r.sgst));
  const cessA = sum(outward.map((r) => r.cess));

  const purchases = await db.purchaseInvoice.findMany({
    where: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } },
  });
  const reverseCharge = purchases.filter((p) => p.isReverseCharge);
  const normalEligible = purchases.filter((p) => !p.isReverseCharge && p.itcEligibility !== "INELIGIBLE");
  const ineligible = purchases.filter((p) => !p.isReverseCharge && p.itcEligibility === "INELIGIBLE");

  const taxTotals = (rows: typeof purchases) => ({
    igst: sum(rows.map((p) => p.igstAmount)), cgst: sum(rows.map((p) => p.cgstAmount)), sgst: sum(rows.map((p) => p.sgstAmount)), cess: sum(rows.map((p) => p.cessAmount)),
  });
  const rc = taxTotals(reverseCharge);
  const other = taxTotals(normalEligible);
  const inel = taxTotals(ineligible);

  const zeroRow = (label: string): ExportRow => ({ "Nature of Supplies": label, "Total Taxable Value": 0, "Integrated Tax": 0, "Central Tax": 0, "State/UT Tax": 0, Cess: 0 });
  const table3_1: ExportRow[] = [
    { "Nature of Supplies": "(a) Outward taxable supplies (other than zero rated, nil rated and exempted", "Total Taxable Value": n(taxableA), "Integrated Tax": n(igstA), "Central Tax": n(cgstA), "State/UT Tax": n(sgstA), Cess: n(cessA) },
    zeroRow("(b) Outward taxable supplies (zero rated)"),
    zeroRow("(c) Other outward supplies (nil rated, exempted)"),
    { "Nature of Supplies": "(d) Inward supplies (liable to reverse charge)", "Total Taxable Value": n(sum(reverseCharge.map((p) => p.subtotal))), "Integrated Tax": n(rc.igst), "Central Tax": n(rc.cgst), "State/UT Tax": n(rc.sgst), Cess: n(rc.cess) },
    zeroRow("(e) Non-GST outward supplies"),
  ];

  const interstateB2C = await db.salesInvoice.findMany({
    where: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate }, isInterState: true, customerGstin: null },
    select: { placeOfSupply: true, subtotal: true, igstAmount: true },
  });
  const byState = new Map<string, { taxable: Money; igst: Money }>();
  for (const inv of interstateB2C) {
    const e = byState.get(inv.placeOfSupply) ?? { taxable: money(0), igst: money(0) };
    e.taxable = add(e.taxable, inv.subtotal);
    e.igst = add(e.igst, inv.igstAmount);
    byState.set(inv.placeOfSupply, e);
  }
  const table3_2: ExportRow[] = [...byState.entries()].map(([state, e]) => ({
    "Place of Supply (State/UT)": state,
    "Total taxable value (unregistered)": n(e.taxable),
    "Amount of integrated tax (unregistered)": n(e.igst),
    "Total taxable value (composition)": 0,
    "Amount of integrated tax (composition)": 0,
    "Total taxable value (UIN)": 0,
    "Amount of integrated tax (UIN)": 0,
  }));

  const table4: ExportRow[] = [
    { Details: "(A) ITC Available (Whether in full or part)", "Integrated Tax": "", "Central Tax": "", "State/UT Tax": "", Cess: "" },
    { Details: "(1) Import of goods", "Integrated Tax": 0, "Central Tax": 0, "State/UT Tax": 0, Cess: 0 },
    { Details: "(2) Import of services", "Integrated Tax": 0, "Central Tax": 0, "State/UT Tax": 0, Cess: 0 },
    { Details: "(3) Inward supplies liable to reverse charge( other than 1 & 2 above)", "Integrated Tax": n(rc.igst), "Central Tax": n(rc.cgst), "State/UT Tax": n(rc.sgst), Cess: n(rc.cess) },
    { Details: "(4) Inward supplies from ISD", "Integrated Tax": 0, "Central Tax": 0, "State/UT Tax": 0, Cess: 0 },
    { Details: "(5) All other ITC", "Integrated Tax": n(other.igst), "Central Tax": n(other.cgst), "State/UT Tax": n(other.sgst), Cess: n(other.cess) },
    { Details: "(D) Ineligible ITC", "Integrated Tax": "", "Central Tax": "", "State/UT Tax": "", Cess: "" },
    { Details: "(1) As per section 17(5)", "Integrated Tax": 0, "Central Tax": 0, "State/UT Tax": 0, Cess: 0 },
    { Details: "(2) Others", "Integrated Tax": n(inel.igst), "Central Tax": n(inel.cgst), "State/UT Tax": n(inel.sgst), Cess: n(inel.cess) },
  ];

  const table5: ExportRow[] = [
    { "Nature of Supplies": "From a supplier under composition scheme, Exempt and Nil rated supply", "Inter-State supplies": 0, "Intra-State supplies": 0 },
    { "Nature of Supplies": "Non GST supply", "Inter-State supplies": 0, "Intra-State supplies": 0 },
  ];

  return [
    { name: "3.1 Report", rows: table3_1 },
    { name: "3.2 Report", rows: table3_2 },
    { name: "4 Report", rows: table4 },
    { name: "5 Report", rows: table5 },
  ];
}

// ============================================================ R16 — GST Tax Rate Report (SAC summary is not applicable — see hsnSummary's own comment: Urvar sells physical goods, not services)

/** Every TaxRate row — which HSN codes are verified and ready to invoice from, and which still need an accountant's sign-off. */
export async function gstTaxRateReport(db: Db = prisma): Promise<ReportSheet[]> {
  const rates = await db.taxRate.findMany({ orderBy: [{ hsnCode: "asc" }, { effectiveFrom: "desc" }] });
  const rows: ExportRow[] = rates.map((r) => ({
    HSN: r.hsnCode,
    Description: r.description ?? "",
    Treatment: r.treatment,
    "Rate %": n(r.ratePercent),
    "Cess %": n(r.cessPercent),
    "Effective From": dmy(r.effectiveFrom),
    "Effective To": r.effectiveTo ? dmy(r.effectiveTo) : "",
    Verified: r.isVerified ? "Yes" : "No",
  }));
  return [{ name: "GST Tax Rate Report", rows }];
}
