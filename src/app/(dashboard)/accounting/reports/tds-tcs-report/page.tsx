import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { tdsTcsReport } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default async function TdsTcsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const rows = await tdsTcsReport(asOfDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="TDS/TCS Report"
        subtitle="Balances of TDS/TCS Receivable and Payable as of a date, for review — not a Form 26Q/27EQ filing. TCS carries no balance today; nothing posts to it yet."
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
      <ExportLinks report="tds-tcs-report" params={{ asOf: asOfDate.toISOString().slice(0, 10) }} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">No TDS/TCS accounts found.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.accountId}>
                    <TableCell>{r.code} {r.name}</TableCell>
                    <TableCell>{r.type === "ASSET" ? "Receivable" : "Payable"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.balance)}</TableCell>
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
