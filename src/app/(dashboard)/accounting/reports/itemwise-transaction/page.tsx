import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { itemwiseTransactionReport } from "@/lib/accounting/transaction-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function ItemwiseTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { from, to } = await searchParams;

  const today = new Date();
  const fromDate = from ? new Date(from) : new Date(today.getFullYear(), today.getMonth(), 1);
  const toDate = to ? new Date(to) : today;

  const rows = await itemwiseTransactionReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Itemwise Transaction Report"
        subtitle="Every sale, purchase and expense line in this range — Vyapar's Item Details sheet, as its own report. Purchase lines show no HSN or tax yet (purchase invoices don't carry per-line tax)."
      />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="itemwise-transaction" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice/Txn No</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Item Code</TableHead>
                <TableHead>HSN/SAC</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Order No</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Discount %</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Tax %</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={17} className="py-8 text-center text-sm text-muted-foreground">
                    No lines in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{r.date.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{r.txnNumber}</TableCell>
                    <TableCell>{r.partyName ?? "—"}</TableCell>
                    <TableCell>{r.itemName}</TableCell>
                    <TableCell>{r.itemCode ?? "—"}</TableCell>
                    <TableCell>{r.hsnCode ?? "—"}</TableCell>
                    <TableCell>{r.category ?? "—"}</TableCell>
                    <TableCell>{r.orderNumber ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantity.toFixed(2)}</TableCell>
                    <TableCell>{r.unit ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.unitPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.discountPercent.toFixed(2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.discountAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.taxPercent ? r.taxPercent.toFixed(2) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.taxAmount)}</TableCell>
                    <TableCell>{r.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.amount)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
