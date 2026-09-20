import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const inr = (value: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);

/**
 * Supplier invoices — the inbound side of the business.
 *
 * No territory scoping here, unlike leads and customers: a purchase invoice
 * has no territory, and the only roles that reach this page (SUPER_ADMIN,
 * ACCOUNTS_TEAM) both hold "all" scope. Sales roles get `purchases: NONE`
 * and never see the page or the nav entry, because supplier prices reveal
 * the margin on every deal.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "purchases", "read");
  const canWrite = can(user.role, "purchases", "write") !== "none";

  const PAGE_SIZE = 200;
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const [invoices, totalCount] = await Promise.all([
    prisma.purchaseInvoice.findMany({
      orderBy: { invoiceDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        totalAmount: true,
        status: true,
        supplier: { select: { name: true, supplierCode: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.purchaseInvoice.count(),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Purchases</h1>
          <p className="text-sm text-muted-foreground">
            Supplier invoices. Scan one and the details are read for you.
          </p>
        </div>
        {canWrite && (
          <Button size="sm" render={<Link href="/purchases/new" />}>
            <PlusIcon /> Record an invoice
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {totalPages > 1
              ? `${totalCount} invoices — page ${page} of ${totalPages}`
              : `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier invoices recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-medium">
                        <Link href={`/purchases/${invoice.id}`} className="underline">
                          {invoice.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {invoice.supplier.name}
                        <span className="block text-xs text-muted-foreground">
                          {invoice.supplier.supplierCode}
                        </span>
                      </TableCell>
                      <TableCell>{invoice.invoiceDate.toLocaleDateString("en-IN")}</TableCell>
                      <TableCell>
                        <Badge variant={invoice.status === "DRAFT" ? "secondary" : "default"}>
                          {invoice.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {invoice._count.items}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {inr(Number(invoice.totalAmount))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <PaginationControls page={page} totalPages={totalPages} />
    </div>
  );
}
