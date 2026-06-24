import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { CustomerFilters } from "./customer-filters";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

  const where: Record<string, unknown> = {
    ...scopeWhere(scope, user, "assignedToId"),
  };
  if (params.customerType) where.customerType = params.customerType;
  if (params.state) where.state = params.state;
  if (params.assignedToId === "UNASSIGNED") where.assignedToId = null;
  else if (params.assignedToId) where.assignedToId = params.assignedToId;

  const [customers, reps] = await Promise.all([
    prisma.customer.findMany({
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
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            {customers.length} customer{customers.length === 1 ? "" : "s"} in your view.
          </p>
        </div>
        {(user.role === "SUPER_ADMIN" || user.role === "SALES_MANAGER") && (
          <Button variant="outline" render={<Link href="/customers/import" />}>
            <UploadIcon /> Import from Excel
          </Button>
        )}
      </div>

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
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showRepFilter ? 6 : 5}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
