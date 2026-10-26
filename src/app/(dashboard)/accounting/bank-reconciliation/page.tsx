import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function BankReconciliationIndexPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  const banks = await prisma.bankAccount.findMany({
    where: { isActive: true },
    orderBy: { displayName: "asc" },
    include: {
      ledgerAccount: { select: { code: true } },
      _count: { select: { statementLines: true } },
    },
  });

  const unmatchedCounts = await prisma.bankStatementLine.groupBy({
    by: ["bankAccountId"],
    where: { status: "UNMATCHED" },
    _count: { _all: true },
  });
  const unmatchedByBank = new Map(unmatchedCounts.map((c) => [c.bankAccountId, c._count._all]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank Reconciliation"
        subtitle="Upload a bank statement, match it against what's already posted, and see what's still outstanding on either side."
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bank</TableHead>
                <TableHead>Ledger</TableHead>
                <TableHead className="text-right">Statement lines</TableHead>
                <TableHead className="text-right">Unmatched</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {banks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No bank accounts configured. Add one under Cash &amp; Bank.
                  </TableCell>
                </TableRow>
              )}
              {banks.map((b) => {
                const unmatched = unmatchedByBank.get(b.id) ?? 0;
                return (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Link href={`/accounting/bank-reconciliation/${b.id}`} className="font-medium underline">
                        {b.displayName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.ledgerAccount.code}</TableCell>
                    <TableCell className="text-right tabular-nums">{b._count.statementLines}</TableCell>
                    <TableCell className="text-right">
                      {unmatched > 0 ? <Badge variant="outline">{unmatched} unmatched</Badge> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
