import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { loanStatement } from "@/lib/accounting/loans";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function LoanStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ loanId?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { loanId, from, to } = await searchParams;

  if (!loanId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loan Statement" subtitle="Every event against one loan, with a running balance." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Pick a loan from{" "}
            <Link href="/accounting/loans" className="text-primary hover:underline">Loans</Link> to view its statement.
          </CardContent>
        </Card>
      </div>
    );
  }

  const today = new Date();
  const fromDate = from ? new Date(from) : new Date(today.getFullYear(), 0, 1);
  const toDate = to ? new Date(to) : today;

  const result = await loanStatement(loanId, fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title={`Loan Statement — ${result.lenderName}`} subtitle="A fee/charge row leaves the balance unchanged; a disbursement, top-up or EMI moves it." />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} hidden={{ loanId }} />
        <ExportLinks report="loan-statement" params={{ loanId, from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Ending Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">Opening balance</TableCell>
                <TableCell className="text-right tabular-nums font-medium">{formatInr(result.openingBalance)}</TableCell>
              </TableRow>
              {result.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No events in this range.
                  </TableCell>
                </TableRow>
              ) : (
                result.rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{r.date.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{r.type}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.endingBalance)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="grid grid-cols-2 gap-4 border-t p-4 text-sm sm:grid-cols-4">
            <div><div className="text-muted-foreground">Opening Balance</div><div className="font-medium tabular-nums">{formatInr(result.openingBalance)}</div></div>
            <div><div className="text-muted-foreground">Balance Due</div><div className="font-medium tabular-nums">{formatInr(result.balanceDue)}</div></div>
            <div><div className="text-muted-foreground">Total Principal Paid</div><div className="font-medium tabular-nums">{formatInr(result.totalPrincipalPaid)}</div></div>
            <div><div className="text-muted-foreground">Total Interest Paid</div><div className="font-medium tabular-nums">{formatInr(result.totalInterestPaid)}</div></div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
