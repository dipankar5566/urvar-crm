import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { can, scopedWhere } from "@/lib/permissions";
import { quotationScopeWhere } from "@/lib/reports";
import { inr, LEAD_STATUS_LABELS, PRODUCT_CATEGORY_LABELS } from "@/lib/constants/labels";
import { initialsOf, colorFor } from "@/lib/avatar";
import type { User } from "@/generated/prisma/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import type { DashboardPeriod } from "../period";

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

/** Lead breakdowns (status / state / recent) and top quoted products. */
export async function LeadInsights({
  user,
  period,
}: {
  user: User;
  period: DashboardPeriod;
}) {
  const leadScope = can(user.role, "leads", "read");
  const quoteScope = can(user.role, "quotations", "read");
  if (leadScope === "none" && quoteScope === "none") return null;

  const leadWhere = scopedWhere(leadScope, user, "assignedToId", { deletedAt: null });

  const [leadsByStatus, leadsByState, recentLeads, topProducts] = await Promise.all([
    leadScope !== "none"
      ? prisma.lead.groupBy({ by: ["status"], where: leadWhere, _count: { _all: true } })
      : [],
    leadScope !== "none"
      ? prisma.lead.groupBy({ by: ["state"], where: leadWhere, _count: { _all: true } })
      : [],
    leadScope !== "none"
      ? prisma.lead.findMany({
          where: leadWhere,
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, name: true, companyName: true, status: true },
        })
      : [],
    quoteScope !== "none"
      ? prisma.quotationItem.groupBy({
          by: ["productId"],
          where: {
            quotation: {
              AND: [
                quotationScopeWhere(quoteScope, user),
                { createdAt: { gte: period.from, lte: period.to } },
              ],
            },
          },
          _sum: { lineTotal: true },
          orderBy: { _sum: { lineTotal: "desc" } },
          take: 5,
        })
      : [],
  ]);

  const products = topProducts.length
    ? await prisma.product.findMany({
        where: { id: { in: topProducts.map((p) => p.productId) } },
        select: { id: true, name: true, category: true },
      })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  return (
    <div className="space-y-4">
      {leadScope !== "none" && (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <Card className="overflow-hidden p-0">
            <CardHeader className="flex flex-row items-center justify-between border-b py-3">
              <CardTitle className="text-sm">Recent Leads</CardTitle>
              <Link href="/leads" className="text-xs font-medium text-brand hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="space-y-0 p-0">
              {recentLeads.length === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground">No leads yet.</p>
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
                <p className="px-4 py-6 text-sm text-muted-foreground">No leads yet.</p>
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
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {leadScope !== "none" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leads by State</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {leadsByState.length === 0 && (
                <p className="text-sm text-muted-foreground">No leads yet.</p>
              )}
              {leadsByState.map((row) => (
                <div key={row.state} className="flex items-center justify-between text-sm">
                  <span>{row.state}</span>
                  <Badge variant="secondary">{row._count._all}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {quoteScope !== "none" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top Products (quoted) — {period.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {topProducts.length === 0 && (
                <p className="text-sm text-muted-foreground">No quotations in this period.</p>
              )}
              {topProducts.map((row) => {
                const p = productMap.get(row.productId);
                return (
                  <div key={row.productId} className="flex items-center justify-between text-sm">
                    <span className="truncate">
                      {p?.name ?? "Unknown"}{" "}
                      <span className="text-xs text-muted-foreground">
                        {p ? PRODUCT_CATEGORY_LABELS[p.category] : ""}
                      </span>
                    </span>
                    <span className="font-medium">{inr(Number(row._sum.lineTotal ?? 0))}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
