import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopedWhere } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  DRAFT: "secondary",
  POSTED: "default",
  PARTIALLY_PAID: "outline",
  PAID: "default",
  CANCELLED: "outline",
};

export default async function InvoicesPage() {
  const user = await requireUser();
  const scope = can(user.role, "invoices", "read");

  const invoices = await prisma.salesInvoice.findMany({
    where: scopedWhere(scope, user, "createdById"),
    orderBy: { invoiceDate: "desc" },
    take: 200,
    include: { customer: { select: { name: true, customerNumber: true } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        subtitle={`${invoices.length} invoice${invoices.length === 1 ? "" : "s"}.`}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No invoices yet. Raise one from an order.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell>
                    <Link href={`/invoices/${inv.id}`} className="font-mono text-sm font-medium underline">
                      {inv.invoiceNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {inv.customer.name}
                    <span className="ml-1 text-xs text-muted-foreground">{inv.customer.customerNumber}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {inv.invoiceDate.toLocaleDateString("en-IN")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[inv.status] ?? "secondary"}>{inv.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatInr(inv.totalAmount)}
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
