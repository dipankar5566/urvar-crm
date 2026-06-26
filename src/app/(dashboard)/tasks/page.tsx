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
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { TASK_PRIORITY_LABELS } from "@/lib/constants/labels";
import { TaskForm } from "./task-form";
import { TaskStatusSelect } from "./task-status-select";

const VIEWS = [
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due Today" },
  { key: "upcoming", label: "Upcoming" },
] as const;

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view = "all" } = await searchParams;
  const user = await requireUser();
  const scope = can(user.role, "tasks", "read");
  const canAssign = can(user.role, "tasks", "write") === "all";
  const showAssignee = scope === "all";

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "assignedToId"),
  };
  const openStatuses = { notIn: ["DONE", "CANCELLED"] };
  if (view === "overdue") {
    where.status = openStatuses;
    where.dueAt = { lt: todayStart };
  } else if (view === "today") {
    where.status = openStatuses;
    where.dueAt = { gte: todayStart, lte: todayEnd };
  } else if (view === "upcoming") {
    where.status = openStatuses;
    where.dueAt = { gt: todayEnd };
  }

  const tasks = await prisma.task.findMany({
    where,
    include: {
      assignedTo: { select: { name: true } },
      relatedLead: { select: { id: true, name: true } },
    },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }],
    take: 200,
  });

  const reps = canAssign
    ? await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  const writeAccess = can(user.role, "tasks", "write") !== "none";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        subtitle={`${tasks.length} task${tasks.length === 1 ? "" : "s"} in this view.`}
        action={
          writeAccess && (
            <TaskForm reps={reps} canAssign={canAssign} currentUserId={user.id} />
          )
        }
      />

      <div className="flex gap-1 rounded-lg border bg-card p-1 w-fit">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/tasks?view=${v.key}`}
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

      <Card>
        <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Related Lead</TableHead>
              <TableHead>Priority</TableHead>
              {showAssignee && <TableHead>Assigned To</TableHead>}
              <TableHead>Due At</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={showAssignee ? 6 : 5} className="text-center text-muted-foreground">
                  Nothing here.
                </TableCell>
              </TableRow>
            )}
            {tasks.map((t) => {
              const overdue =
                !["DONE", "CANCELLED"].includes(t.status) &&
                t.dueAt &&
                t.dueAt < todayStart;
              return (
                <TableRow key={t.id}>
                  <TableCell>
                    <p className="font-medium">{t.title}</p>
                    {t.description && (
                      <p className="max-w-60 truncate text-xs text-muted-foreground">
                        {t.description}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.relatedLead ? (
                      <Link href={`/leads/${t.relatedLead.id}`} className="hover:underline">
                        {t.relatedLead.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{TASK_PRIORITY_LABELS[t.priority] ?? t.priority}</Badge>
                  </TableCell>
                  {showAssignee && <TableCell>{t.assignedTo.name}</TableCell>}
                  <TableCell className={overdue ? "font-medium text-destructive" : ""}>
                    {t.dueAt ? format(t.dueAt, "d MMM yyyy, h:mm a") : "—"}
                  </TableCell>
                  <TableCell>
                    {writeAccess ? (
                      <TaskStatusSelect taskId={t.id} status={t.status} />
                    ) : (
                      <Badge variant="secondary">{t.status}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </CardContent>
      </Card>
    </div>
  );
}
