import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { LeadFilters } from "./lead-filters";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { initialsOf, colorFor } from "@/lib/avatar";
import { UploadIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LEAD_SOURCE_LABELS,
  CUSTOMER_TYPE_LABELS,
  inr,
} from "@/lib/constants/labels";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const scope = can(user.role, "leads", "read");
  const showRepFilter = scope === "all" || scope === "territory";

  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "assignedToId"),
  };
  if (params.status) where.status = params.status;
  if (params.source) where.source = params.source;
  if (params.state) where.state = params.state;
  if (params.assignedToId === "UNASSIGNED") where.assignedToId = null;
  else if (params.assignedToId) where.assignedToId = params.assignedToId;

  const [leads, reps] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    showRepFilter
      ? prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {leads.length} lead{leads.length === 1 ? "" : "s"} in your view.
          </p>
        </div>
        {(user.role === "SUPER_ADMIN" || user.role === "SALES_MANAGER") && (
          <Button variant="outline" render={<Link href="/leads/import" />}>
            <UploadIcon /> Import from Excel
          </Button>
        )}
      </div>

      <LeadFilters reps={reps} showRepFilter={showRepFilter} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Est. Value</TableHead>
                {showRepFilter && <TableHead>Assigned To</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showRepFilter ? 7 : 6}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              )}
              {leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                        style={{ background: colorFor(lead.name) }}
                      >
                        {initialsOf(lead.name)}
                      </div>
                      <div className="min-w-0">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="font-medium hover:underline"
                        >
                          {lead.name}
                        </Link>
                        <div className="text-xs text-tertiary-foreground">
                          {lead.leadNumber}
                          {lead.companyName ? ` · ${lead.companyName}` : ""}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {CUSTOMER_TYPE_LABELS[lead.customerType] ?? lead.customerType}
                  </TableCell>
                  <TableCell className="text-sm">
                    {lead.district}, {lead.state}
                  </TableCell>
                  <TableCell className="text-sm">
                    {LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={lead.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {inr(lead.estimatedValue ? Number(lead.estimatedValue) : null)}
                  </TableCell>
                  {showRepFilter && (
                    <TableCell className="text-sm">
                      {lead.assignedTo?.name ?? (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
