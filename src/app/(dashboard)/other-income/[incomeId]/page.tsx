import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { add, formatInr } from "@/lib/accounting/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { OtherIncomeActions } from "./other-income-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "secondary",
  SUBMITTED: "outline",
  APPROVED: "default",
  REJECTED: "destructive",
  CANCELLED: "outline",
};

export default async function OtherIncomeDetailPage({
  params,
}: {
  params: Promise<{ incomeId: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "read");
  const { incomeId } = await params;

  const income = await prisma.otherIncome.findUnique({
    where: { id: incomeId },
    include: {
      categoryAccount: { select: { code: true, name: true } },
      depositAccount: { select: { code: true, name: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      items: { orderBy: { lineNumber: "asc" } },
    },
  });
  if (!income) notFound();
  const hasItems = income.items.length > 0;

  const canApprove = can(user.role, "otherIncome", "approve") !== "none";
  const isOwnSubmission = income.createdById === user.id;

  return (
    <div className="space-y-6">
      <PageHeader
        title={income.incomeNumber}
        subtitle={`${income.payerName} · ${income.incomeDate.toLocaleDateString("en-IN")}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[income.status] ?? "secondary"}>{income.status}</Badge>
            {canApprove && income.status === "SUBMITTED" && (
              <OtherIncomeActions incomeId={income.id} mode="approve" disabledSelfApprove={isOwnSubmission && user.role !== "SUPER_ADMIN"} />
            )}
            {canApprove && income.status === "APPROVED" && (
              <OtherIncomeActions incomeId={income.id} mode="cancel" />
            )}
          </div>
        }
      />

      {isOwnSubmission && income.status === "SUBMITTED" && user.role !== "SUPER_ADMIN" && (
        <Card className="border-muted">
          <CardContent className="py-3 text-sm text-muted-foreground">
            You submitted this entry — someone else needs to approve or reject it.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <Row label="Amount" value={formatInr(income.amount)} strong />
          <Row label="Category" value={`${income.categoryAccount.code} ${income.categoryAccount.name}`} />
          <Row label="Method" value={income.method} />
          <Row label="Deposited to" value={`${income.depositAccount.code} ${income.depositAccount.name}`} />
          {income.description && <Row label="Description" value={income.description} />}
          <Row label="Submitted by" value={income.createdBy.name} />
          {income.approvedBy && <Row label="Approved by" value={income.approvedBy.name} />}
          {income.rejectedReason && <Row label="Rejection reason" value={income.rejectedReason} />}
        </CardContent>
      </Card>

      {hasItems && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 text-sm">
              {income.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-4 border-b pb-2 last:border-0">
                  <div>
                    <div>{item.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.quantity.toString()} × {formatInr(item.unitPrice)}
                      {income.isGstApplicable && Number(item.taxRatePercent) > 0 && ` · GST ${item.taxRatePercent.toString()}%`}
                    </div>
                  </div>
                  <span className="tabular-nums">{formatInr(item.lineTotal)}</span>
                </div>
              ))}
            </div>
            <div className="space-y-1 border-t pt-2 text-sm">
              <Row label="Subtotal" value={formatInr(income.subtotal)} />
              {income.isGstApplicable && (
                <Row label="Tax (output)" value={formatInr(add(add(income.cgstAmount, income.sgstAmount), income.igstAmount))} />
              )}
              {Number(income.roundOff) !== 0 && <Row label="Round off" value={formatInr(income.roundOff)} />}
              <Row label="Total" value={formatInr(income.amount)} strong />
            </div>
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
