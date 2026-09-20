import { Fragment } from "react";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { balanceSheet, type BalanceSheetSection } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableRow, TableFooter,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function SectionTable({ sections, total, totalLabel }: { sections: BalanceSheetSection[]; total: string; totalLabel: string }) {
  return (
    <Table>
      <TableBody>
        {sections.length === 0 && (
          <TableRow><TableCell colSpan={2} className="text-center text-sm text-muted-foreground py-6">Nothing posted.</TableCell></TableRow>
        )}
        {sections.map((section) => (
          <Fragment key={section.groupName}>
            <TableRow className="bg-muted/40">
              <TableCell className="font-medium">{section.groupName}</TableCell>
              <TableCell />
            </TableRow>
            {section.lines.map((l) => (
              <TableRow key={l.accountId}>
                <TableCell className="pl-8">{l.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(l.amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="pl-8 text-sm text-muted-foreground">Subtotal</TableCell>
              <TableCell className="text-right text-sm text-muted-foreground tabular-nums">{formatInr(section.total)}</TableCell>
            </TableRow>
          </Fragment>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-semibold">{totalLabel}</TableCell>
          <TableCell className="text-right font-semibold tabular-nums">{total}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const result = await balanceSheet(asOfDate);
  const equityWithEarnings: BalanceSheetSection[] = [
    ...result.equity,
    { groupName: "Current Earnings", lines: [{ accountId: "current-earnings", code: "", name: "Cumulative profit to date (not yet closed to Retained Earnings)", amount: result.currentEarnings }], total: result.currentEarnings },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Balance Sheet"
        subtitle="Assets, liabilities and equity as of a date. Balances by construction of double-entry — a mismatch here would mean something bypassed the posting service."
      />

      <form method="GET" className="flex items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="asOf" className="text-xs text-muted-foreground">As of</label>
          <input
            id="asOf" name="asOf" type="date" defaultValue={asOf ?? todayIso()}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">
          Update
        </button>
        {!result.balances && (
          <Badge variant="destructive">Does not balance — investigate before trusting this report.</Badge>
        )}
      </form>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-2 font-medium">Assets</div>
            <SectionTable sections={result.assets} total={formatInr(result.totalAssets)} totalLabel="Total Assets" />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardContent className="p-0">
              <div className="border-b px-4 py-2 font-medium">Liabilities</div>
              <SectionTable sections={result.liabilities} total={formatInr(result.totalLiabilities)} totalLabel="Total Liabilities" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              <div className="border-b px-4 py-2 font-medium">Equity</div>
              <SectionTable sections={equityWithEarnings} total={formatInr(result.totalEquity)} totalLabel="Total Equity" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
