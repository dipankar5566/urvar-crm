import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { allTransactionsReport } from "@/lib/accounting/transaction-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function AllTransactionsPage({
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

  const rows = await allTransactionsReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Transactions Report"
        subtitle="Every sale, purchase, payment, expense and loan event in this range. Pure cash/bank housekeeping (deposits, transfers, adjustments) is on the Day Book instead, matching Vyapar's own split."
      />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference No</TableHead>
                <TableHead>Party Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-sm text-muted-foreground">
                    No transactions in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{r.date.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{r.referenceNo ?? "—"}</TableCell>
                    <TableCell>{r.partyName ?? "—"}</TableCell>
                    <TableCell>{r.categoryName ?? "—"}</TableCell>
                    <TableCell>{r.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.total)}</TableCell>
                    <TableCell>{r.paymentType ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.paid ? formatInr(r.paid) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.received ? formatInr(r.received) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.balance ? formatInr(r.balance) : ""}</TableCell>
                    <TableCell className="text-muted-foreground">{r.description ?? ""}</TableCell>
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
