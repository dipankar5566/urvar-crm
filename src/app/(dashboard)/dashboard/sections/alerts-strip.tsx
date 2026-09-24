import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { startOfDay, subDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { quotationScopeWhere } from "@/lib/reports";
import type { User } from "@/generated/prisma/client";
import { invoiceScopeWhere, ownerScopeWhere } from "../scope";

type Alert = { key: string; label: string; count: number; href: string };

/**
 * Things that need someone's attention, each linking to where they get fixed.
 * Only non-zero items render, and the whole strip disappears when there are
 * none. Every item is gated on the module the viewer can actually read/act on,
 * so a sales rep never sees an accounting alert and vice versa.
 */
export async function AlertsStrip({ user }: { user: User }) {
  const todayStart = startOfDay(new Date());

  const followScope = can(user.role, "followups", "read");
  const taskScope = can(user.role, "tasks", "read");
  const invoiceScope = can(user.role, "invoices", "read");
  const canApproveExpenses = can(user.role, "expenses", "approve") !== "none";
  const canManageTax = can(user.role, "gst", "write") !== "none";
  const quoteScope = can(user.role, "quotations", "read");

  const [
    overdueFollowUps,
    overdueTasks,
    overdueInvoices,
    expensesAwaiting,
    unverifiedTaxRates,
    staleQuotations,
  ] = await Promise.all([
    followScope !== "none"
      ? prisma.followUp.count({
          where: {
            AND: [
              ownerScopeWhere(followScope, user, "assignedToId"),
              { status: "PENDING", dueAt: { lt: todayStart } },
            ],
          },
        })
      : 0,
    taskScope !== "none"
      ? prisma.task.count({
          where: {
            AND: [
              ownerScopeWhere(taskScope, user, "assignedToId"),
              { status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: todayStart } },
            ],
          },
        })
      : 0,
    invoiceScope !== "none"
      ? prisma.salesInvoice.count({
          where: {
            AND: [
              invoiceScopeWhere(invoiceScope, user),
              {
                status: { in: ["POSTED", "PARTIALLY_PAID"] },
                dueDate: { lt: todayStart },
              },
            ],
          },
        })
      : 0,
    canApproveExpenses ? prisma.expense.count({ where: { status: "SUBMITTED" } }) : 0,
    canManageTax ? prisma.taxRate.count({ where: { isVerified: false } }) : 0,
    quoteScope !== "none"
      ? prisma.quotation.count({
          where: {
            AND: [
              quotationScopeWhere(quoteScope, user),
              { status: "SENT", sentAt: { lt: subDays(new Date(), 7) } },
            ],
          },
        })
      : 0,
  ]);

  const alerts: Alert[] = [
    { key: "fu", label: "overdue follow-up", count: overdueFollowUps, href: "/follow-ups" },
    { key: "task", label: "overdue task", count: overdueTasks, href: "/tasks" },
    { key: "inv", label: "overdue invoice", count: overdueInvoices, href: "/invoices" },
    {
      key: "exp",
      label: "expense awaiting approval",
      count: expensesAwaiting,
      href: "/expenses",
    },
    {
      key: "tax",
      label: "unverified tax rate blocking invoicing",
      count: unverifiedTaxRates,
      href: "/accounting/tax-rates",
    },
    {
      key: "quo",
      label: "quotation with no reply for 7+ days",
      count: staleQuotations,
      href: "/quotations",
    },
  ].filter((a) => a.count > 0);

  if (alerts.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md px-3.5 py-2.5 text-sm"
      style={{
        background: "rgba(255,167,52,0.1)",
        border: "1px solid rgba(255,167,52,0.3)",
        color: "#D9730D",
      }}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="font-semibold">Needs attention</span>
      {alerts.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="rounded-full border border-current/30 px-2.5 py-0.5 text-xs font-medium hover:bg-black/5"
        >
          {a.count} {a.label}
          {a.count === 1 ? "" : "s"}
        </Link>
      ))}
    </div>
  );
}
