import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { add, formatInr } from "@/lib/accounting/money";
import { documentUrl } from "@/lib/documents";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      items: { orderBy: { lineNumber: "asc" } },
      attachments: { select: { id: true, fileName: true } },
    },
  });
  if (!expense) notFound();
  const hasItems = expense.items.length > 0;

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

      {hasItems && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 text-sm">
              {expense.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-4 border-b pb-2 last:border-0">
                  <div>
                    <div>{item.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.quantity.toString()} × {formatInr(item.unitPrice)}
                      {expense.isGstApplicable && Number(item.taxRatePercent) > 0 && ` · GST ${item.taxRatePercent.toString()}%`}
                    </div>
                  </div>
                  <span className="tabular-nums">{formatInr(item.lineTotal)}</span>
                </div>
              ))}
            </div>
            <div className="space-y-1 border-t pt-2 text-sm">
              <Row label="Subtotal" value={formatInr(expense.subtotal)} />
              {expense.isGstApplicable && (
                <Row
                  label={`Tax${expense.claimInputCredit ? " (claimed as ITC)" : ""}`}
                  value={formatInr(add(add(expense.cgstAmount, expense.sgstAmount), expense.igstAmount))}
                />
              )}
              {Number(expense.transportAmount) > 0 && <Row label="Transportation" value={formatInr(expense.transportAmount)} />}
              {Number(expense.roundOff) !== 0 && <Row label="Round off" value={formatInr(expense.roundOff)} />}
              <Row label="Total" value={formatInr(expense.amount)} strong />
            </div>
          </CardContent>
        </Card>
      )}

      {expense.attachments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attachments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {expense.attachments.map((file) => (
              <a
                key={file.id}
                href={documentUrl(file.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-primary underline-offset-4 hover:underline"
              >
                {file.fileName}
              </a>
            ))}
          </CardContent>
        </Card>
      )}
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
