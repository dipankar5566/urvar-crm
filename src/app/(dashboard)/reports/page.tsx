import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import {
  parseReportFilters,
  getLeadsReport,
  getOrdersReport,
  getQuotationsReport,
  getRepLeaderboard,
} from "@/lib/reports";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LEAD_STATUS_LABELS,
  QUOTATION_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  inr,
} from "@/lib/constants/labels";
import { ReportFiltersBar } from "./report-filters";
import { SimpleBarChart } from "./charts";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const scope = can(user.role, "reports", "read");
  const filters = parseReportFilters(params);
  const showRepFilter = scope === "all" || scope === "territory";

  const [leadsReport, ordersReport, quotationsReport, leaderboard, reps] =
    await Promise.all([
      getLeadsReport(user, filters),
      getOrdersReport(user, filters),
      getQuotationsReport(user, filters),
      getRepLeaderboard(user, filters),
      showRepFilter
        ? prisma.user.findMany({
            where: { role: { in: ["SALES_EXECUTIVE", "SALES_MANAGER"] }, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          })
        : Promise.resolve([]),
    ]);

  const totalLeadValue = leadsReport.leads.reduce(
    (sum, l) => sum + Number(l.estimatedValue ?? 0),
    0,
  );
  const totalOrderValue = Number(ordersReport.totals._sum.totalAmount ?? 0);
  const totalQuotationValue = quotationsReport.byStatus.reduce(
    (sum, s) => sum + Number(s._sum.totalAmount ?? 0),
    0,
  );
  const acceptedValue = Number(
    quotationsReport.byStatus.find((s) => s.status === "ACCEPTED")?._sum
      .totalAmount ?? 0,
  );

  const leadsByStatusChart = leadsReport.byStatus.map((row) => ({
    name: LEAD_STATUS_LABELS[row.status] ?? row.status,
    count: row._count._all,
  }));
  const revenueByStateChart = ordersReport.byState.map((row) => ({
    name: row.state,
    revenue: Number(row._sum.totalAmount ?? 0),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Filterable performance reports with CSV/Excel export.
        </p>
      </div>

      <ReportFiltersBar reps={reps} showRepFilter={showRepFilter} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Leads (pipeline value)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leadsReport.leads.length}</div>
            <p className="text-xs text-muted-foreground">{inr(totalLeadValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Quotations Sent Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{inr(totalQuotationValue)}</div>
            <p className="text-xs text-muted-foreground">
              {quotationsReport.quotations.length} quotations
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Quotations Accepted Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{inr(acceptedValue)}</div>
            <p className="text-xs text-muted-foreground">
              {totalQuotationValue > 0
                ? `${Math.round((acceptedValue / totalQuotationValue) * 100)}% of sent`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Order Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{inr(totalOrderValue)}</div>
            <p className="text-xs text-muted-foreground">
              {ordersReport.totals._count._all} orders
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leads by Status</CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleBarChart data={leadsByStatusChart} dataKey="count" nameKey="name" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Order Revenue by State</CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleBarChart
              data={revenueByStateChart}
              dataKey="revenue"
              nameKey="name"
              color="#0ea5e9"
              format="currency"
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Products (quoted value)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {quotationsReport.topProducts.length === 0 && (
              <p className="text-sm text-muted-foreground">No quotations in range.</p>
            )}
            {quotationsReport.topProducts.map((p) => (
              <div key={p.productName} className="flex items-center justify-between text-sm">
                <span className="truncate">{p.productName}</span>
                <span className="font-medium">{inr(p.totalValue)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {showRepFilter && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rep Leaderboard</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {leaderboard.length === 0 && (
                <p className="text-sm text-muted-foreground">No data in range.</p>
              )}
              {leaderboard.map((r) => (
                <div key={r.repId} className="flex items-center justify-between text-sm">
                  <span>{r.repName}</span>
                  <span className="flex items-center gap-2">
                    <Badge variant="secondary">{r.totalLeads} leads</Badge>
                    <Badge>{r.wonLeads} won</Badge>
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quotation Status Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {quotationsReport.byStatus.length === 0 && (
            <p className="text-sm text-muted-foreground">No quotations in range.</p>
          )}
          {quotationsReport.byStatus.map((row) => (
            <div key={row.status} className="flex items-center justify-between text-sm">
              <span>{QUOTATION_STATUS_LABELS[row.status] ?? row.status}</span>
              <span className="flex items-center gap-2">
                <Badge variant="secondary">{row._count._all}</Badge>
                <span className="font-medium">{inr(Number(row._sum.totalAmount ?? 0))}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order Status Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {ordersReport.byStatus.length === 0 && (
            <p className="text-sm text-muted-foreground">No orders in range.</p>
          )}
          {ordersReport.byStatus.map((row) => (
            <div key={row.status} className="flex items-center justify-between text-sm">
              <span>{ORDER_STATUS_LABELS[row.status] ?? row.status}</span>
              <Badge variant="secondary">{row._count._all}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
