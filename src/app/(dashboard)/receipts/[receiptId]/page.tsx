import Link from "next/link";
import { notFound } from "next/navigation";
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
import { CancelReceiptButton } from "./cancel-receipt-button";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ receiptId: string }>;
}) {
  const user = await requireUser();
  const scope = can(user.role, "payments", "read");
  const { receiptId } = await params;

  const receipt = await prisma.receipt.findFirst({
    where: scopedWhere(scope, user, "createdById", { id: receiptId }),
    include: {
      customer: { select: { name: true, customerNumber: true } },
      depositAccount: { select: { code: true, name: true } },
      allocations: { include: { invoice: { select: { invoiceNumber: true, totalAmount: true } } } },
      createdBy: { select: { name: true } },
    },
  });
  if (!receipt) notFound();

  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const allocated = receipt.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const advance = Number(receipt.amount) - allocated;

  return (
    <div className="space-y-6">
      <PageHeader
        title={receipt.receiptNumber}
        subtitle={`${receipt.customer.name} · ${receipt.receiptDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={receipt.status === "CANCELLED" ? "outline" : "default"}>{receipt.status}</Badge>
            {canApprove && receipt.status !== "CANCELLED" && <CancelReceiptButton receiptId={receipt.id} />}
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <Row label="Amount received" value={formatInr(receipt.amount)} strong />
          <Row label="Method" value={receipt.method} />
          {receipt.reference && <Row label="Reference" value={receipt.reference} />}
          <Row label="Deposited to" value={`${receipt.depositAccount.code} ${receipt.depositAccount.name}`} />
          <Row label="Allocated to invoices" value={formatInr(allocated)} />
          <Row label="On-account advance" value={formatInr(advance)} />
        </CardContent>
      </Card>

      {receipt.allocations.length > 0 && (
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
                {receipt.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/invoices/${a.invoiceId}`} className="font-mono text-xs underline">
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
