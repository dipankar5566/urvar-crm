import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import type { User } from "@/generated/prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardPeriod } from "../period";
import { ownerScopeWhere } from "../scope";
import { SectionTitle } from "./ui";

const CALL_MODE_LABELS: Record<string, string> = {
  HUMAN: "Human",
  AI_ASSISTED: "AI-assisted",
  AI_AUTONOMOUS: "AI autonomous",
};

/**
 * Who is out in the field right now, who's been visiting, and how calls split
 * between people and the AI agent for the selected period. Each half renders
 * only if the viewer can read that module (ACCOUNTS_TEAM has no field visits).
 */
export async function FieldCallingActivity({
  user,
  period,
}: {
  user: User;
  period: DashboardPeriod;
}) {
  const visitScope = can(user.role, "field_visits", "read");
  const callScope = can(user.role, "calls", "read");
  if (visitScope === "none" && callScope === "none") return null;

  const visitOwner = ownerScopeWhere(visitScope, user, "userId");
  const callOwner = ownerScopeWhere(callScope, user, "userId");

  const [openVisits, visitsByRep, callsByMode] = await Promise.all([
    visitScope !== "none"
      ? prisma.fieldVisit.findMany({
          where: { AND: [visitOwner, { checkOutAt: null }] },
          orderBy: { checkInAt: "desc" },
          take: 8,
          select: {
            id: true,
            checkInAt: true,
            user: { select: { name: true } },
            lead: { select: { name: true } },
            customer: { select: { name: true } },
          },
        })
      : [],
    visitScope !== "none"
      ? prisma.fieldVisit.groupBy({
          by: ["userId"],
          where: {
            AND: [
              visitOwner,
              { checkOutAt: { not: null }, checkInAt: { gte: period.from, lte: period.to } },
            ],
          },
          _count: { _all: true },
          orderBy: { _count: { userId: "desc" } },
          take: 5,
        })
      : [],
    callScope !== "none"
      ? prisma.call.groupBy({
          by: ["callMode"],
          where: { AND: [callOwner, { calledAt: { gte: period.from, lte: period.to } }] },
          _count: { _all: true },
        })
      : [],
  ]);

  const reps = visitsByRep.length
    ? await prisma.user.findMany({
        where: { id: { in: visitsByRep.map((v) => v.userId) } },
        select: { id: true, name: true },
      })
    : [];
  const repName = new Map(reps.map((r) => [r.id, r.name]));
  const totalCalls = callsByMode.reduce((n, r) => n + r._count._all, 0);

  return (
    <section>
      <SectionTitle>Field &amp; calling · {period.label}</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        {visitScope !== "none" && (
          <Card className="overflow-hidden p-0">
            <CardHeader className="flex flex-row items-center justify-between border-b py-3">
              <CardTitle className="text-sm">In the field now</CardTitle>
              <Link href="/field-visits" className="text-xs font-medium text-brand hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {openVisits.length === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  Nobody is checked in right now.
                </p>
              )}
              {openVisits.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{v.user.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {v.customer?.name ?? v.lead?.name ?? "—"}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDistanceToNow(v.checkInAt, { addSuffix: true })}
                  </span>
                </div>
              ))}
              {visitsByRep.length > 0 && (
                <div className="border-t bg-muted/30 px-4 py-2.5">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                    Completed visits
                  </div>
                  {visitsByRep.map((v) => (
                    <div key={v.userId} className="flex justify-between py-0.5 text-sm">
                      <span className="truncate">{repName.get(v.userId) ?? "Unknown"}</span>
                      <span className="font-semibold tabular-nums">{v._count._all}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {callScope !== "none" && (
          <Card className="overflow-hidden p-0">
            <CardHeader className="flex flex-row items-center justify-between border-b py-3">
              <CardTitle className="text-sm">Calls by mode</CardTitle>
              <Link href="/calls" className="text-xs font-medium text-brand hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {totalCalls === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  No calls logged in this period.
                </p>
              )}
              {callsByMode.map((r) => (
                <div
                  key={r.callMode}
                  className="flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-b-0"
                >
                  <span>{CALL_MODE_LABELS[r.callMode] ?? r.callMode}</span>
                  <span className="font-semibold tabular-nums">{r._count._all}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
