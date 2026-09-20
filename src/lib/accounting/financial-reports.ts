import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { loadAccountMap, type AccountKey } from "./account-map";
import { add, money, sub, sum, type Money } from "./money";

/**
 * Read-only financial reports, all derived from posted `JournalLine` rows —
 * never from an independent recomputation, and never from a stored balance
 * column. This is Phase 5: Trial Balance, General Ledger, P&L, Balance
 * Sheet, and two GST-return-preparation registers.
 *
 * A note on `JournalEntry.status`: a reversed entry keeps its own row with
 * `status: "REVERSED"` — it still happened, and its lines are real
 * historical postings up to the day it was reversed. Excluding it from a
 * balance calculation (filtering to `status: "POSTED"` only) would silently
 * drop everything it posted before the reversal date, which is wrong for a
 * point-in-time report. Every function below filters entries by date only,
 * excluding solely the (currently unused in practice) `DRAFT` status.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const NOT_DRAFT: Prisma.JournalEntryWhereInput = { status: { not: "DRAFT" } };

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: Money;
  credit: Money;
};

/**
 * Every postable account's net balance as of `asOfDate`, placed on whichever
 * side is net-positive — a debit-normal account with a net credit balance
 * (a contra situation) shows in the Credit column, not as a negative debit.
 * Zero-activity accounts are omitted. Sum(debit column) always equals
 * Sum(credit column) by the posting service's own balance invariant.
 */
export async function trialBalance(asOfDate: Date, db: Db = prisma): Promise<TrialBalanceRow[]> {
  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { entry: { ...NOT_DRAFT, entryDate: { lte: asOfDate } } },
    _sum: { debit: true, credit: true },
  });
  const activeIds = grouped.map((g) => g.accountId);
  if (activeIds.length === 0) return [];

  const accounts = await db.ledgerAccount.findMany({
    where: { id: { in: activeIds } },
    select: { id: true, code: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const rows: TrialBalanceRow[] = [];
  for (const g of grouped) {
    const account = byId.get(g.accountId);
    if (!account) continue;
    const net = sub(g._sum.debit, g._sum.credit);
    if (net.isZero()) continue;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debit: net.isPositive() ? net : money(0),
      credit: net.isNegative() ? net.negated() : money(0),
    });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

export type LedgerLine = {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  narration: string;
  sourceType: string;
  debit: Money;
  credit: Money;
  runningBalance: Money;
};

export type GeneralLedgerResult = {
  account: { id: string; code: string; name: string; type: string; normalBalance: string };
  openingBalance: Money;
  lines: LedgerLine[];
  closingBalance: Money;
};

/**
 * One account's transaction history over a date range, with a running
 * balance — this doubles as the cash book or bank book when `accountId` is
 * `CASH_ON_HAND` or `BANK_DEFAULT`'s resolved id, so no separate cash/bank
 * book implementation exists.
 */
export async function generalLedger(
  accountId: string,
  fromDate: Date,
  toDate: Date,
  db: Db = prisma,
): Promise<GeneralLedgerResult> {
  const account = await db.ledgerAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, code: true, name: true, type: true, normalBalance: true },
  });
  const sign = account.normalBalance === "DEBIT" ? 1 : -1;

  const priorLines = await db.journalLine.aggregate({
    where: { accountId, entry: { ...NOT_DRAFT, entryDate: { lt: fromDate } } },
    _sum: { debit: true, credit: true },
  });
  const openingBalance = money(sub(priorLines._sum.debit, priorLines._sum.credit)).times(sign);

  const rows = await db.journalLine.findMany({
    where: { accountId, entry: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } } },
    include: { entry: { select: { entryNumber: true, entryDate: true, narration: true, sourceType: true } } },
    orderBy: [{ entry: { entryDate: "asc" } }, { entry: { entryNumber: "asc" } }, { lineNumber: "asc" }],
  });

  let running = openingBalance;
  const lines: LedgerLine[] = rows.map((line) => {
    running = add(running, money(sub(line.debit, line.credit)).times(sign));
    return {
      entryId: line.entryId,
      entryNumber: line.entry.entryNumber,
      entryDate: line.entry.entryDate,
      narration: line.entry.narration,
      sourceType: line.entry.sourceType,
      debit: line.debit,
      credit: line.credit,
      runningBalance: running,
    };
  });

  return { account, openingBalance, lines, closingBalance: running };
}

export type PnlLine = { accountId: string; code: string; name: string; amount: Money };
export type ProfitAndLossResult = {
  income: PnlLine[];
  totalIncome: Money;
  expenses: PnlLine[];
  totalExpenses: Money;
  netProfit: Money;
};

/** Income and expense account activity over a date range. Never a running total across periods. */
export async function profitAndLoss(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ProfitAndLossResult> {
  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: {
      entry: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } },
      account: { type: { in: ["INCOME", "EXPENSE"] } },
    },
    _sum: { debit: true, credit: true },
  });
  const accounts = await db.ledgerAccount.findMany({
    where: { id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, code: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const income: PnlLine[] = [];
  const expenses: PnlLine[] = [];
  for (const g of grouped) {
    const account = byId.get(g.accountId);
    if (!account) continue;
    if (account.type === "INCOME") {
      const amount = sub(g._sum.credit, g._sum.debit); // credit-normal, but contra rows (returns, discounts) are DEBIT-normal and net out correctly here
      if (!amount.isZero()) income.push({ accountId: account.id, code: account.code, name: account.name, amount });
    } else {
      const amount = sub(g._sum.debit, g._sum.credit);
      if (!amount.isZero()) expenses.push({ accountId: account.id, code: account.code, name: account.name, amount });
    }
  }
  income.sort((a, b) => a.code.localeCompare(b.code));
  expenses.sort((a, b) => a.code.localeCompare(b.code));

  const totalIncome = sum(income.map((l) => l.amount));
  const totalExpenses = sum(expenses.map((l) => l.amount));
  return { income, totalIncome, expenses, totalExpenses, netProfit: sub(totalIncome, totalExpenses) };
}

export type BalanceSheetSection = { groupName: string; lines: PnlLine[]; total: Money };
export type BalanceSheetResult = {
  assets: BalanceSheetSection[];
  totalAssets: Money;
  liabilities: BalanceSheetSection[];
  totalLiabilities: Money;
  equity: BalanceSheetSection[];
  /** Cumulative Income - Expenses from inception to `asOfDate`, folded into equity as a plug — there is no period-close-to-retained-earnings transfer entry in this system. */
  currentEarnings: Money;
  totalEquity: Money;
  /** True when Assets = Liabilities + Equity, which double-entry guarantees unless something bypassed the posting service. */
  balances: boolean;
};

/**
 * Assets, Liabilities and Equity as of a date. Guaranteed to balance by the
 * posting service's own invariant (Σdebit = Σcredit on every entry), with
 * cumulative Income − Expenses folded into Equity as "Current Earnings" —
 * this system has no formal year-end closing entry that moves P&L into
 * Retained Earnings, so the report computes the same result the way a
 * spreadsheet trial balance would.
 */
export async function balanceSheet(asOfDate: Date, db: Db = prisma): Promise<BalanceSheetResult> {
  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { entry: { ...NOT_DRAFT, entryDate: { lte: asOfDate } } },
    _sum: { debit: true, credit: true },
  });
  const activeIds = grouped.map((g) => g.accountId);
  const accounts = await db.ledgerAccount.findMany({
    where: { id: { in: activeIds } },
    select: { id: true, code: true, name: true, type: true, parent: { select: { name: true } } },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const group = (type: "ASSET" | "LIABILITY" | "EQUITY"): BalanceSheetSection[] => {
    const byGroup = new Map<string, PnlLine[]>();
    for (const g of grouped) {
      const account = byId.get(g.accountId);
      if (!account || account.type !== type) continue;
      const raw = sub(g._sum.debit, g._sum.credit);
      // Assets are debit-normal; liabilities and equity are credit-normal.
      const amount = type === "ASSET" ? raw : raw.negated();
      if (amount.isZero()) continue;
      const groupName = account.parent?.name ?? account.type;
      const list = byGroup.get(groupName) ?? [];
      list.push({ accountId: account.id, code: account.code, name: account.name, amount });
      byGroup.set(groupName, list);
    }
    return [...byGroup.entries()]
      .map(([groupName, lines]) => ({
        groupName,
        lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
        total: sum(lines.map((l) => l.amount)),
      }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  };

  const assets = group("ASSET");
  const liabilities = group("LIABILITY");
  const equity = group("EQUITY");

  const totalAssets = sum(assets.map((s) => s.total));
  const totalLiabilities = sum(liabilities.map((s) => s.total));
  const totalEquityAccounts = sum(equity.map((s) => s.total));

  const pnl = await profitAndLoss(new Date(0), asOfDate, db);
  const currentEarnings = pnl.netProfit;
  const totalEquity = add(totalEquityAccounts, currentEarnings);

  return {
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    currentEarnings,
    totalEquity,
    balances: totalAssets.equals(add(totalLiabilities, totalEquity)),
  };
}

export type GstTaxSummary = {
  outputCgst: Money; outputSgst: Money; outputIgst: Money; outputCess: Money; totalOutput: Money;
  inputCgst: Money; inputSgst: Money; inputIgst: Money; inputCess: Money; totalInput: Money;
  netPayable: Money;
};

const OUTPUT_KEYS: AccountKey[] = ["GST_OUTPUT_CGST", "GST_OUTPUT_SGST", "GST_OUTPUT_IGST", "GST_OUTPUT_CESS"];
const INPUT_KEYS: AccountKey[] = ["GST_INPUT_CGST", "GST_INPUT_SGST", "GST_INPUT_IGST", "GST_INPUT_CESS"];

/**
 * Output tax collected vs. input tax credit available over a date range,
 * read directly off the GST ledger accounts — the same figures a GSTR-3B
 * summary needs, but this is an internal register, not a filed return, and
 * makes no compliance claim.
 */
export async function gstTaxSummary(fromDate: Date, toDate: Date, db: Db = prisma): Promise<GstTaxSummary> {
  const map = await loadAccountMap(db);
  const ids = [...OUTPUT_KEYS, ...INPUT_KEYS].map((k) => map.get(k)).filter((id): id is string => !!id);

  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { accountId: { in: ids }, entry: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } } },
    _sum: { debit: true, credit: true },
  });
  const byId = new Map(grouped.map((g) => [g.accountId, g._sum]));

  const outputOf = (key: AccountKey) => {
    const id = map.get(key);
    return id ? money(byId.get(id)?.credit ?? 0) : money(0);
  };
  const inputOf = (key: AccountKey) => {
    const id = map.get(key);
    return id ? money(byId.get(id)?.debit ?? 0) : money(0);
  };

  const outputCgst = outputOf("GST_OUTPUT_CGST");
  const outputSgst = outputOf("GST_OUTPUT_SGST");
  const outputIgst = outputOf("GST_OUTPUT_IGST");
  const outputCess = outputOf("GST_OUTPUT_CESS");
  const inputCgst = inputOf("GST_INPUT_CGST");
  const inputSgst = inputOf("GST_INPUT_SGST");
  const inputIgst = inputOf("GST_INPUT_IGST");
  const inputCess = inputOf("GST_INPUT_CESS");

  const totalOutput = sum([outputCgst, outputSgst, outputIgst, outputCess]);
  const totalInput = sum([inputCgst, inputSgst, inputIgst, inputCess]);

  return {
    outputCgst, outputSgst, outputIgst, outputCess, totalOutput,
    inputCgst, inputSgst, inputIgst, inputCess, totalInput,
    netPayable: sub(totalOutput, totalInput),
  };
}

export type OutwardSupplyRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerName: string;
  customerGstin: string | null;
  placeOfSupply: string;
  hsnCode: string;
  taxableValue: Money;
  taxRatePercent: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
  total: Money;
};

/**
 * Line-level outward-supply detail for GSTR-1 preparation — every posted
 * (non-cancelled) sales invoice line in the range, with HSN and the tax
 * split it was actually priced and posted at. Not a filed return: HSN
 * classification for these products is still marked unverified pending
 * accountant sign-off (see TaxRate.isVerified), and Company.gstin may be
 * unset.
 */
export async function gstOutwardSupplyRegister(
  fromDate: Date,
  toDate: Date,
  db: Db = prisma,
): Promise<OutwardSupplyRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: {
      invoice: {
        status: { not: "CANCELLED" },
        invoiceDate: { gte: fromDate, lte: toDate },
      },
    },
    include: {
      invoice: { select: { invoiceNumber: true, invoiceDate: true, placeOfSupply: true, customerGstin: true, customer: { select: { name: true } } } },
    },
    orderBy: [{ invoice: { invoiceDate: "asc" } }],
  });

  return items.map((item) => ({
    invoiceId: item.invoiceId,
    invoiceNumber: item.invoice.invoiceNumber,
    invoiceDate: item.invoice.invoiceDate,
    customerName: item.invoice.customer.name,
    customerGstin: item.invoice.customerGstin,
    placeOfSupply: item.invoice.placeOfSupply,
    hsnCode: item.hsnCode ?? "—",
    taxableValue: item.taxableValue,
    taxRatePercent: item.taxRatePercent,
    cgst: item.cgstAmount,
    sgst: item.sgstAmount,
    igst: item.igstAmount,
    cess: item.cessAmount,
    total: item.lineTotal,
  }));
}

export type AgeingBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
export const AGEING_BUCKET_LABELS: Record<AgeingBucketKey, string> = {
  current: "Current",
  d1_30: "1-30 days",
  d31_60: "31-60 days",
  d61_90: "61-90 days",
  d90_plus: "90+ days",
};
const AGEING_BUCKET_KEYS: AgeingBucketKey[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];

function ageingBucket(daysOverdue: number): AgeingBucketKey {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90_plus";
}

export type AgeingRow = {
  partyId: string;
  partyName: string;
  buckets: Record<AgeingBucketKey, Money>;
  total: Money;
};

function emptyBuckets(): Record<AgeingBucketKey, Money> {
  return { current: money(0), d1_30: money(0), d31_60: money(0), d61_90: money(0), d90_plus: money(0) };
}

/**
 * Every customer with an open (non-fully-paid, non-cancelled) invoice,
 * bucketed by days past `dueDate`. An invoice with no due date is treated as
 * `current` — it can't be aged without one, and that is never guessed.
 */
export async function accountsReceivableAgeing(asOfDate: Date, db: Db = prisma): Promise<AgeingRow[]> {
  const { outstandingOnInvoice } = await import("./receipts");

  const invoices = await db.salesInvoice.findMany({
    where: { status: { in: ["POSTED", "PARTIALLY_PAID"] }, invoiceDate: { lte: asOfDate } },
    select: { id: true, customerId: true, dueDate: true, customer: { select: { name: true } } },
  });

  const byCustomer = new Map<string, AgeingRow>();
  for (const inv of invoices) {
    const outstanding = await outstandingOnInvoice(inv.id, db);
    if (outstanding.isZero()) continue;

    const daysOverdue = inv.dueDate
      ? Math.floor((asOfDate.getTime() - inv.dueDate.getTime()) / (24 * 60 * 60 * 1000))
      : 0;
    const bucket = ageingBucket(daysOverdue);

    const row = byCustomer.get(inv.customerId) ?? {
      partyId: inv.customerId,
      partyName: inv.customer.name,
      buckets: emptyBuckets(),
      total: money(0),
    };
    row.buckets[bucket] = add(row.buckets[bucket], outstanding);
    row.total = add(row.total, outstanding);
    byCustomer.set(inv.customerId, row);
  }

  return [...byCustomer.values()].sort((a, b) => b.total.comparedTo(a.total));
}

/**
 * Every supplier with an open (non-fully-paid, non-cancelled) purchase
 * invoice, bucketed by days since `invoiceDate` — `PurchaseInvoice` has no
 * due-date field (the OCR intake never captures payment terms), so this
 * ages from the invoice date rather than inventing a due date.
 */
export async function accountsPayableAgeing(asOfDate: Date, db: Db = prisma): Promise<AgeingRow[]> {
  const { outstandingOnPurchaseInvoice } = await import("./supplier-payments");

  const invoices = await db.purchaseInvoice.findMany({
    where: { status: { in: ["POSTED", "PARTIALLY_PAID"] }, invoiceDate: { lte: asOfDate } },
    select: { id: true, supplierId: true, invoiceDate: true, supplier: { select: { name: true } } },
  });

  const bySupplier = new Map<string, AgeingRow>();
  for (const inv of invoices) {
    const outstanding = await outstandingOnPurchaseInvoice(inv.id, db);
    if (outstanding.isZero()) continue;

    const daysOverdue = Math.floor((asOfDate.getTime() - inv.invoiceDate.getTime()) / (24 * 60 * 60 * 1000));
    const bucket = ageingBucket(daysOverdue);

    const row = bySupplier.get(inv.supplierId) ?? {
      partyId: inv.supplierId,
      partyName: inv.supplier.name,
      buckets: emptyBuckets(),
      total: money(0),
    };
    row.buckets[bucket] = add(row.buckets[bucket], outstanding);
    row.total = add(row.total, outstanding);
    bySupplier.set(inv.supplierId, row);
  }

  return [...bySupplier.values()].sort((a, b) => b.total.comparedTo(a.total));
}

export { AGEING_BUCKET_KEYS };
