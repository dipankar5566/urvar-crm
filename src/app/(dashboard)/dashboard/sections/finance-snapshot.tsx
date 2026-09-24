import { endOfDay } from "date-fns";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { formatInr, isNegative, money, sub, sum, add, type Money } from "@/lib/accounting/money";
import {
  accountGroupBalances,
  accountsPayableAgeing,
  accountsReceivableAgeing,
  AGEING_BUCKET_LABELS,
  cashOnHandBalance,
  profitAndLoss,
  type AgeingBucketKey,
  type AgeingRow,
} from "@/lib/accounting/financial-reports";
import Link from "next/link";
import type { User } from "@/generated/prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardPeriod } from "../period";
import { SectionTitle, StatCard } from "./ui";

/** Debtor/creditor rows shown on the dashboard; the full lists live in the AR/AP ageing reports. */
const PARTIES_SHOWN = 10;

const BUCKET_ORDER: AgeingBucketKey[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];
const BUCKET_COLOR: Record<AgeingBucketKey, string> = {
  current: "bg-emerald-500",
  d1_30: "bg-amber-400",
  d31_60: "bg-orange-500",
  d61_90: "bg-red-500",
  d90_plus: "bg-red-800",
};

const fmt = (v: Parameters<typeof formatInr>[0]) => formatInr(v, { alwaysPaise: false });

/** All the ledger/document reads for the panel, in one parallel round. */
async function loadFinance(asOf: Date, period: DashboardPeriod) {
  const range = { gte: period.from, lte: period.to };
  const [cash, bank, ar, ap, pnl, invoiced, collected, loans, assets] = await Promise.all([
    cashOnHandBalance(asOf),
    accountGroupBalances("1120", asOf),
    accountsReceivableAgeing(asOf),
    accountsPayableAgeing(asOf),
    profitAndLoss(period.from, period.to),
    // isOpeningItem excluded: Vyapar-migrated opening balances post to AR and
    // Opening Balance Equity, never revenue. They are real receivables (so
    // they stay in the AR figure) but not sales made in this period, and
    // counting them here made "Invoiced" disagree with a P&L showing no income.
    prisma.salesInvoice.aggregate({
      where: {
        invoiceDate: range,
        isOpeningItem: false,
        status: { notIn: ["DRAFT", "CANCELLED"] },
      },
      _sum: { totalAmount: true },
    }),
    prisma.receipt.aggregate({
      where: { receiptDate: range, status: { not: "CANCELLED" } },
      _sum: { amount: true },
    }),
    accountGroupBalances("2200", asOf),
    accountGroupBalances("1200", asOf),
  ]);
  return { cash, bank, ar, ap, pnl, invoiced, collected, loans, assets };
}

/**
 * Money position, straight from the ledger via the same functions the
 * Financial Reports pages call — so a dashboard figure and its report can't
 * disagree. Nothing is computed with `number`; amounts stay `Money` until
 * they are formatted.
 *
 * Accounting-read roles only (SUPER_ADMIN / ACCOUNTS_TEAM). A ledger failure
 * (e.g. a missing account mapping) degrades this one panel to a notice rather
 * than taking the whole dashboard down. Only the data load sits in the
 * try/catch; the JSX is built after it, since a render error can't be caught
 * by a try around JSX construction anyway.
 */
export async function FinanceSnapshot({
  user,
  period,
}: {
  user: User;
  period: DashboardPeriod;
}) {
  if (can(user.role, "accounting", "read") === "none") return null;

  let data: Awaited<ReturnType<typeof loadFinance>> | null = null;
  try {
    data = await loadFinance(endOfDay(new Date()), period);
  } catch (err) {
    console.error("[dashboard] finance snapshot failed", err);
  }

  if (!data) {
    return (
      <section>
        <SectionTitle>Finance</SectionTitle>
        <Card>
          <CardContent className="px-[18px] py-4 text-sm text-muted-foreground">
            Finance figures are temporarily unavailable. The rest of the dashboard is unaffected.
          </CardContent>
        </Card>
      </section>
    );
  }

  const { cash, bank, ar, ap, pnl, invoiced, collected, loans, assets } = data;

  const cashBalance = money(cash?.balance ?? 0);
  const bankBalance = money(bank?.total ?? 0);
  const arTotal = sum(ar.map((r) => r.total));
  const arOverdue = sub(arTotal, sum(ar.map((r) => r.buckets.current)));
  const apTotal = sum(ap.map((r) => r.total));
  const profit = pnl.netProfit;

  const arByBucket = BUCKET_ORDER.map((key) => ({
    key,
    amount: sum(ar.map((r) => r.buckets[key])),
  }));


  return (
    <section className="space-y-2.5">
      <SectionTitle>Finance</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label="Cash & Bank"
          value={fmt(add(cashBalance, bankBalance))}
          hint={`Cash ${fmt(cashBalance)} · Bank ${fmt(bankBalance)}`}
          href="/accounting/cash-bank"
        />
        <StatCard
          label="Receivables"
          value={fmt(arTotal)}
          hint={arOverdue.greaterThan(0) ? `${fmt(arOverdue)} overdue` : "nothing overdue"}
          tone={arOverdue.greaterThan(0) ? "warn" : "default"}
          href="/accounting/reports/ar-ageing"
        />
        <StatCard label="Payables" value={fmt(apTotal)} href="/accounting/reports/ap-ageing" />
        <StatCard
          label={`Net Profit · ${period.label}`}
          value={fmt(profit)}
          hint={`Income ${fmt(pnl.totalIncome)} · Expenses ${fmt(pnl.totalExpenses)}`}
          tone={isNegative(profit) ? "bad" : "good"}
          href="/accounting/reports/profit-and-loss"
        />
        <StatCard
          label={`Invoiced · ${period.label}`}
          value={fmt(invoiced._sum.totalAmount)}
          href="/invoices"
        />
        <StatCard
          label={`Collected · ${period.label}`}
          value={fmt(collected._sum.amount)}
          href="/receipts"
        />
        <StatCard
          label="Loans Outstanding"
          value={fmt(loans?.total ?? 0)}
          href="/accounting/loans"
        />
        <StatCard
          label="Fixed Assets"
          value={fmt(assets?.total ?? 0)}
          hint="net book value"
          href="/accounting/fixed-assets"
        />
      </div>

      {arTotal.greaterThan(0) && (
        <Card>
          <CardContent className="space-y-2.5 px-[18px] py-4">
            <div className="text-xs font-medium text-muted-foreground">Receivables ageing</div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              {arByBucket
                .filter((b) => b.amount.greaterThan(0))
                .map((b) => (
                  <div
                    key={b.key}
                    className={BUCKET_COLOR[b.key]}
                    // Width only — a display ratio, not an amount.
                    style={{ width: `${(b.amount.div(arTotal).toNumber() * 100).toFixed(2)}%` }}
                    title={`${AGEING_BUCKET_LABELS[b.key]}: ${fmt(b.amount)}`}
                  />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {arByBucket.map((b) => (
                <span key={b.key} className="inline-flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${BUCKET_COLOR[b.key]}`} />
                  {AGEING_BUCKET_LABELS[b.key]} {fmt(b.amount)}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-2.5 2xl:grid-cols-2">
        <PartyBalances
          title="Debtors"
          empty="No outstanding debtors."
          partyLabel="Customer"
          rows={ar}
          total={arTotal}
          reportHref="/accounting/reports/ar-ageing"
          partyHref={(id) => `/customers/${id}`}
          // Customer ageing is by due date: anything outside `current` is past due.
          dueLabel="Overdue"
          dueOf={(r) => sub(r.total, r.buckets.current)}
        />
        <PartyBalances
          title="Creditors"
          empty="No outstanding creditors."
          partyLabel="Supplier"
          rows={ap}
          total={apTotal}
          reportHref="/accounting/reports/ap-ageing"
          partyHref={(id) => `/accounting/reports/party-statement?partyType=SUPPLIER&partyId=${id}`}
          // Purchase invoices carry no due date, so AP ages from the invoice
          // date and "overdue" would be invented; show what's over 30 days old.
          dueLabel="Over 30 days"
          dueOf={(r) => sum([r.buckets.d31_60, r.buckets.d61_90, r.buckets.d90_plus])}
        />
      </div>
    </section>
  );
}

/**
 * One party per row with an outstanding balance, largest first, for either
 * side of the ledger — debtors (AR) or creditors (AP). Built from the
 * `AgeingRow`s the panel already loaded, so it adds no queries and its total
 * always equals the matching summary card. The ageing functions don't promise
 * an order, so rows are sorted here. `oldest` is the most-aged bucket that
 * still holds a balance.
 */
function PartyBalances({
  title,
  empty,
  partyLabel,
  rows,
  total,
  reportHref,
  partyHref,
  dueLabel,
  dueOf,
}: {
  title: string;
  empty: string;
  partyLabel: string;
  rows: AgeingRow[];
  total: Money;
  reportHref: string;
  partyHref: (partyId: string) => string;
  dueLabel: string;
  dueOf: (row: AgeingRow) => Money;
}) {
  const parties = rows
    .filter((r) => r.total.greaterThan(0))
    .sort((a, b) => b.total.comparedTo(a.total))
    .map((r) => ({
      id: r.partyId,
      name: r.partyName,
      total: r.total,
      due: dueOf(r),
      oldest: [...BUCKET_ORDER].reverse().find((k) => r.buckets[k].greaterThan(0)) ?? "current",
    }));
  const shown = parties.slice(0, PARTIES_SHOWN);
  const hidden = parties.length - shown.length;
  const totalDue = sum(parties.map((p) => p.due));

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Link href={reportHref} className="text-xs font-medium text-brand hover:underline">
          View ageing
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {parties.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wide text-tertiary-foreground">
                  <th className="px-4 py-2 text-left font-semibold">{partyLabel}</th>
                  <th className="px-4 py-2 text-right font-semibold">Outstanding</th>
                  <th className="px-4 py-2 text-right font-semibold">{dueLabel}</th>
                  <th className="px-4 py-2 text-right font-semibold">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="border-b last:border-b-0 hover:bg-accent/40">
                    <td className="max-w-[16rem] truncate px-4 py-2.5">
                      <Link href={partyHref(p.id)} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{fmt(p.total)}</td>
                    <td
                      className={`px-4 py-2.5 text-right tabular-nums ${
                        p.due.greaterThan(0) ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                      }`}
                    >
                      {p.due.greaterThan(0) ? fmt(p.due) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${BUCKET_COLOR[p.oldest]}`} />
                        {AGEING_BUCKET_LABELS[p.oldest]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {hidden > 0 && (
                  <tr className="border-t">
                    <td colSpan={4} className="px-4 py-2 text-xs">
                      <Link href={reportHref} className="font-medium text-brand hover:underline">
                        +{hidden} more
                      </Link>
                    </td>
                  </tr>
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-4 py-2.5">Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {totalDue.greaterThan(0) ? fmt(totalDue) : "—"}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
