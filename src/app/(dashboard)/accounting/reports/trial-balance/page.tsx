import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { trialBalance } from "@/lib/accounting/financial-reports";
import { formatInr, sum } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const rows = await trialBalance(asOfDate);
  const totalDebit = sum(rows.map((r) => r.debit));
  const totalCredit = sum(rows.map((r) => r.credit));

  return (
    <div className="space-y-6">
      <PageHeader title="Trial Balance" subtitle="Every account's net balance as of a date, derived from posted journal lines." />

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
      </form>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No posted activity as of this date.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.accountId}>
                    <TableCell className="font-mono text-xs">{r.code}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.type}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.debit.isZero() ? "" : formatInr(r.debit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.credit.isZero() ? "" : formatInr(r.credit)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="font-medium">Total</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatInr(totalDebit)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatInr(totalCredit)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
