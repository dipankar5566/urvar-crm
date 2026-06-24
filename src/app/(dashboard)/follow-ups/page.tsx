import Link from "next/link";
import { format, startOfDay, endOfDay } from "date-fns";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { FOLLOWUP_STATUS_LABELS } from "@/lib/constants/labels";
import { FollowUpRowActions } from "./follow-up-row-actions";

const VIEWS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "all", label: "All" },
] as const;

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view = "overdue" } = await searchParams;
  const user = await requireUser();
  const scope = can(user.role, "followups", "read");
  const showAssignee = scope === "all";

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "assignedToId"),
  };
  if (view === "overdue") {
    where.status = "PENDING";
    where.dueAt = { lt: todayStart };
  } else if (view === "today") {
    where.status = "PENDING";
    where.dueAt = { gte: todayStart, lte: todayEnd };
  } else if (view === "upcoming") {
    where.status = "PENDING";
    where.dueAt = { gt: todayEnd };
  }

  const followUps = await prisma.followUp.findMany({
    where,
    include: {
      lead: { select: { id: true, name: true, leadNumber: true } },
      assignedTo: { select: { name: true } },
    },
    orderBy: { dueAt: "asc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Follow-ups</h1>
        <p className="text-sm text-muted-foreground">
          {followUps.length} follow-up{followUps.length === 1 ? "" : "s"} in this view.
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border bg-card p-1 w-fit">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/follow-ups?view=${v.key}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              view === v.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Due At</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
              {showAssignee && <TableHead>Assigned To</TableHead>}
              <TableHead>Notes</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {followUps.length === 0 && (
              <TableRow>
                <TableCell colSpan={showAssignee ? 7 : 6} className="text-center text-muted-foreground">
                  Nothing here.
                </TableCell>
              </TableRow>
            )}
            {followUps.map((f) => {
              const overdue = f.status === "PENDING" && f.dueAt < todayStart;
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    {f.lead ? (
                      <Link href={`/leads/${f.lead.id}`} className="hover:underline">
                        {f.lead.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className={overdue ? "font-medium text-destructive" : ""}>
                    {format(f.dueAt, "d MMM yyyy, h:mm a")}
                  </TableCell>
                  <TableCell>{f.priority}</TableCell>
                  <TableCell>
                    <Badge variant={f.status === "PENDING" ? "secondary" : "outline"}>
                      {FOLLOWUP_STATUS_LABELS[f.status] ?? f.status}
                    </Badge>
                  </TableCell>
                  {showAssignee && <TableCell>{f.assignedTo.name}</TableCell>}
                  <TableCell className="max-w-48 truncate text-muted-foreground">
                    {f.notes ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {f.status === "PENDING" && <FollowUpRowActions id={f.id} />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
