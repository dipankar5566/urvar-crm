import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CancelCreditNoteButton } from "./cancel-credit-note-button";

export const dynamic = "force-dynamic";

export default async function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ creditNoteId: string }>;
}) {
  const user = await requireUser();
  can(user.role, "invoices", "read");
  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const { creditNoteId } = await params;

  const creditNote = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: {
      customer: true,
      invoice: { select: { id: true, invoiceNumber: true } },
      items: true,
      createdBy: { select: { name: true } },
    },
  });
  if (!creditNote) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={creditNote.creditNoteNumber}
        subtitle={`${creditNote.customer.name} · ${creditNote.noteDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={creditNote.cancelledAt ? "outline" : "default"}>
              {creditNote.cancelledAt ? "CANCELLED" : "POSTED"}
            </Badge>
            {canApprove && !creditNote.cancelledAt && <CancelCreditNoteButton creditNoteId={creditNote.id} />}
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
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditNote.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(item.quantity)} {item.unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(item.taxableValue)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {creditNote.isInterState
                        ? `IGST ${formatInr(item.igstAmount)}`
                        : `CGST ${formatInr(item.cgstAmount)} + SGST ${formatInr(item.sgstAmount)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatInr(item.lineTotal)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <Row label="Reason" value={creditNote.reason.replaceAll("_", " ")} />
            {creditNote.invoice && (
              <Row
                label="Against invoice"
                value={
                  <Link href={`/invoices/${creditNote.invoice.id}`} className="underline">
                    {creditNote.invoice.invoiceNumber}
                  </Link>
                }
              />
            )}
            <Row label="Subtotal" value={formatInr(creditNote.subtotal)} />
            {Number(creditNote.cgstAmount) > 0 && <Row label="CGST" value={formatInr(creditNote.cgstAmount)} />}
            {Number(creditNote.sgstAmount) > 0 && <Row label="SGST" value={formatInr(creditNote.sgstAmount)} />}
            {Number(creditNote.igstAmount) > 0 && <Row label="IGST" value={formatInr(creditNote.igstAmount)} />}
            {Number(creditNote.roundOff) !== 0 && <Row label="Round off" value={formatInr(creditNote.roundOff)} />}
            <div className="border-t pt-2">
              <Row label="Total" value={formatInr(creditNote.totalAmount)} strong />
            </div>
            <Row label="Created by" value={creditNote.createdBy.name} />
            {creditNote.narration && (
              <div className="pt-2 text-xs text-muted-foreground">{creditNote.narration}</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string | React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-semibold" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className={strong ? "text-foreground" : ""}>{value}</span>
    </div>
  );
}
