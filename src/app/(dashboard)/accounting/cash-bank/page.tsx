import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { cashOnHandBalance, accountGroupBalances } from "@/lib/accounting/financial-reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CancelTransactionButton } from "./txn-actions";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRANSFER: "Transfer",
  BANK_CHARGE: "Bank Charge",
  INTEREST_INCOME: "Interest Income",
  CASH_ADJUSTMENT: "Cash Adjustment",
};

export default async function CashBankPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";
  const canApprove = can(user.role, "accounting", "approve") !== "none";

  const asOfDate = new Date();
  const [cash, banks, transactions] = await Promise.all([
    cashOnHandBalance(asOfDate),
    accountGroupBalances("1120", asOfDate),
    prisma.cashBankTransaction.findMany({
      orderBy: { txnDate: "desc" },
      take: 200,
      include: {
        debitAccount: { select: { code: true, name: true } },
        creditAccount: { select: { code: true, name: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash & Bank"
        subtitle="Deposits, withdrawals, transfers, bank charges, interest and cash-count corrections."
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/accounting/cash-bank/new" />}>
              Record Movement
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cash on Hand</CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {formatInr(cash?.balance ?? 0)}
          </CardContent>
        </Card>
        {(banks?.accounts ?? []).map((a) => (
          <Card key={a.accountId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{a.name}</CardTitle>
            </CardHeader>
            <CardContent className="text-xl font-semibold tabular-nums">{formatInr(a.balance)}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Debit</TableHead>
                <TableHead>Credit</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                {canApprove && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canApprove ? 8 : 7} className="py-10 text-center text-muted-foreground">
                    No cash/bank movements recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {transactions.map((t) => (
                <TableRow key={t.id} className={t.cancelledAt ? "opacity-50" : undefined}>
                  <TableCell className="text-xs text-muted-foreground">{t.txnDate.toLocaleDateString("en-IN")}</TableCell>
                  <TableCell>{TYPE_LABELS[t.type] ?? t.type}</TableCell>
                  <TableCell className="text-sm">{t.debitAccount.code} {t.debitAccount.name}</TableCell>
                  <TableCell className="text-sm">{t.creditAccount.code} {t.creditAccount.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{t.reference ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(t.amount)}</TableCell>
                  <TableCell>
                    {t.cancelledAt ? <Badge variant="outline">Cancelled</Badge> : <Badge>Posted</Badge>}
                  </TableCell>
                  {canApprove && (
                    <TableCell>
                      {!t.cancelledAt && <CancelTransactionButton transactionId={t.id} />}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
