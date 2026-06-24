import { prisma } from "@/lib/prisma";
import { can, scopeWhere, type Scope } from "@/lib/permissions";
import type { requireUser } from "@/lib/session";

export type ReportFilters = {
  from: Date;
  to: Date;
  state: string | null;
  repId: string | null;
};

type ReportUser = Awaited<ReturnType<typeof requireUser>>;

export function parseReportFilters(params: {
  from?: string;
  to?: string;
  state?: string;
  repId?: string;
}): ReportFilters {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);

  return {
    from: params.from ? new Date(params.from) : defaultFrom,
    to: params.to ? new Date(params.to) : now,
    state: params.state || null,
    repId: params.repId || null,
  };
}

function quotationScopeWhere(scope: Scope, user: ReportUser) {
  if (scope === "all") return {};
  if (scope === "territory") {
    return {
      OR: [
        { customer: { state: { in: user.territoryStates } } },
        { lead: { state: { in: user.territoryStates } } },
      ],
    };
  }
  return { createdById: user.id };
}

export async function getLeadsReport(user: ReportUser, filters: ReportFilters) {
  const scope = can(user.role, "reports", "read");
  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "assignedToId"),
    createdAt: { gte: filters.from, lte: filters.to },
  };
  if (filters.state) where.state = filters.state;
  if (filters.repId) where.assignedToId = filters.repId === "UNASSIGNED" ? null : filters.repId;

  const [byStatus, bySource, byState, leads] = await Promise.all([
    prisma.lead.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["source"], where, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["state"], where, _count: { _all: true } }),
    prisma.lead.findMany({
      where,
      select: {
        leadNumber: true,
        name: true,
        companyName: true,
        phone: true,
        state: true,
        district: true,
        source: true,
        status: true,
        estimatedValue: true,
        createdAt: true,
        assignedTo: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
  ]);

  return { byStatus, bySource, byState, leads };
}

export async function getOrdersReport(user: ReportUser, filters: ReportFilters) {
  const scope = can(user.role, "reports", "read");
  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "createdById"),
    orderedAt: { gte: filters.from, lte: filters.to },
  };
  if (filters.state) where.state = filters.state;

  const [byState, byStatus, totals, orders] = await Promise.all([
    prisma.order.groupBy({ by: ["state"], where, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.order.aggregate({ where, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.order.findMany({
      where,
      select: {
        orderNumber: true,
        state: true,
        district: true,
        status: true,
        paymentStatus: true,
        totalAmount: true,
        orderedAt: true,
        customer: { select: { name: true, customerNumber: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { orderedAt: "desc" },
      take: 1000,
    }),
  ]);

  return { byState, byStatus, totals, orders };
}

export async function getQuotationsReport(user: ReportUser, filters: ReportFilters) {
  const reportScope = can(user.role, "reports", "read");
  const where: Record<string, unknown> = {
    ...quotationScopeWhere(reportScope, user),
    createdAt: { gte: filters.from, lte: filters.to },
  };

  const [byStatus, topProducts, quotations] = await Promise.all([
    prisma.quotation.groupBy({ by: ["status"], where, _count: { _all: true }, _sum: { totalAmount: true } }),
    prisma.quotationItem.groupBy({
      by: ["productId"],
      where: { quotation: where },
      _sum: { lineTotal: true, quantity: true },
      orderBy: { _sum: { lineTotal: "desc" } },
      take: 10,
    }),
    prisma.quotation.findMany({
      where,
      select: {
        quotationNumber: true,
        status: true,
        totalAmount: true,
        createdAt: true,
        customer: { select: { name: true } },
        lead: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
  ]);

  const productIds = topProducts.map((p) => p.productId);
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p.name]));

  return {
    byStatus,
    topProducts: topProducts.map((p) => ({
      productName: productMap.get(p.productId) ?? "Unknown",
      totalValue: Number(p._sum.lineTotal ?? 0),
      totalQuantity: Number(p._sum.quantity ?? 0),
    })),
    quotations,
  };
}

export async function getRepLeaderboard(user: ReportUser, filters: ReportFilters) {
  const scope = can(user.role, "reports", "read");
  if (scope !== "all" && scope !== "territory") return [];

  const where: Record<string, unknown> = { createdAt: { gte: filters.from, lte: filters.to } };
  if (scope === "territory") where.state = { in: user.territoryStates };
  if (filters.state) where.state = filters.state;

  const grouped = await prisma.lead.groupBy({
    by: ["assignedToId"],
    where,
    _count: { _all: true },
  });
  const won = await prisma.lead.groupBy({
    by: ["assignedToId"],
    where: { ...where, status: "WON" },
    _count: { _all: true },
  });
  const wonMap = new Map(won.map((w) => [w.assignedToId, w._count._all]));

  const repIds = grouped.map((g) => g.assignedToId).filter((id): id is string => Boolean(id));
  const reps = repIds.length
    ? await prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true } })
    : [];
  const repMap = new Map(reps.map((r) => [r.id, r.name]));

  return grouped
    .filter((g) => g.assignedToId)
    .map((g) => ({
      repId: g.assignedToId as string,
      repName: repMap.get(g.assignedToId as string) ?? "Unknown",
      totalLeads: g._count._all,
      wonLeads: wonMap.get(g.assignedToId) ?? 0,
    }))
    .sort((a, b) => b.wonLeads - a.wonLeads);
}
