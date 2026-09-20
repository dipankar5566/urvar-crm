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
import { CancelInvoiceButton } from "./cancel-invoice-button";
import { NewCreditNoteDialog } from "./new-credit-note-dialog";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  DRAFT: "secondary", POSTED: "default", PARTIALLY_PAID: "outline", PAID: "default", CANCELLED: "outline",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const user = await requireUser();
  const scope = can(user.role, "invoices", "read");
  // Margin reveals cost, the same reason the `purchases` module is hidden
  // from sales roles — gate the column on accounting access, not invoice
  // access, so a rep who can see their own invoice still can't see its cost.
  const canSeeMargin = can(user.role, "accounting", "read") !== "none";
  const { invoiceId } = await params;

  const invoice = await prisma.salesInvoice.findFirst({
    where: scopedWhere(scope, user, "createdById", { id: invoiceId }),
    include: {
      customer: true,
      items: { orderBy: { lineNumber: "asc" } },
      allocations: { include: { receipt: true } },
      creditNotes: { orderBy: { noteDate: "desc" } },
      createdBy: { select: { name: true } },
    },
  });
  if (!invoice) notFound();

  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const canWrite = can(user.role, "invoices", "write") !== "none";
  const paid = invoice.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const outstanding = Number(invoice.totalAmount) - paid;
  const creditableLines = invoice.items
    .filter((i) => i.quantity.greaterThan(i.quantityCredited))
    .map((i) => ({
      id: i.id,
      description: i.description,
      unit: i.unit,
      remaining: i.quantity.minus(i.quantityCredited).toFixed(2),
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={invoice.invoiceNumber}
        subtitle={`${invoice.customer.name} · ${invoice.invoiceDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[invoice.status] ?? "secondary"}>{invoice.status}</Badge>
            {canWrite && invoice.status !== "CANCELLED" && creditableLines.length > 0 && (
              <NewCreditNoteDialog invoiceId={invoice.id} lines={creditableLines} />
            )}
            {canApprove && invoice.status !== "CANCELLED" && (
              <CancelInvoiceButton invoiceId={invoice.id} />
            )}
          </div>
        }
      />

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>HSN</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  {canSeeMargin && <TableHead className="text-right">Est. Margin</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="font-mono text-xs">{item.hsnCode ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(item.quantity)} {item.unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(item.unitPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(item.taxableValue)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {invoice.isInterState
                        ? `IGST ${formatInr(item.igstAmount)}`
                        : `CGST ${formatInr(item.cgstAmount)} + SGST ${formatInr(item.sgstAmount)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatInr(item.lineTotal)}
                    </TableCell>
                    {canSeeMargin && (
                      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                        {item.estimatedCostAmount
                          ? formatInr(item.taxableValue.minus(item.estimatedCostAmount))
                          : "cost unknown"}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <Row label="Place of supply" value={invoice.placeOfSupply} />
            <Row label="Supply type" value={invoice.isInterState ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)"} />
            <Row label="Subtotal" value={formatInr(invoice.subtotal)} />
            {Number(invoice.freightAmount) > 0 && <Row label="Freight" value={formatInr(invoice.freightAmount)} />}
            {Number(invoice.discountAmount) > 0 && <Row label="Discount" value={`- ${formatInr(invoice.discountAmount)}`} />}
            {Number(invoice.cgstAmount) > 0 && <Row label="CGST" value={formatInr(invoice.cgstAmount)} />}
            {Number(invoice.sgstAmount) > 0 && <Row label="SGST" value={formatInr(invoice.sgstAmount)} />}
            {Number(invoice.igstAmount) > 0 && <Row label="IGST" value={formatInr(invoice.igstAmount)} />}
            {Number(invoice.roundOff) !== 0 && <Row label="Round off" value={formatInr(invoice.roundOff)} />}
            <div className="border-t pt-2">
              <Row label="Total" value={formatInr(invoice.totalAmount)} strong />
            </div>
            <Row label="Paid" value={formatInr(paid)} />
            <Row label="Outstanding" value={formatInr(outstanding)} strong={outstanding > 0} />
            {invoice.isOpeningItem && (
              <p className="pt-2 text-xs text-muted-foreground">
                Migrated opening balance — excluded from GST output registers.
              </p>
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
                  <TableHead>Receipt</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/receipts/${a.receiptId}`} className="font-mono text-xs underline">
                        {a.receipt.receiptNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.receipt.receiptDate.toLocaleDateString("en-IN")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(a.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {invoice.creditNotes.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3 text-sm font-semibold">Credit Notes</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Credit Note</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.creditNotes.map((cn) => (
                  <TableRow key={cn.id}>
                    <TableCell>
                      <Link href={`/credit-notes/${cn.id}`} className="font-mono text-xs underline">
                        {cn.creditNoteNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {cn.noteDate.toLocaleDateString("en-IN")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{cn.reason.replaceAll("_", " ")}</TableCell>
                    <TableCell>
                      <Badge variant={cn.cancelledAt ? "outline" : "default"}>
                        {cn.cancelledAt ? "CANCELLED" : "POSTED"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(cn.totalAmount)}</TableCell>
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
