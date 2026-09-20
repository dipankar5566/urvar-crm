import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { profitAndLoss } from "@/lib/accounting/financial-reports";
import { requireCompany } from "@/lib/accounting/company";
import { financialYearOf } from "@/lib/accounting/fiscal";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { from, to } = await searchParams;

  const company = await requireCompany();
  const fyStart = new Date(financialYearOf(new Date(), company.fyStartMonth), company.fyStartMonth - 1, 1);
  const fromDate = from ? new Date(from) : fyStart;
  const toDate = to ? new Date(to) : new Date();

  const result = await profitAndLoss(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Profit & Loss" subtitle="Income and expense account activity over a date range." />

      <form method="GET" className="flex items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="from" className="text-xs text-muted-foreground">From</label>
          <input
            id="from" name="from" type="date" defaultValue={from ?? isoDate(fyStart)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="to" className="text-xs text-muted-foreground">To</label>
          <input
            id="to" name="to" type="date" defaultValue={to ?? isoDate(new Date())}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">
          Update
        </button>
      </form>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead colSpan={2}>Income</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {result.income.length === 0 ? (
                  <TableRow><TableCell colSpan={2} className="text-center text-sm text-muted-foreground py-6">No income posted.</TableCell></TableRow>
                ) : (
                  result.income.map((l) => (
                    <TableRow key={l.accountId}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInr(l.amount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">Total Income</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatInr(result.totalIncome)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead colSpan={2}>Expenses</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {result.expenses.length === 0 ? (
                  <TableRow><TableCell colSpan={2} className="text-center text-sm text-muted-foreground py-6">No expenses posted.</TableCell></TableRow>
                ) : (
                  result.expenses.map((l) => (
                    <TableRow key={l.accountId}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInr(l.amount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">Total Expenses</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatInr(result.totalExpenses)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="font-medium">Net Profit</div>
          <div className={`text-lg font-bold tabular-nums ${result.netProfit.isNegative() ? "text-destructive" : ""}`}>
            {formatInr(result.netProfit)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
