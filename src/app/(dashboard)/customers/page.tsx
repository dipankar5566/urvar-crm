import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { CustomerFilters } from "./customer-filters";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { DeleteRowButton } from "@/components/delete-row-button";
import { deleteCustomer } from "./actions";
import { UploadIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CUSTOMER_TYPE_LABELS, inr } from "@/lib/constants/labels";

const DEALER_TIER_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  GOLD: "default",
  SILVER: "secondary",
  BRONZE: "outline",
};

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const scope = can(user.role, "customers", "read");
  const showRepFilter = scope === "all" || scope === "territory";
  // Delete is Super Admin only; the action re-checks, this just hides the button.
  const canDelete = can(user.role, "customers", "delete") !== "none";

  // See leads/page.tsx for why this is AND rather than a spread: scope and
  // these filters can collide on the same key (territory's `state`, own's
  // `assignedToId`), and a spread lets whichever is assigned later silently
  // win — which is how a territory restriction previously got erased by
  // `?state=AnyState`.
  const filters: Record<string, unknown> = {};
  if (params.customerType) filters.customerType = params.customerType;
  if (params.state) filters.state = params.state;
  if (params.assignedToId === "UNASSIGNED") filters.assignedToId = null;
  else if (params.assignedToId) filters.assignedToId = params.assignedToId;

  const where = {
    AND: [scopeWhere(scope, user, "assignedToId"), filters, { deletedAt: null }],
  };

  const PAGE_SIZE = 200;
  const page = Math.max(1, Number(params.page) || 1);

  const [customers, totalCount, reps] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.customer.count({ where }),
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
        title="Customers"
        subtitle={
          totalPages > 1
            ? `${totalCount} customers in your view — showing page ${page} of ${totalPages}.`
            : `${customers.length} customer${customers.length === 1 ? "" : "s"} in your view.`
        }
        action={
          (user.role === "SUPER_ADMIN" || user.role === "SALES_MANAGER") && (
            <Button variant="outline" render={<Link href="/customers/import" />}>
              <UploadIcon /> Import from Excel
            </Button>
          )
        }
      />

      <CustomerFilters reps={reps} showRepFilter={showRepFilter} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Outstanding</TableHead>
                {showRepFilter && <TableHead>Assigned To</TableHead>}
                {canDelete && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={(showRepFilter ? 6 : 5) + (canDelete ? 1 : 0)}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No customers match these filters.
                  </TableCell>
                </TableRow>
              )}
              {customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <Link
                      href={`/customers/${customer.id}`}
                      className="font-medium hover:underline"
                    >
                      {customer.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {customer.customerNumber}
                      {customer.companyName ? ` · ${customer.companyName}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {CUSTOMER_TYPE_LABELS[customer.customerType] ?? customer.customerType}
                  </TableCell>
                  <TableCell className="text-sm">
                    {customer.district}, {customer.state}
                  </TableCell>
                  <TableCell>
                    {customer.dealerTier ? (
                      <Badge variant={DEALER_TIER_VARIANT[customer.dealerTier] ?? "secondary"}>
                        {customer.dealerTier}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {inr(Number(customer.outstandingAmount))}
                  </TableCell>
                  {showRepFilter && (
                    <TableCell className="text-sm">
                      {customer.assignedTo?.name ?? (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                  )}
                  {canDelete && (
                    <TableCell className="text-right">
                      <DeleteRowButton
                        label="customer"
                        name={customer.name}
                        reference={customer.customerNumber}
                        onDelete={deleteCustomer.bind(null, customer.id)}
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
