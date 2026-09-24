import { endOfDay, startOfDay } from "date-fns";
import { prisma } from "@/lib/prisma";
import { can, scopedWhere } from "@/lib/permissions";
import { quotationScopeWhere } from "@/lib/reports";
import type { User } from "@/generated/prisma/client";
import { ownerScopeWhere } from "../scope";
import { SectionTitle, StatCard } from "./ui";

/**
 * Fixed to today, independent of the period selector. Every count is scoped to
 * what the viewer's role may read — the previous dashboard counted calls,
 * follow-ups and quotations company-wide for every role.
 */
export async function TodayStrip({ user }: { user: User }) {
  const today = { gte: startOfDay(new Date()), lte: endOfDay(new Date()) };

  const leadScope = can(user.role, "leads", "read");
  const callScope = can(user.role, "calls", "read");
  const followScope = can(user.role, "followups", "read");
  const quoteScope = can(user.role, "quotations", "read");
  const visitScope = can(user.role, "field_visits", "read");

  const [newLeads, callsByMode, followupsDue, quotationsSent, openVisits] =
    await Promise.all([
      leadScope !== "none"
        ? prisma.lead.count({
            where: scopedWhere(leadScope, user, "assignedToId", {
              createdAt: today,
              deletedAt: null,
            }),
          })
        : null,
      callScope !== "none"
        ? prisma.call.groupBy({
            by: ["callMode"],
            where: {
              AND: [ownerScopeWhere(callScope, user, "userId"), { calledAt: today }],
            },
            _count: { _all: true },
          })
        : null,
      followScope !== "none"
        ? prisma.followUp.count({
            where: {
              AND: [
                ownerScopeWhere(followScope, user, "assignedToId"),
                { status: "PENDING", dueAt: today },
              ],
            },
          })
        : null,
      quoteScope !== "none"
        ? prisma.quotation.count({
            where: { AND: [quotationScopeWhere(quoteScope, user), { sentAt: today }] },
          })
        : null,
      visitScope !== "none"
        ? prisma.fieldVisit.count({
            where: {
              AND: [ownerScopeWhere(visitScope, user, "userId"), { checkOutAt: null }],
            },
          })
        : null,
    ]);

  const cards: React.ReactNode[] = [];

  if (newLeads !== null) {
    cards.push(<StatCard key="leads" label="New Leads" value={newLeads} href="/leads" />);
  }
  if (callsByMode !== null) {
    const total = callsByMode.reduce((n, r) => n + r._count._all, 0);
    const ai = callsByMode
      .filter((r) => r.callMode !== "HUMAN")
      .reduce((n, r) => n + r._count._all, 0);
    cards.push(
      <StatCard
        key="calls"
        label="Calls Logged"
        value={total}
        hint={`${total - ai} human · ${ai} AI`}
        href="/calls"
      />,
    );
  }
  if (followupsDue !== null) {
    cards.push(
      <StatCard key="fu" label="Follow-ups Due" value={followupsDue} href="/follow-ups" />,
    );
  }
  if (quotationsSent !== null) {
    cards.push(
      <StatCard key="q" label="Quotations Sent" value={quotationsSent} href="/quotations" />,
    );
  }
  if (openVisits !== null) {
    cards.push(
      <StatCard
        key="visits"
        label="Reps in the Field"
        value={openVisits}
        hint="open check-ins"
        href="/field-visits"
      />,
    );
  }

  if (cards.length === 0) return null;

  return (
    <section>
      <SectionTitle>Today</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">{cards}</div>
    </section>
  );
}
