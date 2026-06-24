import { endOfDay, startOfDay } from "date-fns";
import {
  UserPlus,
  Phone,
  CalendarClock,
  FileText,
  TrendingUp,
  Trophy,
  AlertTriangle,
} from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LEAD_STATUS_LABELS,
  PRODUCT_CATEGORY_LABELS,
  inr,
} from "@/lib/constants/labels";

export default async function DashboardPage() {
  const user = await requireUser();
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  // Role-scoped lead filter (assignedToId for "own", state for "territory").
  const leadScope = scopeWhere(
    can(user.role, "leads", "read"),
    user,
    "assignedToId",
  );

  const [
    newLeadsToday,
    callsToday,
    followupsDueToday,
    overdueFollowups,
    quotationsSentToday,
    totalLeads,
    wonLeads,
    lostLeads,
    leadsByStatus,
    leadsByState,
    pipelineValue,
    topProducts,
  ] = await Promise.all([
    prisma.lead.count({
      where: { ...leadScope, createdAt: { gte: todayStart, lte: todayEnd } },
    }),
    prisma.call.count({
      where: { calledAt: { gte: todayStart, lte: todayEnd } },
    }),
    prisma.followUp.count({
      where: {
        status: "PENDING",
        dueAt: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.followUp.count({
      where: { status: "PENDING", dueAt: { lt: todayStart } },
    }),
    prisma.quotation.count({
      where: { sentAt: { gte: todayStart, lte: todayEnd } },
    }),
    prisma.lead.count({ where: leadScope }),
    prisma.lead.count({ where: { ...leadScope, status: "WON" } }),
    prisma.lead.count({ where: { ...leadScope, status: "LOST" } }),
    prisma.lead.groupBy({
      by: ["status"],
      where: leadScope,
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["state"],
      where: leadScope,
      _count: { _all: true },
    }),
    prisma.lead.aggregate({
      where: { ...leadScope, status: { notIn: ["WON", "LOST"] } },
      _sum: { estimatedValue: true },
    }),
    prisma.quotationItem.groupBy({
      by: ["productId"],
      _sum: { lineTotal: true },
      orderBy: { _sum: { lineTotal: "desc" } },
      take: 5,
    }),
  ]);

  const closed = wonLeads + lostLeads;
  const winRate = closed > 0 ? Math.round((wonLeads / closed) * 100) : 0;
  const conversionRate =
    totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0;

  // Resolve product names for the top-products widget.
  const productIds = topProducts.map((p) => p.productId);
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, category: true },
      })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  const today = [
    { label: "New Leads", value: newLeadsToday, icon: UserPlus },
    { label: "Calls Logged", value: callsToday, icon: Phone },
    { label: "Follow-ups Due", value: followupsDueToday, icon: CalendarClock },
    { label: "Quotations Sent", value: quotationsSentToday, icon: FileText },
  ];

  const metrics = [
    { label: "Total Leads", value: String(totalLeads), icon: UserPlus, hint: "in your scope" },
    { label: "Won", value: String(wonLeads), icon: Trophy, hint: `${conversionRate}% conversion` },
    { label: "Win Rate", value: `${winRate}%`, icon: TrendingUp, hint: `${closed} closed` },
    { label: "Open Pipeline", value: inr(Number(pipelineValue._sum.estimatedValue ?? 0)), icon: TrendingUp, hint: "est. value" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {user.name.split(" ")[0]}. Here&apos;s today at a glance.
        </p>
      </div>

      {overdueFollowups > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" />
          You have <strong>{overdueFollowups}</strong> overdue follow-up
          {overdueFollowups === 1 ? "" : "s"}.
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Today</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {today.map((c) => (
            <Card key={c.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
                <c.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{c.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          Sales Metrics
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {metrics.map((c) => (
            <Card key={c.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
                <c.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{c.value}</div>
                <p className="text-xs text-muted-foreground">{c.hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leads by Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {leadsByStatus.length === 0 && (
              <p className="text-sm text-muted-foreground">No leads yet.</p>
            )}
            {leadsByStatus.map((row) => (
              <div
                key={row.status}
                className="flex items-center justify-between text-sm"
              >
                <span>{LEAD_STATUS_LABELS[row.status] ?? row.status}</span>
                <Badge variant="secondary">{row._count._all}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leads by State</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {leadsByState.length === 0 && (
              <p className="text-sm text-muted-foreground">No leads yet.</p>
            )}
            {leadsByState.map((row) => (
              <div
                key={row.state}
                className="flex items-center justify-between text-sm"
              >
                <span>{row.state}</span>
                <Badge variant="secondary">{row._count._all}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Products (quoted)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topProducts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No quotations yet.
              </p>
            )}
            {topProducts.map((row) => {
              const p = productMap.get(row.productId);
              return (
                <div
                  key={row.productId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate">
                    {p?.name ?? "Unknown"}{" "}
                    <span className="text-xs text-muted-foreground">
                      {p ? PRODUCT_CATEGORY_LABELS[p.category] : ""}
                    </span>
                  </span>
                  <span className="font-medium">
                    {inr(Number(row._sum.lineTotal ?? 0))}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
