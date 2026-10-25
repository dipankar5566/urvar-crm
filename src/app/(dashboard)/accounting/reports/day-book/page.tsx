import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { dayBookMoneyFlow } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function DayBookPage({
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

  const { entries, totalIn, totalOut, net } = await dayBookMoneyFlow(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Day Book"
        subtitle="Every posted entry in this range, across every account, in the order it happened. Money In/Out follow Vyapar's Day Book convention: a transfer between two cash-like accounts (cash, bank, cheques in transit) nets to zero."
      />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Money In</TableHead>
                <TableHead className="text-right">Money Out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No entries posted in this range.
                  </TableCell>
                </TableRow>
              ) : (
                entries.flatMap((entry) =>
                  entry.lines.map((line, i) => (
                    <TableRow key={`${entry.entryId}-${line.accountId}-${i}`}>
                      <TableCell>{i === 0 ? entry.entryDate.toLocaleDateString("en-IN") : ""}</TableCell>
                      <TableCell>{i === 0 ? entry.entryNumber : ""}</TableCell>
                      <TableCell className="text-muted-foreground">{i === 0 ? entry.narration : ""}</TableCell>
                      <TableCell>{line.accountCode} {line.accountName}</TableCell>
                      <TableCell className="text-right tabular-nums">{line.debit.isZero() ? "" : formatInr(line.debit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{line.credit.isZero() ? "" : formatInr(line.credit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{i === 0 && !entry.moneyIn.isZero() ? formatInr(entry.moneyIn) : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{i === 0 && !entry.moneyOut.isZero() ? formatInr(entry.moneyOut) : ""}</TableCell>
                    </TableRow>
                  )),
                )
              )}
            </TableBody>
          </Table>
          {entries.length > 0 && (
            <div className="flex justify-end gap-6 border-t px-4 py-3 text-sm">
              <span>Total Money In: <span className="font-medium tabular-nums">{formatInr(totalIn)}</span></span>
              <span>Total Money Out: <span className="font-medium tabular-nums">{formatInr(totalOut)}</span></span>
              <span>Net: <span className="font-medium tabular-nums">{formatInr(net)}</span></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
