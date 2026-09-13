import Link from "next/link";
import { format } from "date-fns";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
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
import { PageHeader } from "@/components/layout/page-header";
import { CheckInDialog, type VisitTarget } from "./check-in-dialog";
import { CheckOutButton } from "./check-out-button";

/** "1h 20m" / "45m" — a visit's length at a glance. */
function formatDuration(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default async function FieldVisitsPage() {
  const user = await requireUser();
  const scope = can(user.role, "field_visits", "read");

  if (scope === "none") {
    return (
      <div className="space-y-6">
        <PageHeader title="Field Visits" />
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            You don&apos;t have access to field visits.
          </CardContent>
        </Card>
      </div>
    );
  }

  const leadScope = can(user.role, "leads", "read");
  const customerScope = can(user.role, "customers", "read");

  const [openVisit, visits, leads, customers] = await Promise.all([
    // The rep's own open visit, regardless of how wide their read scope is:
    // a manager viewing everyone's visits still only checks out of their own.
    prisma.fieldVisit.findFirst({
      where: { userId: user.id, checkOutAt: null },
      include: {
        lead: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
      },
    }),
    prisma.fieldVisit.findMany({
      // AND rather than a spread: scopeWhere writes `userId` for an "own"
      // scope, and a sibling key of the same name would silently replace the
      // restriction instead of narrowing it (see CLAUDE.md).
      where: { AND: [scopeWhere(scope, user, "userId"), { checkOutAt: { not: null } }] },
      include: {
        lead: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
        user: { select: { name: true } },
        files: { select: { id: true } },
      },
      orderBy: { checkInAt: "desc" },
      take: 100,
    }),
    leadScope === "none"
      ? []
      : prisma.lead.findMany({
          where: scopeWhere(leadScope, user, "assignedToId"),
          select: { id: true, name: true, leadNumber: true, district: true, state: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
    customerScope === "none"
      ? []
      : prisma.customer.findMany({
          where: scopeWhere(customerScope, user, "assignedToId"),
          select: { id: true, name: true, customerNumber: true, district: true, state: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
  ]);

  const targets: VisitTarget[] = [
    ...customers.map((c) => ({
      id: c.id,
      name: c.name,
      kind: "customer" as const,
      reference: c.customerNumber,
      location: `${c.district}, ${c.state}`,
    })),
    ...leads.map((l) => ({
      id: l.id,
      name: l.name,
      kind: "lead" as const,
      reference: l.leadNumber,
      location: `${l.district}, ${l.state}`,
    })),
  ];

  const canWrite = can(user.role, "field_visits", "write") !== "none";
  const showRep = scope === "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Field Visits"
        subtitle="Check in when you arrive, check out when you leave."
        action={canWrite && !openVisit ? <CheckInDialog targets={targets} /> : undefined}
      />

      {openVisit && (
        <Card className="border-primary">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div>
              <div className="flex items-center gap-2">
                <Badge>In progress</Badge>
                <span className="font-medium">
                  {openVisit.lead?.name ?? openVisit.customer?.name ?? "Unknown"}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Since {format(openVisit.checkInAt, "d MMM yyyy, h:mm a")}
              </p>
            </div>
            <CheckOutButton visitId={openVisit.id} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Visited</TableHead>
                <TableHead>Checked In</TableHead>
                <TableHead>Duration</TableHead>
                {showRep && <TableHead>Rep</TableHead>}
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Photo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visits.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showRep ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    No completed visits yet.
                  </TableCell>
                </TableRow>
              )}
              {visits.map((v) => {
                const href = v.lead
                  ? `/leads/${v.lead.id}`
                  : v.customer
                    ? `/customers/${v.customer.id}`
                    : null;
                const name = v.lead?.name ?? v.customer?.name ?? "—";
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      {href ? (
                        <Link href={href} className="hover:underline">
                          {name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{name}</span>
                      )}
                    </TableCell>
                    <TableCell>{format(v.checkInAt, "d MMM yyyy, h:mm a")}</TableCell>
                    <TableCell>
                      {v.checkOutAt ? formatDuration(v.checkInAt, v.checkOutAt) : "—"}
                    </TableCell>
                    {showRep && <TableCell>{v.user.name}</TableCell>}
                    <TableCell className="max-w-48 truncate text-muted-foreground">
                      {v.notes ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {v.files.length > 0 ? (
                        <a
                          href={`/api/documents/${v.files[0].id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm hover:underline"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
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
