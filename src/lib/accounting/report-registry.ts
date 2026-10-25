import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import {
  trialBalance,
  generalLedger,
  profitAndLoss,
  balanceSheet,
  gstTaxSummary,
  gstOutwardSupplyRegister,
  accountsReceivableAgeing,
  accountsPayableAgeing,
  dayBookMoneyFlow,
  cashFlowSummary,
  salesAgeingByInvoice,
  billWiseProfit,
  partyStatement,
  partyWiseProfitAndLoss,
  allPartiesSummary,
  partyReportByItem,
  hsnSummary,
  itemWiseProfitAndLoss,
  itemCategoryWiseProfitAndLoss,
  itemWiseDiscount,
  discountReport,
  expenseCategoryReport,
  expenseItemReport,
  otherIncomeCategoryReport,
  otherIncomeItemReport,
  tdsTcsReport,
  accountGroupBalances,
  cashOnHandBalance,
  journalEntryReport,
  AGEING_BUCKET_LABELS,
  AGEING_BUCKET_KEYS,
  type AgeingRow,
} from "./financial-reports";
import { saleReport, purchaseReport, allTransactionsReport, itemwiseTransactionReport, salePurchaseByParty } from "./transaction-reports";
import { loanStatement, loanAccountSummary } from "./loans";
import { gstr1Report, gstr2Report, gstr3bReport, gstTaxRateReport } from "./gstr-reports";
import { toAmountString, type MoneyInput } from "./money";

/**
 * Vyapar parity step 4 — the export registry (docs/VYAPAR_PARITY_SPEC.md
 * §3.4, G13).
 *
 * The spec's recipe is "report id -> `{ load(params), columns, itemDetails?
 * }`". This implementation folds `columns` away: a `ReportSheet`'s columns
 * are always derived from `Object.keys(rows[0])`, the same thing the
 * pre-existing CRM export route (`src/app/api/reports/export/route.ts`)
 * already did for leads/orders/quotations — there is no reason to hand-list
 * column headers a second time next to code that already names every field.
 * `itemDetails` becomes "a second ReportSheet" rather than a special case:
 * a report that has one (R1/R2/R3) just returns two sheets instead of one.
 *
 * Every `load()` here is a thin adapter: it calls the *existing* report
 * function (never reimplements the query) and flattens `Money`/`Date`
 * fields into the plain strings/numbers a spreadsheet or PDF cell wants.
 * Numbers are rounded to 2dp via `toAmountString` then parsed back to
 * `number` — fine for a human-read export, which is all this is for;
 * nothing here feeds back into the ledger.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type ExportRow = Record<string, string | number>;
export type ReportSheet = { name: string; rows: ExportRow[] };

export type ReportParams = {
  from?: Date;
  to?: Date;
  asOf?: Date;
  accountId?: string;
  partyId?: string;
  partyType?: "CUSTOMER" | "SUPPLIER";
  loanId?: string;
};

export type ReportNeed = "range" | "asOf" | "accountId" | "partyId" | "partyType" | "loanId";

export type ReportDefinition = {
  id: string;
  title: string;
  needs: ReportNeed[];
  load: (params: ReportParams, db?: Db) => Promise<ReportSheet[]>;
};

const n = (m: MoneyInput): number => Number(toAmountString(m));
const dmy = (d: Date): string =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

function ageingColumns(row: AgeingRow): ExportRow {
  const out: ExportRow = { Party: row.partyName };
  for (const key of AGEING_BUCKET_KEYS) out[AGEING_BUCKET_LABELS[key]] = n(row.buckets[key]);
  out.Total = n(row.total);
  return out;
}

function single(name: string, rows: ExportRow[]): ReportSheet[] {
  return [{ name, rows }];
}

export const REPORT_REGISTRY: Record<string, ReportDefinition> = {
  // ---------------------------------------------------------------- Transaction Report

  "sale-report": {
    id: "sale-report",
    title: "Sale Report",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const { rows } = await saleReport(from!, to!, db);
      const main = rows.map((r) => ({
        Date: dmy(r.date),
        "Order No": r.orderNumber ?? "",
        "Invoice No": r.invoiceNumber,
        "Party Name": r.partyName,
        GSTIN: r.gstin ?? "",
        "Party Phone": r.partyPhone,
        "Transaction Type": r.transactionType,
        "Total Amount": n(r.totalAmount),
        "Payment Type": r.paymentType,
        "Received Amount": n(r.receivedAmount),
        "Balance Due": n(r.balanceDue),
        Description: r.description ?? "",
      }));
      const items = (await itemwiseTransactionReport(from!, to!, db)).filter((i) => i.transactionType === "Sale");
      return [{ name: "Sale Report", rows: main }, { name: "Item Details", rows: itemDetailRows(items) }];
    },
  },

  "purchase-report": {
    id: "purchase-report",
    title: "Purchase Report",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const { rows } = await purchaseReport(from!, to!, db);
      const main = rows.map((r) => ({
        Date: dmy(r.date),
        "Invoice No": r.invoiceNumber,
        "Party Name": r.partyName,
        GSTIN: r.gstin ?? "",
        "Party Phone": r.partyPhone ?? "",
        "Transaction Type": r.transactionType,
        "Total Amount": n(r.totalAmount),
        "Payment Type": r.paymentType,
        "Paid Amount": n(r.paidAmount),
        "Balance Due": n(r.balanceDue),
        Description: r.description ?? "",
      }));
      const items = (await itemwiseTransactionReport(from!, to!, db)).filter((i) => i.transactionType === "Purchase");
      return [{ name: "Purchase Report", rows: main }, { name: "Item Details", rows: itemDetailRows(items) }];
    },
  },

  "all-transactions": {
    id: "all-transactions",
    title: "All Transactions Report",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const rows = await allTransactionsReport(from!, to!, db);
      const main = rows.map((r) => ({
        Date: dmy(r.date),
        "Reference No": r.referenceNo ?? "",
        "Party Name": r.partyName ?? "",
        "Category Name": r.categoryName ?? "",
        Type: r.transactionType,
        Total: n(r.total),
        "Payment Type": r.paymentType ?? "",
        Paid: r.paid ? n(r.paid) : "",
        Received: r.received ? n(r.received) : "",
        Balance: r.balance ? n(r.balance) : "",
        Description: r.description ?? "",
      }));
      const items = await itemwiseTransactionReport(from!, to!, db);
      return [{ name: "All Transactions", rows: main }, { name: "Item Details", rows: itemDetailRows(items) }];
    },
  },

  "itemwise-transaction": {
    id: "itemwise-transaction",
    title: "Itemwise Transaction Report",
    needs: ["range"],
    load: async ({ from, to }, db) => single("Itemwise Transaction", itemDetailRows(await itemwiseTransactionReport(from!, to!, db))),
  },

  "sale-purchase-by-party": {
    id: "sale-purchase-by-party",
    title: "Sale Purchase By Party",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Sale Purchase By Party",
        (await salePurchaseByParty(from!, to!, db)).map((r) => ({
          Party: r.partyName,
          Type: r.partyType === "CUSTOMER" ? "Customer" : "Supplier",
          "Sale Total": n(r.saleTotal),
          "Purchase Total": n(r.purchaseTotal),
        })),
      ),
  },

  "loan-statement": {
    id: "loan-statement",
    title: "Loan Statement",
    needs: ["loanId", "range"],
    load: async ({ loanId, from, to }, db) => {
      const result = await loanStatement(loanId!, from!, to!, db);
      const rows: ExportRow[] = result.rows.map((r) => ({ Date: dmy(r.date), Type: r.type, Amount: n(r.amount), "Ending Balance": n(r.endingBalance) }));
      rows.unshift({ Date: "", Type: "Opening Balance", Amount: n(result.openingBalance), "Ending Balance": n(result.openingBalance) });
      rows.push(
        { Date: "", Type: "Balance Due", Amount: n(result.balanceDue), "Ending Balance": n(result.balanceDue) },
        { Date: "", Type: "Total Principal Paid", Amount: n(result.totalPrincipalPaid), "Ending Balance": "" },
        { Date: "", Type: "Total Interest Paid", Amount: n(result.totalInterestPaid), "Ending Balance": "" },
      );
      return single(`Loan Statement - ${result.lenderName}`, rows);
    },
  },

  "loan-account-summary": {
    id: "loan-account-summary",
    title: "Loan Account Summary",
    needs: ["asOf"],
    load: async ({ asOf }, db) =>
      single(
        "Loan Account Summary",
        (await loanAccountSummary(asOf!, db)).map((r) => ({
          Lender: r.lenderName,
          Status: r.status,
          "Opening Principal": n(r.openingPrincipal),
          "Principal Paid": n(r.principalPaid),
          "Interest Paid": n(r.interestPaid),
          Balance: n(r.balance),
        })),
      ),
  },

  "journal-entry": {
    id: "journal-entry",
    title: "Journal Entry Report",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Journal Entry Report",
        (await journalEntryReport(from!, to!, db)).map((l) => ({
          Date: dmy(l.entryDate),
          Ref: l.entryNumber,
          Narration: l.narration,
          Account: `${l.accountCode} ${l.accountName}`,
          Debit: n(l.debit),
          Credit: n(l.credit),
        })),
      ),
  },

  "trial-balance": {
    id: "trial-balance",
    title: "Trial Balance",
    needs: ["asOf"],
    load: async ({ asOf }, db) =>
      single(
        "Trial Balance",
        (await trialBalance(asOf!, db)).map((r) => ({ Code: r.code, Account: r.name, Type: r.type, Debit: n(r.debit), Credit: n(r.credit) })),
      ),
  },

  "day-book": {
    id: "day-book",
    title: "Day Book",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const { entries } = await dayBookMoneyFlow(from!, to!, db);
      return single(
        "Day Book",
        entries.map((e) => ({
          Date: dmy(e.entryDate),
          Entry: e.entryNumber,
          Narration: e.narration,
          "Money In": n(e.moneyIn),
          "Money Out": n(e.moneyOut),
        })),
      );
    },
  },

  ledger: {
    id: "ledger",
    title: "Account Statement",
    needs: ["accountId", "range"],
    load: async ({ accountId, from, to }, db) => {
      const result = await generalLedger(accountId!, from!, to!, db);
      const rows: ExportRow[] = result.lines.map((l) => ({
        Date: dmy(l.entryDate),
        Entry: l.entryNumber,
        Narration: l.narration,
        Debit: n(l.debit),
        Credit: n(l.credit),
        Balance: n(l.runningBalance),
      }));
      rows.unshift({ Date: "", Entry: "", Narration: "Opening balance", Debit: "", Credit: "", Balance: n(result.openingBalance) });
      return single(`${result.account.code} ${result.account.name}`, rows);
    },
  },

  "cash-flow": {
    id: "cash-flow",
    title: "Cash Flow Report",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Cash Flow",
        (await cashFlowSummary(from!, to!, db)).buckets.map((b) => ({ Source: b.sourceType, Inflow: n(b.inflow), Outflow: n(b.outflow), Net: n(b.net) })),
      ),
  },

  "profit-and-loss": {
    id: "profit-and-loss",
    title: "Profit and Loss",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const r = await profitAndLoss(from!, to!, db);
      const rows: ExportRow[] = [
        ...r.income.map((l) => ({ Section: "Income", Code: l.code, Account: l.name, Amount: n(l.amount) })),
        { Section: "Income", Code: "", Account: "Total Income", Amount: n(r.totalIncome) },
        ...r.expenses.map((l) => ({ Section: "Expenses", Code: l.code, Account: l.name, Amount: n(l.amount) })),
        { Section: "Expenses", Code: "", Account: "Total Expenses", Amount: n(r.totalExpenses) },
        { Section: "", Code: "", Account: "Net Profit", Amount: n(r.netProfit) },
      ];
      return single("Profit and Loss", rows);
    },
  },

  "bill-wise-profit": {
    id: "bill-wise-profit",
    title: "Bill Wise Profit",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Bill Wise Profit",
        (await billWiseProfit(from!, to!, db)).map((r) => ({
          Date: dmy(r.invoiceDate),
          Invoice: r.invoiceNumber,
          Party: r.customerName,
          Revenue: n(r.revenue),
          "Estimated Cost": r.estimatedCost === null ? "Unknown" : n(r.estimatedCost),
          "Estimated Margin": r.estimatedMargin === null ? "Unknown" : n(r.estimatedMargin),
        })),
      ),
  },

  "sales-aging": {
    id: "sales-aging",
    title: "Sales Aging",
    needs: ["asOf"],
    load: async ({ asOf }, db) =>
      single(
        "Sales Aging",
        (await salesAgeingByInvoice(asOf!, db)).map((r) => ({
          Invoice: r.invoiceNumber,
          Date: dmy(r.invoiceDate),
          Party: r.customerName,
          "Due Date": r.dueDate ? dmy(r.dueDate) : "",
          "Days Overdue": r.daysOverdue,
          Bucket: AGEING_BUCKET_LABELS[r.bucket],
          Outstanding: n(r.outstanding),
        })),
      ),
  },

  "balance-sheet": {
    id: "balance-sheet",
    title: "Balance Sheet",
    needs: ["asOf"],
    load: async ({ asOf }, db) => {
      const r = await balanceSheet(asOf!, db);
      const rows: ExportRow[] = [];
      for (const [label, sections] of [["Assets", r.assets], ["Liabilities", r.liabilities], ["Equity", r.equity]] as const) {
        for (const section of sections) {
          for (const line of section.lines) rows.push({ Section: label, Group: section.groupName, Code: line.code, Account: line.name, Amount: n(line.amount) });
          rows.push({ Section: label, Group: section.groupName, Code: "", Account: `Total ${section.groupName}`, Amount: n(section.total) });
        }
      }
      rows.push({ Section: "Equity", Group: "", Code: "", Account: "Current Earnings", Amount: n(r.currentEarnings) });
      rows.push({ Section: "", Group: "", Code: "", Account: "Total Assets", Amount: n(r.totalAssets) });
      rows.push({ Section: "", Group: "", Code: "", Account: "Total Liabilities + Equity", Amount: n(r.totalLiabilities) });
      return single("Balance Sheet", rows);
    },
  },

  // ---------------------------------------------------------------- Party Report

  "all-parties": {
    id: "all-parties",
    title: "All Parties",
    needs: ["asOf"],
    load: async ({ asOf }, db) =>
      single(
        "All Parties",
        (await allPartiesSummary(asOf!, db)).map((r) => ({
          Party: r.partyName,
          Type: r.partyType === "CUSTOMER" ? "Customer" : "Supplier",
          Invoiced: n(r.totalInvoiced),
          Settled: n(r.totalSettled),
          Outstanding: n(r.outstanding),
        })),
      ),
  },

  "party-statement": {
    id: "party-statement",
    title: "Party Statement",
    needs: ["partyId", "partyType", "range"],
    load: async ({ partyId, partyType, from, to }, db) => {
      const result = await partyStatement(partyId!, partyType!, from!, to!, db);
      const rows: ExportRow[] = result.lines.map((l) => ({ Date: dmy(l.entryDate), Entry: l.entryNumber, Narration: l.narration, Debit: n(l.debit), Credit: n(l.credit), Balance: n(l.runningBalance) }));
      rows.unshift({ Date: "", Entry: "", Narration: "Opening balance", Debit: "", Credit: "", Balance: n(result.openingBalance) });
      return single(`Statement - ${result.partyName}`, rows);
    },
  },

  "party-profit-loss": {
    id: "party-profit-loss",
    title: "Party wise Profit and Loss",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Party wise Profit and Loss",
        (await partyWiseProfitAndLoss(from!, to!, db)).map((r) => ({ Party: r.customerName, Revenue: n(r.revenue), "Estimated Cost": n(r.estimatedCost), "Estimated Margin": n(r.estimatedMargin) })),
      ),
  },

  "party-item-report": {
    id: "party-item-report",
    title: "Party Report By Item",
    needs: ["partyId", "range"],
    load: async ({ partyId, from, to }, db) =>
      single(
        "Party Report By Item",
        (await partyReportByItem(partyId!, from!, to!, db)).map((r) => ({ Item: r.productName, Quantity: n(r.quantity), Value: n(r.value) })),
      ),
  },

  // ---------------------------------------------------------------- GST Report

  gst: {
    id: "gst",
    title: "GST Registers",
    needs: ["range"],
    load: async ({ from, to }, db) => {
      const [summary, outward] = await Promise.all([gstTaxSummary(from!, to!, db), gstOutwardSupplyRegister(from!, to!, db)]);
      const summaryRows: ExportRow[] = [
        { "": "Output tax (on sales)", CGST: n(summary.outputCgst), SGST: n(summary.outputSgst), IGST: n(summary.outputIgst), Cess: n(summary.outputCess), Total: n(summary.totalOutput) },
        { "": "Input tax credit (on purchases)", CGST: n(summary.inputCgst), SGST: n(summary.inputSgst), IGST: n(summary.inputIgst), Cess: n(summary.inputCess), Total: n(summary.totalInput) },
        { "": summary.netPayable.isNegative() ? "Net credit carried forward" : "Net GST payable", CGST: "", SGST: "", IGST: "", Cess: "", Total: n(summary.netPayable.abs()) },
      ];
      const outwardRows = outward.map((r) => ({
        Date: dmy(r.invoiceDate),
        Invoice: r.invoiceNumber,
        Customer: r.customerName,
        GSTIN: r.customerGstin ?? "B2C",
        "Place of Supply": r.placeOfSupply,
        HSN: r.hsnCode,
        Taxable: n(r.taxableValue),
        "Rate %": n(r.taxRatePercent),
        CGST: n(r.cgst),
        SGST: n(r.sgst),
        IGST: n(r.igst),
        Cess: n(r.cess),
        Total: n(r.total),
      }));
      return [{ name: "GST Summary", rows: summaryRows }, { name: "Outward Supply Register", rows: outwardRows }];
    },
  },

  "hsn-summary": {
    id: "hsn-summary",
    title: "Sale Summary By HSN",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Sale Summary By HSN",
        (await hsnSummary(from!, to!, db)).map((r) => ({ HSN: r.hsnCode, Taxable: n(r.taxableValue), CGST: n(r.cgst), SGST: n(r.sgst), IGST: n(r.igst), Cess: n(r.cess), Total: n(r.total), Count: r.count })),
      ),
  },

  // ---------------------------------------------------------------- Item / Stock Report

  "item-profit-loss": {
    id: "item-profit-loss",
    title: "Item Wise Profit and Loss",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Item Wise Profit and Loss",
        (await itemWiseProfitAndLoss(from!, to!, db)).map((r) => ({ Item: r.productName, Revenue: n(r.revenue), "Estimated Cost": n(r.estimatedCost), "Estimated Margin": n(r.estimatedMargin) })),
      ),
  },

  "item-category-profit-loss": {
    id: "item-category-profit-loss",
    title: "Item Category Wise Profit and Loss",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Item Category Wise Profit and Loss",
        (await itemCategoryWiseProfitAndLoss(from!, to!, db)).map((r) => ({ Category: r.category, Revenue: n(r.revenue), "Estimated Cost": n(r.estimatedCost), "Estimated Margin": n(r.estimatedMargin) })),
      ),
  },

  "item-wise-discount": {
    id: "item-wise-discount",
    title: "Item Wise Discount",
    needs: ["range"],
    load: async ({ from, to }, db) => single("Item Wise Discount", (await itemWiseDiscount(from!, to!, db)).map((r) => ({ Item: r.label, Discount: n(r.discountAmount) }))),
  },

  // ---------------------------------------------------------------- Business Report

  "bank-report": {
    id: "bank-report",
    title: "Bank Report",
    needs: ["asOf"],
    load: async ({ asOf }, db) => {
      const result = await accountGroupBalances("1120", asOf!, db);
      return single("Bank Report", (result?.accounts ?? []).map((a) => ({ "Bank Account": `${a.code} ${a.name}`, Balance: n(a.balance) })));
    },
  },

  "discount-report": {
    id: "discount-report",
    title: "Discount Report",
    needs: ["range"],
    load: async ({ from, to }, db) => single("Discount Report", (await discountReport(from!, to!, db)).map((r) => ({ Party: r.label, Discount: n(r.discountAmount) }))),
  },

  // ---------------------------------------------------------------- Expense Report

  "expense-category-report": {
    id: "expense-category-report",
    title: "Expense Category Report",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single("Expense Category Report", (await expenseCategoryReport(from!, to!, db)).map((r) => ({ Code: r.code, Category: r.name, Total: n(r.total), Count: r.count }))),
  },

  "expense-item-report": {
    id: "expense-item-report",
    title: "Expense Item Report",
    needs: ["range"],
    load: async ({ from, to }, db) => single("Expense Item Report", (await expenseItemReport(from!, to!, db)).map((r) => ({ Description: r.description, Quantity: n(r.quantity), "Total Value": n(r.totalValue) }))),
  },

  // ---------------------------------------------------------------- Other Income Report (step 6, D8, R11)

  "other-income-category-report": {
    id: "other-income-category-report",
    title: "Other Income Category Report",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Other Income Category Report",
        (await otherIncomeCategoryReport(from!, to!, db)).map((r) => ({ Code: r.code, Category: r.name, Total: n(r.total), Count: r.count })),
      ),
  },

  "other-income-item-report": {
    id: "other-income-item-report",
    title: "Other Income Item Report",
    needs: ["range"],
    load: async ({ from, to }, db) =>
      single(
        "Other Income Item Report",
        (await otherIncomeItemReport(from!, to!, db)).map((r) => ({ Description: r.description, Quantity: n(r.quantity), "Total Value": n(r.totalValue) })),
      ),
  },

  // ---------------------------------------------------------------- TDS/TCS Report (step 6, D9, R17)

  "tds-tcs-report": {
    id: "tds-tcs-report",
    title: "TDS/TCS Report",
    needs: ["asOf"],
    load: async ({ asOf }, db) =>
      single("TDS/TCS Report", (await tdsTcsReport(asOf!, db)).map((r) => ({ Code: r.code, Account: r.name, Type: r.type, Balance: n(r.balance) }))),
  },

  // ---------------------------------------------------------------- Cash, Bank & Assets

  "cash-bank-assets": {
    id: "cash-bank-assets",
    title: "Cash, Bank and Assets",
    needs: ["asOf"],
    load: async ({ asOf }, db) => {
      const [cash, bank, fixedAssets, loans] = await Promise.all([
        cashOnHandBalance(asOf!, db),
        accountGroupBalances("1120", asOf!, db),
        accountGroupBalances("1200", asOf!, db),
        accountGroupBalances("2200", asOf!, db),
      ]);
      const rows: ExportRow[] = [];
      if (cash) rows.push({ Group: "Cash In Hand", Account: `${cash.code} ${cash.name}`, Balance: n(cash.balance) });
      for (const [label, group] of [["Bank Accounts", bank], ["Fixed Assets", fixedAssets], ["Loan Accounts", loans]] as const) {
        for (const a of group?.accounts ?? []) rows.push({ Group: label, Account: `${a.code} ${a.name}`, Balance: n(a.balance) });
        if (group) rows.push({ Group: label, Account: `Total ${label}`, Balance: n(group.total) });
      }
      return single("Cash, Bank and Assets", rows);
    },
  },

  // ---------------------------------------------------------------- Party Ageing

  "ar-ageing": {
    id: "ar-ageing",
    title: "AR Ageing",
    needs: ["asOf"],
    load: async ({ asOf }, db) => single("AR Ageing", (await accountsReceivableAgeing(asOf!, db)).map(ageingColumns)),
  },

  "ap-ageing": {
    id: "ap-ageing",
    title: "AP Ageing",
    needs: ["asOf"],
    load: async ({ asOf }, db) => single("AP Ageing", (await accountsPayableAgeing(asOf!, db)).map(ageingColumns)),
  },

  // ---------------------------------------------------------------- GST Returns (step 5, R13–R16)
  // These four return ReportSheet[] directly from gstr-reports.ts — already
  // in final export shape, not Money-typed rows needing the usual mapping.

  gstr1: { id: "gstr1", title: "GSTR-1", needs: ["range"], load: ({ from, to }, db) => gstr1Report(from!, to!, db) },
  gstr2: { id: "gstr2", title: "GSTR-2", needs: ["range"], load: ({ from, to }, db) => gstr2Report(from!, to!, db) },
  gstr3b: { id: "gstr3b", title: "GSTR-3B", needs: ["range"], load: ({ from, to }, db) => gstr3bReport(from!, to!, db) },
  "gst-tax-rate": { id: "gst-tax-rate", title: "GST Tax Rate Report", needs: [], load: (_params, db) => gstTaxRateReport(db) },
};

/** The Item Details sheet shape every R1/R2/R3 export shares, lifted from R5's own columns. */
function itemDetailRows(items: Awaited<ReturnType<typeof itemwiseTransactionReport>>): ExportRow[] {
  return items.map((i) => ({
    Date: dmy(i.date),
    "Invoice/Txn No": i.txnNumber,
    Party: i.partyName ?? "",
    Item: i.itemName,
    "Item Code": i.itemCode ?? "",
    "HSN/SAC": i.hsnCode ?? "",
    Category: i.category ?? "",
    "Order No": i.orderNumber ?? "",
    Quantity: n(i.quantity),
    Unit: i.unit ?? "",
    "Unit Price": n(i.unitPrice),
    "Discount %": n(i.discountPercent),
    Discount: n(i.discountAmount),
    "Tax %": i.taxPercent === null ? "" : n(i.taxPercent),
    Tax: n(i.taxAmount),
    "Transaction Type": i.transactionType,
    Amount: n(i.amount),
  }));
}

/** `<Report>_<dd_mm_yy>[_to_<dd_mm_yy>]`, Vyapar's own export filename convention. */
export function vyaparFilename(title: string, from: Date | undefined, to: Date | undefined): string {
  const slug = title.replace(/[^a-zA-Z0-9]+/g, "");
  const part = (d: Date) => `${String(d.getDate()).padStart(2, "0")}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getFullYear()).slice(2)}`;
  if (from && to) return `${slug}_${part(from)}_to_${part(to)}`;
  if (to) return `${slug}_${part(to)}`;
  return slug;
}
