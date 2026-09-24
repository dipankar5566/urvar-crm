import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { outstandingPrincipal } from "@/lib/accounting/loans";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ACTIVE: "default",
  CLOSED: "secondary",
  CANCELLED: "outline",
};

export default async function LoansPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const loans = await prisma.loan.findMany({
    orderBy: { createdAt: "desc" },
    include: { loanAccount: { select: { code: true } } },
  });
  const outstandings = await Promise.all(loans.map((l) => outstandingPrincipal(l.id)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loans"
        subtitle={`${loans.length} loan${loans.length === 1 ? "" : "s"}.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/accounting/loans/new" />}>
              New Loan
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lender</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Principal</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Tenure</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No loans recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {loans.map((loan, i) => (
                <TableRow key={loan.id}>
                  <TableCell>
                    <Link href={`/accounting/loans/${loan.id}`} className="font-medium underline">
                      {loan.lenderName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{loan.loanAccount.code}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(loan.principal)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(outstandings[i])}</TableCell>
                  <TableCell className="text-sm">{loan.annualRatePercent.toFixed(2)}%</TableCell>
                  <TableCell className="text-sm">{loan.tenureMonths} mo</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[loan.status] ?? "secondary"}>{loan.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
