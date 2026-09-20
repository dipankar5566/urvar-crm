import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopedWhere } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  POSTED: "default",
  CANCELLED: "outline",
};

export default async function ReceiptsPage() {
  const user = await requireUser();
  const scope = can(user.role, "payments", "read");
  const canWrite = can(user.role, "payments", "write") !== "none" || can(user.role, "accounting", "write") !== "none";

  const receipts = await prisma.receipt.findMany({
    where: scopedWhere(scope, user, "createdById"),
    orderBy: { receiptDate: "desc" },
    take: 200,
    include: { customer: { select: { name: true, customerNumber: true } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receipts"
        subtitle={`${receipts.length} receipt${receipts.length === 1 ? "" : "s"}.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/receipts/new" />}>
              Record Receipt
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No receipts recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {receipts.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/receipts/${r.id}`} className="font-mono text-sm font-medium underline">
                      {r.receiptNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {r.customer.name}
                    <span className="ml-1 text-xs text-muted-foreground">{r.customer.customerNumber}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.receiptDate.toLocaleDateString("en-IN")}
                  </TableCell>
                  <TableCell className="text-xs">{r.method}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? "secondary"}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(r.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
