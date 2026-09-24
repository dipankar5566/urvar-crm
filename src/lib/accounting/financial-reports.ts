import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { loadAccountMap, type AccountKey } from "./account-map";
import { add, money, mul, percentOf, round, sub, sum, type Money } from "./money";

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
        // Opening balances migrated from a prior system were never a taxable
        // event under this company's own GST registration — that supply (if
        // any) was already reported under the old system's GSTR filing.
        isOpeningItem: false,
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

/**
 * Phase 8 — Vyapar report-parity additions.
 *
 * Same rules as everything above: read-only, derived from posted
 * `JournalLine`/document rows, never an independent recomputation. Several
 * of these read `estimatedCostAmount` — the informational per-line margin
 * snapshot on `SalesInvoiceItem` — which is never posted to the ledger
 * (periodic costing reaches the P&L at period close, not per invoice) and is
 * null whenever a product has no purchase history yet to average a cost
 * from. A null must never be read as zero; `billWiseProfit` flags this per
 * invoice, while the aggregate item/party profit reports below treat a null
 * line's cost as 0 for the sum (documented inline) since an aggregate is
 * already an estimate and flagging every contributing row would make the
 * report unreadable.
 */

// ------------------------------------------------------------ Day Book

export type DayBookLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: Money;
  credit: Money;
};
export type DayBookEntry = {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  narration: string;
  sourceType: string;
  lines: DayBookLine[];
};

/** Every posted entry in a date range, across every account, in the order it happened — the chronological "all transactions" view Day Book and All Transactions both mean. */
export async function dayBook(fromDate: Date, toDate: Date, db: Db = prisma): Promise<DayBookEntry[]> {
  const entries = await db.journalEntry.findMany({
    where: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } },
    include: {
      lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNumber: "asc" } },
    },
    orderBy: [{ entryDate: "asc" }, { entryNumber: "asc" }],
  });
  return entries.map((e) => ({
    entryId: e.id,
    entryNumber: e.entryNumber,
    entryDate: e.entryDate,
    narration: e.narration,
    sourceType: e.sourceType,
    lines: e.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.account.code,
      accountName: l.account.name,
      debit: l.debit,
      credit: l.credit,
    })),
  }));
}

// ------------------------------------------------------------ Cash Flow

export type CashFlowBucket = { sourceType: string; inflow: Money; outflow: Money; net: Money };
export type CashFlowSummaryResult = {
  buckets: CashFlowBucket[];
  totalInflow: Money;
  totalOutflow: Money;
  netChange: Money;
};

/**
 * Net movement through the cash and default bank accounts over a range,
 * bucketed by what caused it (sales receipts, supplier payments, expenses,
 * manual entries). A simplified cash-movement summary, not a formal
 * operating/investing/financing statement — same "no compliance claim"
 * posture the GST registers page already states explicitly.
 */
export async function cashFlowSummary(fromDate: Date, toDate: Date, db: Db = prisma): Promise<CashFlowSummaryResult> {
  // Every postable account under Cash on Hand (1110, a leaf) and Bank
  // Accounts (1120, a group) — not just the two accounts AccountMapping
  // happens to name as defaults. This used to resolve only CASH_ON_HAND and
  // BANK_DEFAULT via the mapping, silently excluding every other bank
  // account (e.g. 1122 Bank - Flipkart Settlement) from cash flow entirely.
  // Same code-based lookup accountGroupBalances()/cashOnHandBalance() above
  // already use, rather than a mapping key.
  const [cashAccount, bankGroup] = await Promise.all([
    db.ledgerAccount.findUnique({ where: { code: "1110" }, select: { id: true } }),
    db.ledgerAccount.findUnique({ where: { code: "1120" }, select: { id: true } }),
  ]);
  const bankChildren = bankGroup
    ? await db.ledgerAccount.findMany({ where: { parentId: bankGroup.id, isPostable: true }, select: { id: true } })
    : [];
  const ids = [cashAccount?.id, ...bankChildren.map((c) => c.id)].filter((id): id is string => !!id);
  if (ids.length === 0) return { buckets: [], totalInflow: money(0), totalOutflow: money(0), netChange: money(0) };

  const lines = await db.journalLine.findMany({
    where: { accountId: { in: ids }, entry: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } } },
    include: { entry: { select: { sourceType: true } } },
  });

  const byBucket = new Map<string, { inflow: Money; outflow: Money }>();
  for (const line of lines) {
    const key = line.entry.sourceType;
    const b = byBucket.get(key) ?? { inflow: money(0), outflow: money(0) };
    b.inflow = add(b.inflow, line.debit);
    b.outflow = add(b.outflow, line.credit);
    byBucket.set(key, b);
  }
  const buckets = [...byBucket.entries()]
    .map(([sourceType, b]) => ({ sourceType, inflow: b.inflow, outflow: b.outflow, net: sub(b.inflow, b.outflow) }))
    .sort((a, b) => a.sourceType.localeCompare(b.sourceType));

  const totalInflow = sum(buckets.map((b) => b.inflow));
  const totalOutflow = sum(buckets.map((b) => b.outflow));
  return { buckets, totalInflow, totalOutflow, netChange: sub(totalInflow, totalOutflow) };
}

// ------------------------------------------------------------ Sales Aging (by invoice)

export type InvoiceAgeingRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerName: string;
  dueDate: Date | null;
  daysOverdue: number;
  bucket: AgeingBucketKey;
  outstanding: Money;
};

/** One row per open sales invoice, unlike accountsReceivableAgeing's per-customer net — Vyapar's "Sales Aging" is bill-wise. */
export async function salesAgeingByInvoice(asOfDate: Date, db: Db = prisma): Promise<InvoiceAgeingRow[]> {
  const { outstandingOnInvoice } = await import("./receipts");
  const invoices = await db.salesInvoice.findMany({
    where: { status: { in: ["POSTED", "PARTIALLY_PAID"] }, invoiceDate: { lte: asOfDate } },
    select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, customer: { select: { name: true } } },
    orderBy: { invoiceDate: "asc" },
  });

  const rows: InvoiceAgeingRow[] = [];
  for (const inv of invoices) {
    const outstanding = await outstandingOnInvoice(inv.id, db);
    if (outstanding.isZero()) continue;
    const daysOverdue = inv.dueDate
      ? Math.floor((asOfDate.getTime() - inv.dueDate.getTime()) / (24 * 60 * 60 * 1000))
      : 0;
    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      customerName: inv.customer.name,
      dueDate: inv.dueDate,
      daysOverdue,
      bucket: ageingBucket(daysOverdue),
      outstanding,
    });
  }
  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

// ------------------------------------------------------------ Bill Wise Profit

export type BillProfitRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerName: string;
  revenue: Money;
  /** Null when any line on this invoice has no cost history yet — never read as zero. */
  estimatedCost: Money | null;
  estimatedMargin: Money | null;
  hasUnknownCostLine: boolean;
};

/** Per-invoice revenue minus the informational estimated cost snapshot. Excludes opening invoices — a migrated balance has no margin to compute. */
export async function billWiseProfit(fromDate: Date, toDate: Date, db: Db = prisma): Promise<BillProfitRow[]> {
  const invoices = await db.salesInvoice.findMany({
    where: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      customer: { select: { name: true } },
      items: { select: { taxableValue: true, estimatedCostAmount: true } },
    },
    orderBy: { invoiceDate: "asc" },
  });

  return invoices.map((inv) => {
    const revenue = sum(inv.items.map((i) => i.taxableValue));
    const hasUnknownCostLine = inv.items.some((i) => i.estimatedCostAmount === null);
    const estimatedCost = hasUnknownCostLine ? null : sum(inv.items.map((i) => money(i.estimatedCostAmount)));
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      customerName: inv.customer.name,
      revenue,
      estimatedCost,
      estimatedMargin: estimatedCost === null ? null : sub(revenue, estimatedCost),
      hasUnknownCostLine,
    };
  });
}

// ------------------------------------------------------------ Party Statement

export type PartyStatementLine = {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  narration: string;
  sourceType: string;
  debit: Money;
  credit: Money;
  runningBalance: Money;
};
export type PartyStatementResult = {
  partyId: string;
  partyName: string;
  openingBalance: Money;
  lines: PartyStatementLine[];
  closingBalance: Money;
};

/**
 * A true ledger sub-account statement for one customer or supplier —
 * `JournalLine.partyType`/`partyId` (indexed, tagged by every AR/AP posting
 * path) filtered to one party, with a running balance, the same shape as
 * `generalLedger` but scoped to a party instead of an account. A customer
 * statement is debit-normal (what they owe us grows with debits, mirroring
 * AR_TRADE); a supplier statement is credit-normal (what we owe them grows
 * with credits, mirroring AP_TRADE).
 */
export async function partyStatement(
  partyId: string,
  kind: "CUSTOMER" | "SUPPLIER",
  fromDate: Date,
  toDate: Date,
  db: Db = prisma,
): Promise<PartyStatementResult> {
  const sign = kind === "CUSTOMER" ? 1 : -1;
  const partyName =
    kind === "CUSTOMER"
      ? (await db.customer.findUniqueOrThrow({ where: { id: partyId }, select: { name: true } })).name
      : (await db.supplier.findUniqueOrThrow({ where: { id: partyId }, select: { name: true } })).name;

  const priorLines = await db.journalLine.aggregate({
    where: { partyType: kind, partyId, entry: { ...NOT_DRAFT, entryDate: { lt: fromDate } } },
    _sum: { debit: true, credit: true },
  });
  const openingBalance = money(sub(priorLines._sum.debit, priorLines._sum.credit)).times(sign);

  const rows = await db.journalLine.findMany({
    where: { partyType: kind, partyId, entry: { ...NOT_DRAFT, entryDate: { gte: fromDate, lte: toDate } } },
    include: { entry: { select: { entryNumber: true, entryDate: true, narration: true, sourceType: true } } },
    orderBy: [{ entry: { entryDate: "asc" } }, { entry: { entryNumber: "asc" } }, { lineNumber: "asc" }],
  });

  let running = openingBalance;
  const lines: PartyStatementLine[] = rows.map((line) => {
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

  return { partyId, partyName, openingBalance, lines, closingBalance: running };
}

// ------------------------------------------------------------ Party-wise P&L / All Parties / Item by Party

export type PartyProfitRow = { customerId: string; customerName: string; revenue: Money; estimatedCost: Money; estimatedMargin: Money };

/** Revenue and estimated cost per customer. A null per-line cost counts as 0 here — an aggregate is already an estimate. */
export async function partyWiseProfitAndLoss(fromDate: Date, toDate: Date, db: Db = prisma): Promise<PartyProfitRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: {
      taxableValue: true,
      estimatedCostAmount: true,
      invoice: { select: { customerId: true, customer: { select: { name: true } } } },
    },
  });

  const byCustomer = new Map<string, { name: string; revenue: Money; cost: Money }>();
  for (const item of items) {
    const key = item.invoice.customerId;
    const row = byCustomer.get(key) ?? { name: item.invoice.customer.name, revenue: money(0), cost: money(0) };
    row.revenue = add(row.revenue, item.taxableValue);
    row.cost = add(row.cost, money(item.estimatedCostAmount ?? 0));
    byCustomer.set(key, row);
  }
  return [...byCustomer.entries()]
    .map(([customerId, r]) => ({ customerId, customerName: r.name, revenue: r.revenue, estimatedCost: r.cost, estimatedMargin: sub(r.revenue, r.cost) }))
    .sort((a, b) => b.revenue.comparedTo(a.revenue));
}

export type PartySummaryRow = {
  partyId: string;
  partyName: string;
  partyType: "CUSTOMER" | "SUPPLIER";
  totalInvoiced: Money;
  totalSettled: Money;
  outstanding: Money;
};

/** One row per party (customer or supplier) with lifetime invoiced, settled and outstanding as of a date. */
export async function allPartiesSummary(asOfDate: Date, db: Db = prisma): Promise<PartySummaryRow[]> {
  const [customerTotals, supplierTotals, arAgeing, apAgeing] = await Promise.all([
    db.salesInvoice.groupBy({
      by: ["customerId"],
      where: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { lte: asOfDate } },
      _sum: { totalAmount: true },
    }),
    db.purchaseInvoice.groupBy({
      by: ["supplierId"],
      where: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { lte: asOfDate } },
      _sum: { totalAmount: true },
    }),
    accountsReceivableAgeing(asOfDate, db),
    accountsPayableAgeing(asOfDate, db),
  ]);
  const arByParty = new Map(arAgeing.map((r) => [r.partyId, r.total]));
  const apByParty = new Map(apAgeing.map((r) => [r.partyId, r.total]));

  const [customerNames, supplierNames] = await Promise.all([
    db.customer.findMany({ where: { id: { in: customerTotals.map((c) => c.customerId) } }, select: { id: true, name: true } }),
    db.supplier.findMany({ where: { id: { in: supplierTotals.map((s) => s.supplierId) } }, select: { id: true, name: true } }),
  ]);
  const customerNameById = new Map(customerNames.map((c) => [c.id, c.name]));
  const supplierNameById = new Map(supplierNames.map((s) => [s.id, s.name]));

  const customerRows: PartySummaryRow[] = customerTotals.map((c) => {
    const totalInvoiced = money(c._sum.totalAmount ?? 0);
    const outstanding = arByParty.get(c.customerId) ?? money(0);
    return {
      partyId: c.customerId,
      partyName: customerNameById.get(c.customerId) ?? "—",
      partyType: "CUSTOMER",
      totalInvoiced,
      totalSettled: sub(totalInvoiced, outstanding),
      outstanding,
    };
  });
  const supplierRows: PartySummaryRow[] = supplierTotals.map((s) => {
    const totalInvoiced = money(s._sum.totalAmount ?? 0);
    const outstanding = apByParty.get(s.supplierId) ?? money(0);
    return {
      partyId: s.supplierId,
      partyName: supplierNameById.get(s.supplierId) ?? "—",
      partyType: "SUPPLIER",
      totalInvoiced,
      totalSettled: sub(totalInvoiced, outstanding),
      outstanding,
    };
  });

  return [...customerRows, ...supplierRows].sort((a, b) => b.outstanding.comparedTo(a.outstanding));
}

export type PartyItemRow = { productId: string | null; productName: string; quantity: Money; value: Money };

/** Products bought by one customer over a range — "Item Report By Party" and "Party report by Item" are the same query, presented from either side. */
export async function partyReportByItem(customerId: string, fromDate: Date, toDate: Date, db: Db = prisma): Promise<PartyItemRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { invoice: { customerId, status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: { productId: true, description: true, quantity: true, taxableValue: true },
  });
  const byProduct = new Map<string, PartyItemRow>();
  for (const item of items) {
    const key = item.productId ?? item.description;
    const row = byProduct.get(key) ?? { productId: item.productId, productName: item.description, quantity: money(0), value: money(0) };
    row.quantity = add(row.quantity, item.quantity);
    row.value = add(row.value, item.taxableValue);
    byProduct.set(key, row);
  }
  return [...byProduct.values()].sort((a, b) => b.value.comparedTo(a.value));
}

// ------------------------------------------------------------ HSN Summary

export type HsnSummaryRow = {
  hsnCode: string;
  taxableValue: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
  total: Money;
  count: number;
};

/** gstOutwardSupplyRegister's line detail, aggregated by HSN — Vyapar's "Sale Summary By HSN". There is no SAC equivalent: Urvar sells physical goods, not services. */
export async function hsnSummary(fromDate: Date, toDate: Date, db: Db = prisma): Promise<HsnSummaryRow[]> {
  const rows = await gstOutwardSupplyRegister(fromDate, toDate, db);
  const byHsn = new Map<string, HsnSummaryRow>();
  for (const r of rows) {
    const row = byHsn.get(r.hsnCode) ?? { hsnCode: r.hsnCode, taxableValue: money(0), cgst: money(0), sgst: money(0), igst: money(0), cess: money(0), total: money(0), count: 0 };
    row.taxableValue = add(row.taxableValue, r.taxableValue);
    row.cgst = add(row.cgst, r.cgst);
    row.sgst = add(row.sgst, r.sgst);
    row.igst = add(row.igst, r.igst);
    row.cess = add(row.cess, r.cess);
    row.total = add(row.total, r.total);
    row.count += 1;
    byHsn.set(r.hsnCode, row);
  }
  return [...byHsn.values()].sort((a, b) => b.taxableValue.comparedTo(a.taxableValue));
}

// ------------------------------------------------------------ Item-wise / Category-wise P&L

export type ItemProfitRow = { productId: string; productName: string; revenue: Money; estimatedCost: Money; estimatedMargin: Money };

/** Revenue and estimated cost per product. A null per-line cost counts as 0 — same aggregate-estimate reasoning as partyWiseProfitAndLoss. */
export async function itemWiseProfitAndLoss(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ItemProfitRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { productId: { not: null }, invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: { productId: true, description: true, taxableValue: true, estimatedCostAmount: true },
  });
  const byProduct = new Map<string, { name: string; revenue: Money; cost: Money }>();
  for (const item of items) {
    const key = item.productId!;
    const row = byProduct.get(key) ?? { name: item.description, revenue: money(0), cost: money(0) };
    row.revenue = add(row.revenue, item.taxableValue);
    row.cost = add(row.cost, money(item.estimatedCostAmount ?? 0));
    byProduct.set(key, row);
  }
  return [...byProduct.entries()]
    .map(([productId, r]) => ({ productId, productName: r.name, revenue: r.revenue, estimatedCost: r.cost, estimatedMargin: sub(r.revenue, r.cost) }))
    .sort((a, b) => b.revenue.comparedTo(a.revenue));
}

export type ItemCategoryProfitRow = { category: string; revenue: Money; estimatedCost: Money; estimatedMargin: Money };

/** Same as itemWiseProfitAndLoss, grouped by Product.category instead of product. */
export async function itemCategoryWiseProfitAndLoss(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ItemCategoryProfitRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { productId: { not: null }, invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: { taxableValue: true, estimatedCostAmount: true, product: { select: { category: true } } },
  });
  const byCategory = new Map<string, { revenue: Money; cost: Money }>();
  for (const item of items) {
    const key = item.product!.category;
    const row = byCategory.get(key) ?? { revenue: money(0), cost: money(0) };
    row.revenue = add(row.revenue, item.taxableValue);
    row.cost = add(row.cost, money(item.estimatedCostAmount ?? 0));
    byCategory.set(key, row);
  }
  return [...byCategory.entries()]
    .map(([category, r]) => ({ category, revenue: r.revenue, estimatedCost: r.cost, estimatedMargin: sub(r.revenue, r.cost) }))
    .sort((a, b) => b.revenue.comparedTo(a.revenue));
}

// ------------------------------------------------------------ Discount reports

function lineDiscountAmount(item: { quantity: Money; unitPrice: Money; discountPercent: Money }): Money {
  const gross = mul(item.quantity, item.unitPrice);
  return round(percentOf(gross, item.discountPercent));
}

export type DiscountRow = { key: string; label: string; discountAmount: Money };

/** Discount given per product, recomputed from quantity × unitPrice × discountPercent — the same formula tax.ts's priceLine() applies when pricing the line, never stored as a standalone amount. */
export async function itemWiseDiscount(fromDate: Date, toDate: Date, db: Db = prisma): Promise<DiscountRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { discountPercent: { gt: 0 }, invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: { productId: true, description: true, quantity: true, unitPrice: true, discountPercent: true },
  });
  const byProduct = new Map<string, DiscountRow>();
  for (const item of items) {
    const key = item.productId ?? item.description;
    const row = byProduct.get(key) ?? { key, label: item.description, discountAmount: money(0) };
    row.discountAmount = add(row.discountAmount, lineDiscountAmount(item));
    byProduct.set(key, row);
  }
  return [...byProduct.values()].sort((a, b) => b.discountAmount.comparedTo(a.discountAmount));
}

/** Same discount data as itemWiseDiscount, grouped by customer instead of product — Vyapar's Business Report > Discount Report. */
export async function discountReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<DiscountRow[]> {
  const items = await db.salesInvoiceItem.findMany({
    where: { discountPercent: { gt: 0 }, invoice: { status: { not: "CANCELLED" }, isOpeningItem: false, invoiceDate: { gte: fromDate, lte: toDate } } },
    select: { quantity: true, unitPrice: true, discountPercent: true, invoice: { select: { customerId: true, customer: { select: { name: true } } } } },
  });
  const byCustomer = new Map<string, DiscountRow>();
  for (const item of items) {
    const key = item.invoice.customerId;
    const row = byCustomer.get(key) ?? { key, label: item.invoice.customer.name, discountAmount: money(0) };
    row.discountAmount = add(row.discountAmount, lineDiscountAmount(item));
    byCustomer.set(key, row);
  }
  return [...byCustomer.values()].sort((a, b) => b.discountAmount.comparedTo(a.discountAmount));
}

// ------------------------------------------------------------ Expense reports

export type ExpenseCategoryRow = { accountId: string; code: string; name: string; total: Money; count: number };

/** Approved expenses grouped by category account. */
export async function expenseCategoryReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ExpenseCategoryRow[]> {
  const grouped = await db.expense.groupBy({
    by: ["categoryAccountId"],
    where: { status: "APPROVED", expenseDate: { gte: fromDate, lte: toDate } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  if (grouped.length === 0) return [];
  const accounts = await db.ledgerAccount.findMany({
    where: { id: { in: grouped.map((g) => g.categoryAccountId) } },
    select: { id: true, code: true, name: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return grouped
    .map((g) => {
      const account = byId.get(g.categoryAccountId)!;
      return { accountId: account.id, code: account.code, name: account.name, total: money(g._sum.amount ?? 0), count: g._count._all };
    })
    .sort((a, b) => b.total.comparedTo(a.total));
}

export type ExpenseItemRow = { description: string; quantity: Money; totalValue: Money };

/**
 * Approved expenses' itemised lines (Part B), grouped by description. Covers
 * both "Expense Item Report" and "Expense Category Report" from Vyapar's
 * menu in spirit — `Expense` has no separate line-item categorisation beyond
 * the expense's own single category, so a per-line "category" breakdown
 * would just repeat expenseCategoryReport with extra steps.
 */
export async function expenseItemReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ExpenseItemRow[]> {
  const items = await db.expenseItem.findMany({
    where: { expense: { status: "APPROVED", expenseDate: { gte: fromDate, lte: toDate } } },
    select: { description: true, quantity: true, lineTotal: true },
  });
  const byDescription = new Map<string, ExpenseItemRow>();
  for (const item of items) {
    const key = item.description.trim().toLowerCase();
    const row = byDescription.get(key) ?? { description: item.description, quantity: money(0), totalValue: money(0) };
    row.quantity = add(row.quantity, item.quantity);
    row.totalValue = add(row.totalValue, item.lineTotal);
    byDescription.set(key, row);
  }
  return [...byDescription.values()].sort((a, b) => b.totalValue.comparedTo(a.totalValue));
}

// ------------------------------------------------------------ Cash, Bank & Assets

export type AccountGroupBalance = { accountId: string; code: string; name: string; balance: Money };
export type AccountGroupResult = { groupName: string; accounts: AccountGroupBalance[]; total: Money };

/**
 * Net balances for every postable account under a named parent group, as of
 * a date — reuses balanceSheet()'s own group-by-parent logic, just scoped to
 * one named group instead of a whole statement. Backs Bank Accounts (parent
 * "1120"), Fixed Assets ("1200") and Loan Accounts ("2200", Long-term
 * Liabilities — the one child today is "Loans" 2210, but this generalises if
 * more loan sub-accounts are ever added without a code change here).
 */
export async function accountGroupBalances(parentCode: string, asOfDate: Date, db: Db = prisma): Promise<AccountGroupResult | null> {
  const parent = await db.ledgerAccount.findUnique({ where: { code: parentCode } });
  if (!parent) return null;

  const children = await db.ledgerAccount.findMany({
    where: { parentId: parent.id, isPostable: true },
    select: { id: true, code: true, name: true, normalBalance: true },
  });
  if (children.length === 0) return { groupName: parent.name, accounts: [], total: money(0) };

  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { accountId: { in: children.map((c) => c.id) }, entry: { ...NOT_DRAFT, entryDate: { lte: asOfDate } } },
    _sum: { debit: true, credit: true },
  });
  const byId = new Map(grouped.map((g) => [g.accountId, g._sum]));

  // Sign by the PARENT's own normal balance, not each child's — a contra
  // account (e.g. 1290 Accumulated Depreciation, normalBalance CREDIT, but
  // living inside the debit-normal Fixed Assets group) must still net DOWN
  // the group total rather than add to it. balanceSheet()'s group() applies
  // the same rule at the type level; this was signing per-child instead,
  // which would have made this report double-count accumulated depreciation
  // as soon as anything posted to it — caught before Phase 9 became the
  // first thing that ever did.
  const groupSign = parent.normalBalance === "DEBIT" ? 1 : -1;
  const accounts: AccountGroupBalance[] = children.map((c) => {
    const sums = byId.get(c.id);
    const balance = money(sub(sums?.debit ?? 0, sums?.credit ?? 0)).times(groupSign);
    return { accountId: c.id, code: c.code, name: c.name, balance };
  });
  return { groupName: parent.name, accounts, total: sum(accounts.map((a) => a.balance)) };
}

/** Cash on Hand (1110) has no children of its own — it IS the account — so its balance is read directly rather than through accountGroupBalances. */
export async function cashOnHandBalance(asOfDate: Date, db: Db = prisma): Promise<AccountGroupBalance | null> {
  const account = await db.ledgerAccount.findUnique({ where: { code: "1110" } });
  if (!account) return null;
  const agg = await db.journalLine.aggregate({
    where: { accountId: account.id, entry: { ...NOT_DRAFT, entryDate: { lte: asOfDate } } },
    _sum: { debit: true, credit: true },
  });
  const balance = money(sub(agg._sum.debit, agg._sum.credit)); // Cash is debit-normal
  return { accountId: account.id, code: account.code, name: account.name, balance };
}
