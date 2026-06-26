import { startOfDay, endOfDay, format } from "date-fns";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
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
import { CALL_DIRECTION_LABELS, CALL_OUTCOME_LABELS } from "@/lib/constants/labels";
import { CallFilters } from "./call-filters";

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string; direction?: string; today?: string }>;
}) {
  const { outcome, direction, today } = await searchParams;
  const user = await requireUser();
  const scope = can(user.role, "calls", "read");
  const showRep = scope === "all";

  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "userId"),
  };
  if (outcome) where.outcome = outcome;
  if (direction) where.direction = direction;
  if (today === "1") {
    where.calledAt = { gte: startOfDay(new Date()), lte: endOfDay(new Date()) };
  }

  const calls = await prisma.call.findMany({
    where,
    include: {
      lead: { select: { id: true, name: true, leadNumber: true } },
      user: { select: { name: true } },
    },
    orderBy: { calledAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        subtitle={`${calls.length} call${calls.length === 1 ? "" : "s"} logged.`}
      />

      <CallFilters />

      <Card>
        <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Recording</TableHead>
              <TableHead>Notes</TableHead>
              {showRep && <TableHead>Rep</TableHead>}
              <TableHead>Called At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length === 0 && (
              <TableRow>
                <TableCell colSpan={showRep ? 8 : 7} className="text-center text-muted-foreground">
                  No calls logged yet.
                </TableCell>
              </TableRow>
            )}
            {calls.map((call) => (
              <TableRow key={call.id}>
                <TableCell>
                  {call.lead ? (
                    <Link href={`/leads/${call.lead.id}`} className="hover:underline">
                      {call.lead.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{CALL_DIRECTION_LABELS[call.direction] ?? call.direction}</TableCell>
                <TableCell>
                  {call.outcome ? (
                    <Badge variant="secondary">
                      {CALL_OUTCOME_LABELS[call.outcome] ?? call.outcome}
                    </Badge>
                  ) : (
                    <Badge variant="outline">In progress</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {call.durationSeconds ? `${call.durationSeconds}s` : "—"}
                </TableCell>
                <TableCell>
                  {call.recordingUrl?.startsWith("/api/voice/recordings/") ? (
                    <audio controls preload="none" src={call.recordingUrl} className="h-8" />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-60 truncate text-muted-foreground">
                  {call.notes ?? "—"}
                </TableCell>
                {showRep && <TableCell>{call.user.name}</TableCell>}
                <TableCell className="text-muted-foreground">
                  {format(call.calledAt, "d MMM yyyy, h:mm a")}
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
