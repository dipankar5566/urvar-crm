import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { partyWiseProfitAndLoss } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function PartyProfitLossPage({
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

  const rows = await partyWiseProfitAndLoss(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Party wise Profit and Loss" subtitle="Revenue and estimated cost per customer over a date range." />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Est. Cost</TableHead>
                <TableHead className="text-right">Est. Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">No sales in this range.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.customerId}>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.revenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.estimatedCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.estimatedMargin)}</TableCell>
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
