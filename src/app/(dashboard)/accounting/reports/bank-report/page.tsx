import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { accountGroupBalances } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { AsOfFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function BankReportPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const result = await accountGroupBalances("1120", asOfDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Bank Report" subtitle="Balance of every bank account as of a date." />
      <AsOfFilterForm asOf={asOf ?? isoDate(asOfDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bank Account</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!result || result.accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="py-8 text-center text-sm text-muted-foreground">No bank accounts configured.</TableCell>
                </TableRow>
              ) : (
                result.accounts.map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell>{a.code} {a.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(a.balance)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {result && result.accounts.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatInr(result.total)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
