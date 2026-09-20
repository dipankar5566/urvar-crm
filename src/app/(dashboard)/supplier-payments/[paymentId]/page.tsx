import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CancelSupplierPaymentButton } from "./cancel-supplier-payment-button";

export const dynamic = "force-dynamic";

export default async function SupplierPaymentDetailPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "purchases", "read");
  const { paymentId } = await params;

  const payment = await prisma.supplierPayment.findUnique({
    where: { id: paymentId },
    include: {
      supplier: { select: { name: true, supplierCode: true } },
      paymentAccount: { select: { code: true, name: true } },
      allocations: { include: { invoice: { select: { invoiceNumber: true, totalAmount: true } } } },
    },
  });
  if (!payment) notFound();

  const canApprove = can(user.role, "purchases", "approve") !== "none";
  const allocated = payment.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const advance = Number(payment.amount) - allocated;

  return (
    <div className="space-y-6">
      <PageHeader
        title={payment.paymentNumber}
        subtitle={`${payment.supplier.name} · ${payment.paymentDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={payment.status === "CANCELLED" ? "outline" : "default"}>{payment.status}</Badge>
            {canApprove && payment.status !== "CANCELLED" && (
              <CancelSupplierPaymentButton paymentId={payment.id} />
            )}
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <Row label="Amount paid" value={formatInr(payment.amount)} strong />
          <Row label="Method" value={payment.method} />
          {payment.reference && <Row label="Reference" value={payment.reference} />}
          <Row label="Paid from" value={`${payment.paymentAccount.code} ${payment.paymentAccount.name}`} />
          <Row label="Allocated to invoices" value={formatInr(allocated)} />
          <Row label="On-account advance" value={formatInr(advance)} />
        </CardContent>
      </Card>

      {payment.allocations.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3 text-sm font-semibold">Allocated invoices</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead className="text-right">Invoice Total</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payment.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/purchases/${a.invoiceId}`} className="font-mono text-xs underline">
                        {a.invoice.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(a.invoice.totalAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(a.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-semibold" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className={strong ? "text-foreground" : ""}>{value}</span>
    </div>
  );
}
