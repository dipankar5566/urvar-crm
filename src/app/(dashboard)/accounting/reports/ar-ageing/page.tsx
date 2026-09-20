import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { accountsReceivableAgeing, AGEING_BUCKET_LABELS } from "@/lib/accounting/financial-reports";
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

export default async function ArAgeingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const rows = await accountsReceivableAgeing(asOfDate);
  const bucketKeys = Object.keys(AGEING_BUCKET_LABELS) as (keyof typeof AGEING_BUCKET_LABELS)[];
  const columnTotals = bucketKeys.map((k) => sum(rows.map((r) => r.buckets[k])));
  const grandTotal = sum(rows.map((r) => r.total));

  return (
    <div className="space-y-6">
      <PageHeader
        title="AR Ageing"
        subtitle="Every customer with an open invoice, bucketed by days past its due date. An invoice with no due date is shown as Current."
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
      </form>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                {bucketKeys.map((k) => (
                  <TableHead key={k} className="text-right">{AGEING_BUCKET_LABELS[k]}</TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={bucketKeys.length + 2} className="py-8 text-center text-sm text-muted-foreground">
                    No open receivables as of this date.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.partyId}>
                    <TableCell>{r.partyName}</TableCell>
                    {bucketKeys.map((k) => (
                      <TableCell key={k} className="text-right tabular-nums">
                        {r.buckets[k].isZero() ? "" : formatInr(r.buckets[k])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-medium tabular-nums">{formatInr(r.total)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  {columnTotals.map((t, i) => (
                    <TableCell key={bucketKeys[i]} className="text-right font-semibold tabular-nums">
                      {formatInr(t)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums">{formatInr(grandTotal)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
