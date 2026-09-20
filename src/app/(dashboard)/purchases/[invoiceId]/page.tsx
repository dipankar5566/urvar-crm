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
import { PostInvoiceButton } from "./post-invoice-button";
import { CancelPurchaseInvoiceButton } from "./cancel-purchase-invoice-button";
import { SetSupplierStateForm } from "./set-supplier-state-form";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  DRAFT: "secondary", POSTED: "default", PARTIALLY_PAID: "outline", PAID: "default", CANCELLED: "outline",
};

export default async function PurchaseInvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "purchases", "read");
  const canWrite = can(user.role, "purchases", "write") !== "none";
  const canApprove = can(user.role, "purchases", "approve") !== "none";
  const { invoiceId } = await params;

  const invoice = await prisma.purchaseInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      supplier: true,
      items: true,
      allocations: { include: { payment: true } },
    },
  });
  if (!invoice) notFound();

  const paid = invoice.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const outstanding = Number(invoice.totalAmount) - paid;

  return (
    <div className="space-y-6">
      <PageHeader
        title={invoice.invoiceNumber}
        subtitle={`${invoice.supplier.name} · ${invoice.invoiceDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[invoice.status] ?? "secondary"}>{invoice.status}</Badge>
            {canWrite && invoice.status === "DRAFT" && invoice.supplier.state && (
              <PostInvoiceButton invoiceId={invoice.id} />
            )}
            {canApprove && (invoice.status === "POSTED" || invoice.status === "PARTIALLY_PAID") && (
              <CancelPurchaseInvoiceButton invoiceId={invoice.id} />
            )}
          </div>
        }
      />

      {invoice.status === "DRAFT" && !invoice.supplier.state && canWrite && (
        <Card className="border-destructive">
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-medium text-destructive">
              {invoice.supplier.name} has no state on file.
            </p>
            <p className="text-sm text-muted-foreground">
              Posting decides CGST+SGST vs IGST from the supplier&apos;s state, and that is never
              guessed. Set it once here — every future invoice from this supplier reuses it.
            </p>
            <SetSupplierStateForm supplierId={invoice.supplierId} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(item.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(item.unitPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatInr(item.lineTotal)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <Row label="Subtotal" value={formatInr(invoice.subtotal)} />
            <Row label="Tax" value={formatInr(invoice.taxAmount)} />
            {invoice.status !== "DRAFT" && (
              <>
                <Row label="Supply type" value={invoice.isInterState ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)"} />
                {Number(invoice.cgstAmount) > 0 && <Row label="CGST" value={formatInr(invoice.cgstAmount)} />}
                {Number(invoice.sgstAmount) > 0 && <Row label="SGST" value={formatInr(invoice.sgstAmount)} />}
                {Number(invoice.igstAmount) > 0 && <Row label="IGST" value={formatInr(invoice.igstAmount)} />}
              </>
            )}
            <div className="border-t pt-2">
              <Row label="Total" value={formatInr(invoice.totalAmount)} strong />
            </div>
            {invoice.status !== "DRAFT" && invoice.status !== "CANCELLED" && (
              <>
                <Row label="Paid" value={formatInr(paid)} />
                <Row label="Outstanding" value={formatInr(outstanding)} strong={outstanding > 0} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {invoice.allocations.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3 text-sm font-semibold">Payments</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">{a.payment.paymentNumber}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.payment.paymentDate.toLocaleDateString("en-IN")}
                    </TableCell>
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
