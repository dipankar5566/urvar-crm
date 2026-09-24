import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { accountGroupBalances, cashOnHandBalance, type AccountGroupBalance } from "@/lib/accounting/financial-reports";
import { formatInr, type Money } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow, TableFooter } from "@/components/ui/table";
import { AsOfFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

function GroupTable({ title, accounts, total }: { title: string; accounts: AccountGroupBalance[]; total: Money }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow><TableCell className="py-6 text-center text-sm text-muted-foreground">No accounts configured.</TableCell></TableRow>
            ) : (
              accounts.map((a) => (
                <TableRow key={a.accountId}>
                  <TableCell>{a.code} {a.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(a.balance)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {accounts.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatInr(total)}</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}

export default async function CashBankAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const [cash, bank, fixedAssets, loans] = await Promise.all([
    cashOnHandBalance(asOfDate),
    accountGroupBalances("1120", asOfDate),
    accountGroupBalances("1200", asOfDate),
    accountGroupBalances("2200", asOfDate),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash, Bank & Assets"
        subtitle="Cash on Hand, Bank Accounts, Fixed Assets and Loan Accounts as of a date. Fixed Assets and Loans already exist in the chart of accounts (1200, 2200) — no new setup was needed for this report."
      />
      <AsOfFilterForm asOf={asOf ?? isoDate(asOfDate)} />

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Cash In Hand</CardTitle></CardHeader>
          <CardContent className="flex items-center justify-between">
            <span>{cash ? `${cash.code} ${cash.name}` : "Not configured"}</span>
            <span className="tabular-nums font-medium">{cash ? formatInr(cash.balance) : "—"}</span>
          </CardContent>
        </Card>
        {bank && <GroupTable title="Bank Accounts" accounts={bank.accounts} total={bank.total} />}
        {fixedAssets && <GroupTable title="Fixed Assets" accounts={fixedAssets.accounts} total={fixedAssets.total} />}
        {loans && <GroupTable title="Loan Accounts" accounts={loans.accounts} total={loans.total} />}
      </div>
    </div>
  );
}
