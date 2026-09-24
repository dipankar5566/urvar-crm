import { format, startOfMonth, subMonths } from "date-fns";
import { prisma } from "@/lib/prisma";
import { can, scopedWhere } from "@/lib/permissions";
import { quotationScopeWhere } from "@/lib/reports";
import { add, formatInr, money } from "@/lib/accounting/money";
import { inr } from "@/lib/constants/labels";
import type { User } from "@/generated/prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleBarChart } from "@/components/charts/simple-bar-chart";
import type { DashboardPeriod } from "../period";
import { SectionTitle, StatCard } from "./ui";

const CHART_MONTHS = 12;

/**
 * Lead funnel snapshot + revenue for the selected period + a 12-month order
 * revenue trend. The funnel KPIs are all-time (a lead's status is a current
 * state, not an event in a range); the "period" row and the chart are the
 * time-bound half.
 */
export async function SalesPerformance({
  user,
  period,
}: {
  user: User;
  period: DashboardPeriod;
}) {
  const leadScope = can(user.role, "leads", "read");
  const reportScope = can(user.role, "reports", "read");
  const quoteScope = can(user.role, "quotations", "read");
  const range = { gte: period.from, lte: period.to };

  const chartStart = startOfMonth(subMonths(new Date(), CHART_MONTHS - 1));

  const [
    totalLeads,
    wonLeads,
    lostLeads,
    pipelineValue,
    newLeads,
    quotationsSent,
    ordersAgg,
    chartOrders,
  ] = await Promise.all([
    leadScope !== "none"
      ? prisma.lead.count({
          where: scopedWhere(leadScope, user, "assignedToId", { deletedAt: null }),
        })
      : 0,
    leadScope !== "none"
      ? prisma.lead.count({
          where: scopedWhere(leadScope, user, "assignedToId", {
            deletedAt: null,
            status: "WON",
          }),
        })
      : 0,
    leadScope !== "none"
      ? prisma.lead.count({
          where: scopedWhere(leadScope, user, "assignedToId", {
            deletedAt: null,
            status: "LOST",
          }),
        })
      : 0,
    leadScope !== "none"
      ? prisma.lead.aggregate({
          where: scopedWhere(leadScope, user, "assignedToId", {
            deletedAt: null,
            status: { notIn: ["WON", "LOST"] },
          }),
          _sum: { estimatedValue: true },
        })
      : null,
    leadScope !== "none"
      ? prisma.lead.count({
          where: scopedWhere(leadScope, user, "assignedToId", {
            deletedAt: null,
            createdAt: range,
          }),
        })
      : 0,
    quoteScope !== "none"
      ? prisma.quotation.count({
          where: { AND: [quotationScopeWhere(quoteScope, user), { sentAt: range }] },
        })
      : 0,
    reportScope !== "none"
      ? prisma.order.aggregate({
          where: scopedWhere(reportScope, user, "createdById", {
            orderedAt: range,
            status: { not: "CANCELLED" },
          }),
          _sum: { totalAmount: true },
          _count: { _all: true },
        })
      : null,
    // Two columns only, bucketed by month below. Prisma can't group by a
    // date_trunc, and a raw query would have to re-express the role scope in
    // SQL — not worth it while a year of orders is thousands of rows, not
    // millions. Revisit if order volume grows by two orders of magnitude.
    reportScope !== "none"
      ? prisma.order.findMany({
          where: scopedWhere(reportScope, user, "createdById", {
            orderedAt: { gte: chartStart },
            status: { not: "CANCELLED" },
          }),
          select: { orderedAt: true, totalAmount: true },
        })
      : null,
  ]);

  const closed = wonLeads + lostLeads;
  const winRate = closed > 0 ? Math.round((wonLeads / closed) * 100) : 0;
  const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0;

  // Month buckets, oldest first, every month present even when empty so the
  // chart's x-axis is a continuous 12 months rather than only the busy ones.
  const buckets = new Map<string, { label: string; total: ReturnType<typeof money> }>();
  for (let i = CHART_MONTHS - 1; i >= 0; i--) {
    const d = startOfMonth(subMonths(new Date(), i));
    buckets.set(format(d, "yyyy-MM"), { label: format(d, "MMM yy"), total: money(0) });
  }
  for (const o of chartOrders ?? []) {
    const b = buckets.get(format(o.orderedAt, "yyyy-MM"));
    if (b) b.total = add(b.total, o.totalAmount);
  }
  // Decimal -> number only here, at the chart's prop boundary.
  const chartData = [...buckets.values()].map((b) => ({
    name: b.label,
    revenue: Number(b.total.toFixed(2)),
  }));

  const orderCount = ordersAgg?._count._all ?? 0;
  const orderValue = money(ordersAgg?._sum.totalAmount ?? 0);

  return (
    <div className="space-y-6">
      {leadScope !== "none" && (
        <section>
          <SectionTitle>Sales funnel</SectionTitle>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatCard label="Total Leads" value={totalLeads} hint="in your scope" href="/leads" />
            <StatCard label="Won" value={wonLeads} hint={`${conversionRate}% conversion`} tone="good" />
            <StatCard label="Win Rate" value={`${winRate}%`} hint={`${closed} closed`} />
            <StatCard
              label="Open Pipeline"
              value={inr(Number(pipelineValue?._sum.estimatedValue ?? 0))}
              hint="est. value"
              href="/pipeline"
            />
          </div>
        </section>
      )}

      <section>
        <SectionTitle>{period.label}</SectionTitle>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {leadScope !== "none" && <StatCard label="New Leads" value={newLeads} />}
          {quoteScope !== "none" && (
            <StatCard label="Quotations Sent" value={quotationsSent} href="/quotations" />
          )}
          {ordersAgg && (
            <>
              <StatCard label="Orders" value={orderCount} />
              <StatCard
                label="Order Value"
                value={formatInr(orderValue, { alwaysPaise: false })}
                tone="good"
              />
            </>
          )}
        </div>
      </section>

      {chartOrders && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Order revenue — last 12 months</CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleBarChart data={chartData} dataKey="revenue" nameKey="name" format="currency" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
