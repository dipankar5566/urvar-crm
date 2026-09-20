import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ExpenseActions } from "./expense-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "secondary",
  SUBMITTED: "outline",
  APPROVED: "default",
  REJECTED: "destructive",
  CANCELLED: "outline",
};

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ expenseId: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "expenses", "read");
  const { expenseId } = await params;

  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      categoryAccount: { select: { code: true, name: true } },
      paymentAccount: { select: { code: true, name: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  });
  if (!expense) notFound();

  const canApprove = can(user.role, "expenses", "approve") !== "none";
  const isOwnSubmission = expense.createdById === user.id;

  return (
    <div className="space-y-6">
      <PageHeader
        title={expense.expenseNumber}
        subtitle={`${expense.payeeName} · ${expense.expenseDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[expense.status] ?? "secondary"}>{expense.status}</Badge>
            {canApprove && expense.status === "SUBMITTED" && (
              <ExpenseActions expenseId={expense.id} mode="approve" disabledSelfApprove={isOwnSubmission && user.role !== "SUPER_ADMIN"} />
            )}
            {canApprove && expense.status === "APPROVED" && (
              <ExpenseActions expenseId={expense.id} mode="cancel" />
            )}
          </div>
        }
      />

      {isOwnSubmission && expense.status === "SUBMITTED" && user.role !== "SUPER_ADMIN" && (
        <Card className="border-muted">
          <CardContent className="py-3 text-sm text-muted-foreground">
            You submitted this expense — someone else needs to approve or reject it.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <Row label="Amount" value={formatInr(expense.amount)} strong />
          <Row label="Category" value={`${expense.categoryAccount.code} ${expense.categoryAccount.name}`} />
          <Row label="Method" value={expense.method} />
          <Row label="Paid from" value={`${expense.paymentAccount.code} ${expense.paymentAccount.name}`} />
          {expense.description && <Row label="Description" value={expense.description} />}
          <Row label="Submitted by" value={expense.createdBy.name} />
          {expense.approvedBy && <Row label="Approved by" value={expense.approvedBy.name} />}
          {expense.rejectedReason && <Row label="Rejection reason" value={expense.rejectedReason} />}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-semibold" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className={strong ? "text-foreground" : ""}>{value}</span>
    </div>
  );
}
