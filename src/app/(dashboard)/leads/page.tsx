import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { LeadFilters } from "./lead-filters";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { DeleteRowButton } from "@/components/delete-row-button";
import { deleteLead } from "./actions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
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
  // Delete is Super Admin only; the action re-checks, this just hides the button.
  const canDelete = can(user.role, "leads", "delete") !== "none";

  // Kept as a separate AND branch rather than spread into one object: scope
  // and these filters can target the same key (a territory scope's `state`,
  // an own scope's `assignedToId`), and spreading them together lets the
  // later key silently win — a plain `where.state = params.state` after the
  // spread erased a DISTRIBUTOR_MANAGER's territory restriction entirely, so
  // `?state=AnyState` returned other territories' leads. AND keeps both
  // conditions in force; if they conflict the query returns nothing rather
  // than the wrong rows.
  const filters: Record<string, unknown> = {};
  if (params.status) filters.status = params.status;
  if (params.source) filters.source = params.source;
  if (params.state) filters.state = params.state;
  if (params.assignedToId === "UNASSIGNED") filters.assignedToId = null;
  else if (params.assignedToId) filters.assignedToId = params.assignedToId;

  const where = {
    AND: [scopeWhere(scope, user, "assignedToId"), filters, { deletedAt: null }],
  };

  const PAGE_SIZE = 200;
  const page = Math.max(1, Number(params.page) || 1);

  const [leads, totalCount, reps] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.lead.count({ where }),
    showRepFilter
      ? prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle={
          totalPages > 1
            ? `${totalCount} leads in your view — showing page ${page} of ${totalPages}.`
            : `${leads.length} lead${leads.length === 1 ? "" : "s"} in your view.`
        }
        action={
          (user.role === "SUPER_ADMIN" || user.role === "SALES_MANAGER") && (
            <Button variant="outline" render={<Link href="/leads/import" />}>
              <UploadIcon /> Import from Excel
            </Button>
          )
        }
      />

      <div className="flex border-b">
        <span className="-mb-px border-b-2 border-brand px-3 py-1.5 text-[13px] font-medium text-foreground">
          Table
        </span>
        <Link
          href="/pipeline"
          className="px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          Board
        </Link>
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
                {canDelete && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={(showRepFilter ? 7 : 6) + (canDelete ? 1 : 0)}
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
                  {canDelete && (
                    <TableCell className="text-right">
                      <DeleteRowButton
                        label="lead"
                        name={lead.name}
                        reference={lead.leadNumber}
                        onDelete={deleteLead.bind(null, lead.id)}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PaginationControls page={page} totalPages={totalPages} />
    </div>
  );
}
