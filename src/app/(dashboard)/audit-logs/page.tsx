import { requireRole } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AuditLogFilters } from "./audit-log-filters";

const ENTITY_TYPES = ["Lead", "Customer", "Product", "Quotation", "Call", "FollowUp", "Task", "User"];
const ACTIONS = [
  "CREATE",
  "UPDATE",
  "STATUS_CHANGE",
  "STAGE_CHANGE",
  "CONVERT",
  "COMPLETE",
  "CANCEL",
  "RESCHEDULE",
  "ACTIVATE",
  "DEACTIVATE",
];

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["SUPER_ADMIN"]);
  const params = await searchParams;

  const where: Record<string, unknown> = {};
  if (params.entityType) where.entityType = params.entityType;
  if (params.action) where.action = params.action;
  if (params.userId) where.userId = params.userId;

  const [logs, users] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          System-wide audit trail of every mutating action. Showing the most recent {logs.length}.
        </p>
      </div>

      <AuditLogFilters entityTypes={ENTITY_TYPES} actions={ACTIONS} users={users} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No audit log entries match these filters.
                  </TableCell>
                </TableRow>
              )}
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {log.createdAt.toLocaleString("en-IN")}
                  </TableCell>
                  <TableCell className="text-sm">{log.user?.name ?? "System"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{log.action}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {log.entityType}
                    <div className="font-mono text-xs text-muted-foreground">
                      {log.entityId}
                    </div>
                  </TableCell>
                  <TableCell>
                    {(log.oldValue || log.newValue) ? (
                      <details>
                        <summary className="cursor-pointer text-sm text-muted-foreground">
                          View
                        </summary>
                        <div className="mt-2 grid gap-2 text-xs">
                          {log.oldValue ? (
                            <div>
                              <div className="font-medium text-muted-foreground">Before</div>
                              <pre className="overflow-x-auto rounded bg-muted p-2">
                                {JSON.stringify(log.oldValue, null, 2)}
                              </pre>
                            </div>
                          ) : null}
                          {log.newValue ? (
                            <div>
                              <div className="font-medium text-muted-foreground">After</div>
                              <pre className="overflow-x-auto rounded bg-muted p-2">
                                {JSON.stringify(log.newValue, null, 2)}
                              </pre>
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
