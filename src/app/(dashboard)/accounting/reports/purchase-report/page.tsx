import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { purchaseReport } from "@/lib/accounting/transaction-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function PurchaseReportPage({
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

  const { rows, totals } = await purchaseReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Purchase Report" subtitle="Every posted purchase invoice in this range, with how much has been paid." />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead>Party Name</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    No purchase invoices in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.invoiceId}>
                    <TableCell>{r.date.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{r.invoiceNumber}</TableCell>
                    <TableCell>{r.partyName}</TableCell>
                    <TableCell>{r.gstin ?? "—"}</TableCell>
                    <TableCell>{r.partyPhone ?? "—"}</TableCell>
                    <TableCell>{r.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.totalAmount)}</TableCell>
                    <TableCell>{r.paymentType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.paidAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.balanceDue)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {rows.length > 0 && (
            <div className="flex justify-end gap-6 border-t px-4 py-3 text-sm">
              <span>Total: <span className="font-medium tabular-nums">{formatInr(totals.totalAmount)}</span></span>
              <span>Paid: <span className="font-medium tabular-nums">{formatInr(totals.paidAmount)}</span></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
