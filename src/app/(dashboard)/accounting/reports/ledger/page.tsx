import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { generalLedger } from "@/lib/accounting/financial-reports";
import { requireCompany } from "@/lib/accounting/company";
import { financialYearOf } from "@/lib/accounting/fiscal";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { account, from, to } = await searchParams;

  const company = await requireCompany();
  const fyStart = new Date(financialYearOf(new Date(), company.fyStartMonth), company.fyStartMonth - 1, 1);
  const fromDate = from ? new Date(from) : fyStart;
  const toDate = to ? new Date(to) : new Date();

  const accounts = await prisma.ledgerAccount.findMany({
    where: { isPostable: true, isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  const accountId = account || accounts[0]?.id;
  const result = accountId ? await generalLedger(accountId, fromDate, toDate) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Ledger"
        subtitle="One account's transaction history — pick Cash on Hand or the bank account for the cash book or bank book."
      />

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="account" className="text-xs text-muted-foreground">Account</label>
          <select
            id="account" name="account" defaultValue={accountId}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
            ))}
          </select>
        </div>
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

      {result && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="font-medium">{result.account.code} — {result.account.name}</div>
              <div className="text-sm text-muted-foreground">
                Opening: {formatInr(result.openingBalance)}
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry #</TableHead>
                  <TableHead>Narration</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No activity in this range.
                    </TableCell>
                  </TableRow>
                ) : (
                  result.lines.map((line, i) => (
                    <TableRow key={`${line.entryId}-${i}`}>
                      <TableCell>{isoDate(line.entryDate)}</TableCell>
                      <TableCell className="font-mono text-xs">{line.entryNumber}</TableCell>
                      <TableCell>{line.narration}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.debit.isZero() ? "" : formatInr(line.debit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.credit.isZero() ? "" : formatInr(line.credit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatInr(line.runningBalance)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <div className="flex justify-end border-t px-4 py-3 text-sm font-medium">
              Closing: {formatInr(result.closingBalance)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
