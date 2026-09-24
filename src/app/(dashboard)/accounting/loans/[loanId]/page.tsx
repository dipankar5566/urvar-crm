import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { outstandingPrincipal } from "@/lib/accounting/loans";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RecordRepaymentForm, CancelRepaymentButton, CancelLoanButton } from "./loan-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ACTIVE: "default",
  CLOSED: "secondary",
  CANCELLED: "outline",
};

export default async function LoanDetailPage({ params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";
  const canApprove = can(user.role, "accounting", "approve") !== "none";

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { loanAccount: { select: { code: true, name: true } }, disbursedToAccount: { select: { code: true, name: true } } },
  });
  if (!loan) notFound();

  const [repayments, outstanding, cashAndBankAccounts] = await Promise.all([
    prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installmentNumber: "asc" },
      include: { paidFromAccount: { select: { code: true, name: true } } },
    }),
    outstandingPrincipal(loanId),
    prisma.ledgerAccount.findMany({
      where: { isPostable: true, isActive: true, OR: [{ code: "1110" }, { parent: { code: "1120" } }] },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const activeCount = repayments.filter((r) => !r.cancelledAt).length;
  const nextInstallmentNumber = activeCount + 1;
  const canRecordRepayment = canWrite && loan.status === "ACTIVE";
  const canCancelLoan = canApprove && loan.status !== "CANCELLED" && activeCount === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={loan.lenderName}
        subtitle={`Loan account ${loan.loanAccount.code} · ${loan.loanAccount.name}`}
        action={canCancelLoan && <CancelLoanButton loanId={loan.id} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Principal</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">{formatInr(loan.principal)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Outstanding</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">{formatInr(outstanding)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Rate / Tenure</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold">{loan.annualRatePercent.toFixed(2)}% · {loan.tenureMonths} mo</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle></CardHeader>
          <CardContent><Badge variant={STATUS_VARIANT[loan.status] ?? "secondary"}>{loan.status}</Badge></CardContent>
        </Card>
      </div>

      {canRecordRepayment && (
        <RecordRepaymentForm
          loanId={loan.id}
          nextInstallmentNumber={nextInstallmentNumber}
          cashAndBankAccounts={cashAndBankAccounts}
        />
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Repayment history</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Date paid</TableHead>
                <TableHead className="text-right">Principal</TableHead>
                <TableHead className="text-right">Interest</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Paid from</TableHead>
                <TableHead>Status</TableHead>
                {canApprove && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {repayments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canApprove ? 8 : 7} className="py-10 text-center text-muted-foreground">
                    No instalments recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {repayments.map((r) => (
                <TableRow key={r.id} className={r.cancelledAt ? "opacity-50" : undefined}>
                  <TableCell>{r.installmentNumber}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.paidDate.toLocaleDateString("en-IN")}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(r.principalPortion)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(r.interestPortion)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(r.totalPaid)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.paidFromAccount.code}</TableCell>
                  <TableCell>{r.cancelledAt ? <Badge variant="outline">Cancelled</Badge> : <Badge>Posted</Badge>}</TableCell>
                  {canApprove && (
                    <TableCell>{!r.cancelledAt && <CancelRepaymentButton repaymentId={r.id} loanId={loan.id} />}</TableCell>
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
