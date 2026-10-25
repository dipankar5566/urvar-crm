import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { loanAccountSummary } from "@/lib/accounting/loans";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AsOfFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function LoanAccountSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;

  const asOfDate = asOf ? new Date(asOf) : new Date();
  const rows = await loanAccountSummary(asOfDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Loan Account Summary" subtitle="Every loan as of a date: lender, opening principal, principal and interest paid, and balance." />
      <AsOfFilterForm asOf={asOf ?? isoDate(asOfDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lender</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Opening Principal</TableHead>
                <TableHead className="text-right">Principal Paid</TableHead>
                <TableHead className="text-right">Interest Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No loans as of this date.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.loanId}>
                    <TableCell>
                      <Link href={`/accounting/reports/loan-statement?loanId=${r.loanId}`} className="hover:underline">{r.lenderName}</Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.status}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.openingPrincipal)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.principalPaid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.interestPaid)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatInr(r.balance)}</TableCell>
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
