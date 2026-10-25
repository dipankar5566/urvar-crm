import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { saleReport } from "@/lib/accounting/transaction-reports";
import { formatInr, money } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function SaleReportPage({
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

  const { bankColumns, rows, totals } = await saleReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Sale Report" subtitle="Every sales invoice in this range, with how much has been received and through which bank." />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="sale-report" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Order No</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead>Party Name</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Balance Due</TableHead>
                {bankColumns.map((b) => (
                  <TableHead key={b.bankAccountId} className="text-right">{b.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11 + bankColumns.length} className="py-8 text-center text-sm text-muted-foreground">
                    No sales invoices in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.invoiceId}>
                    <TableCell>{r.date.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{r.orderNumber ?? "—"}</TableCell>
                    <TableCell>{r.invoiceNumber}</TableCell>
                    <TableCell>{r.partyName}</TableCell>
                    <TableCell>{r.gstin ?? "—"}</TableCell>
                    <TableCell>{r.partyPhone}</TableCell>
                    <TableCell>{r.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.totalAmount)}</TableCell>
                    <TableCell>{r.paymentType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.receivedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.balanceDue)}</TableCell>
                    {bankColumns.map((b) => (
                      <TableCell key={b.bankAccountId} className="text-right tabular-nums">
                        {formatInr(r.byBank.get(b.bankAccountId) ?? money(0))}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {rows.length > 0 && (
            <div className="flex justify-end gap-6 border-t px-4 py-3 text-sm">
              <span>Total: <span className="font-medium tabular-nums">{formatInr(totals.totalAmount)}</span></span>
              <span>Received: <span className="font-medium tabular-nums">{formatInr(totals.receivedAmount)}</span></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
