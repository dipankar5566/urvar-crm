import Link from "next/link";
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
import { StatusBadge } from "@/components/status-badge";
import { initialsOf, colorFor } from "@/lib/avatar";
import {
  LEAD_STATUS_LABELS,
  PRODUCT_CATEGORY_LABELS,
  inr,
} from "@/lib/constants/labels";

const STATUS_DOT: Record<string, string> = {
  NEW: "var(--status-new-fg)",
  CONTACTED: "var(--status-contacted-fg)",
  INTERESTED: "var(--status-interested-fg)",
  FOLLOW_UP: "var(--status-follow_up-fg)",
  QUOTATION_SENT: "var(--status-quotation_sent-fg)",
  NEGOTIATION: "var(--status-negotiation-fg)",
  WON: "var(--status-won-fg)",
  LOST: "var(--status-lost-fg)",
};

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
    recentLeads,
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
    prisma.lead.findMany({
      where: leadScope,
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, name: true, companyName: true, status: true },
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
        <div
          className="flex items-center gap-2.5 rounded-md px-3.5 py-2.5 text-sm"
          style={{
            background: "rgba(255,167,52,0.1)",
            border: "1px solid rgba(255,167,52,0.3)",
            color: "#D9730D",
          }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>
              {overdueFollowups} overdue follow-up
              {overdueFollowups === 1 ? "" : "s"}
            </strong>{" "}
            need your attention.
          </span>
          <Link
            href="/follow-ups"
            className="ml-auto shrink-0 font-medium text-brand hover:underline"
          >
            View →
          </Link>
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
          Performance
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

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="overflow-hidden p-0">
          <CardHeader className="flex flex-row items-center justify-between border-b py-3">
            <CardTitle className="text-sm">Recent Leads</CardTitle>
            <Link
              href="/leads"
              className="text-xs font-medium text-brand hover:underline"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            {recentLeads.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No leads yet.
              </p>
            )}
            {recentLeads.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="flex items-center gap-2.5 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-accent"
              >
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: colorFor(lead.name) }}
                >
                  {initialsOf(lead.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{lead.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {lead.companyName ?? lead.name}
                  </div>
                </div>
                <StatusBadge status={lead.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden p-0">
          <CardHeader className="border-b py-3">
            <CardTitle className="text-sm">Leads by Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            {leadsByStatus.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No leads yet.
              </p>
            )}
            {leadsByStatus.map((row) => (
              <div
                key={row.status}
                className="flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: STATUS_DOT[row.status] }}
                  />
                  <span>{LEAD_STATUS_LABELS[row.status] ?? row.status}</span>
                </div>
                <span className="font-semibold">{row._count._all}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
