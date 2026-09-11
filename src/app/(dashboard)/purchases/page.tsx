import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
export default async function PurchasesPage() {
  const user = await requireUser();
  assertCan(user.role, "purchases", "read");
  const canWrite = can(user.role, "purchases", "write") !== "none";

  const invoices = await prisma.purchaseInvoice.findMany({
    orderBy: { invoiceDate: "desc" },
    take: 200,
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      totalAmount: true,
      supplier: { select: { name: true, supplierCode: true } },
      _count: { select: { items: true } },
    },
  });

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
            {invoices.length} invoice{invoices.length === 1 ? "" : "s"}
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
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-medium">{invoice.invoiceNumber}</TableCell>
                      <TableCell>
                        {invoice.supplier.name}
                        <span className="block text-xs text-muted-foreground">
                          {invoice.supplier.supplierCode}
                        </span>
                      </TableCell>
                      <TableCell>{invoice.invoiceDate.toLocaleDateString("en-IN")}</TableCell>
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
    </div>
  );
}
