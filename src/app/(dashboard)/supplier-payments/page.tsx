import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function SupplierPaymentsPage() {
  const user = await requireUser();
  assertCan(user.role, "purchases", "read");
  const canWrite = can(user.role, "purchases", "write") !== "none";

  const payments = await prisma.supplierPayment.findMany({
    orderBy: { paymentDate: "desc" },
    take: 200,
    include: { supplier: { select: { name: true, supplierCode: true } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Payments"
        subtitle={`${payments.length} payment${payments.length === 1 ? "" : "s"}.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/supplier-payments/new" />}>
              Record Payment
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payment</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No supplier payments recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link href={`/supplier-payments/${p.id}`} className="font-mono text-sm font-medium underline">
                      {p.paymentNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {p.supplier.name}
                    <span className="ml-1 text-xs text-muted-foreground">{p.supplier.supplierCode}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.paymentDate.toLocaleDateString("en-IN")}
                  </TableCell>
                  <TableCell className="text-xs">{p.method}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === "CANCELLED" ? "outline" : "default"}>{p.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
