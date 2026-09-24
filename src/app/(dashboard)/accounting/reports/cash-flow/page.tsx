import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { cashFlowSummary } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function CashFlowPage({
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

  const result = await cashFlowSummary(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash Flow"
        subtitle="Net movement through Cash on Hand and the default bank account, by what caused it. A simplified summary, not a formal operating/investing/financing statement."
      />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Inflow</TableHead>
                <TableHead className="text-right">Outflow</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.buckets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No cash or bank movement in this range.
                  </TableCell>
                </TableRow>
              ) : (
                result.buckets.map((b) => (
                  <TableRow key={b.sourceType}>
                    <TableCell>{b.sourceType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(b.inflow)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(b.outflow)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(b.net)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {result.buckets.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatInr(result.totalInflow)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatInr(result.totalOutflow)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatInr(result.netChange)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
