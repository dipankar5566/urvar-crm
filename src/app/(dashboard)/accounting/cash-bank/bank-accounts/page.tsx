import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr, money } from "@/lib/accounting/money";
import { accountGroupBalances } from "@/lib/accounting/financial-reports";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

/** Show only the last four digits of an account number on a list screen. */
function maskAccountNumber(n: string | null): string {
  if (!n) return "—";
  return n.length <= 4 ? n : `••••${n.slice(-4)}`;
}

export default async function BankAccountsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const [banks, group] = await Promise.all([
    prisma.bankAccount.findMany({
      orderBy: [{ isActive: "desc" }, { displayName: "asc" }],
      include: { ledgerAccount: { select: { id: true, code: true } } },
    }),
    accountGroupBalances("1120", new Date()),
  ]);

  const balanceByLedger = new Map((group?.accounts ?? []).map((a) => [a.accountId, a.balance]));
  const linkedLedgerIds = new Set(banks.map((b) => b.ledgerAccountId));
  const unlinked = (group?.accounts ?? []).filter((a) => !linkedLedgerIds.has(a.accountId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank Accounts"
        subtitle="Account details, IFSC and UPI for each bank ledger under 1120. Balances come from the ledger."
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/accounting/cash-bank/bank-accounts/new" />}>
              Add Bank Account
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Ledger</TableHead>
                <TableHead>Bank / Branch</TableHead>
                <TableHead>A/c No.</TableHead>
                <TableHead>IFSC</TableHead>
                <TableHead>UPI ID</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {banks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    No bank accounts have details yet.
                  </TableCell>
                </TableRow>
              )}
              {banks.map((b) => (
                <TableRow key={b.id} className={b.isActive ? undefined : "opacity-50"}>
                  <TableCell className="font-medium">
                    {b.displayName}
                    {b.isOverdraft && <Badge variant="outline" className="ml-2">OD</Badge>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{b.ledgerAccount.code}</TableCell>
                  <TableCell className="text-sm">{[b.bankName, b.branch].filter(Boolean).join(", ") || "—"}</TableCell>
                  <TableCell className="text-sm tabular-nums">{maskAccountNumber(b.accountNumber)}</TableCell>
                  <TableCell className="text-sm">{b.ifsc ?? "—"}</TableCell>
                  <TableCell className="text-sm">{b.upiId ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {b.linkedExistingLedger ? "—" : formatInr(b.openingBalance)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatInr(balanceByLedger.get(b.ledgerAccountId) ?? money(0))}
                  </TableCell>
                  <TableCell>{b.isActive ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {unlinked.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <p className="font-medium">Bank ledgers without details</p>
            <p className="text-muted-foreground">
              These ledgers already carry postings. Add their account number and IFSC from Add Bank Account → “Attach to
              an existing bank ledger”; their balances are not re-posted.
            </p>
            <ul className="list-disc pl-5">
              {unlinked.map((a) => (
                <li key={a.accountId}>
                  {a.name} — {formatInr(a.balance)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
