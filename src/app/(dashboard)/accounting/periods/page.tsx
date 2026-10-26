import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { requireCompany } from "@/lib/accounting/company";
import { financialYearOf, financialYearLabel } from "@/lib/accounting/fiscal";
import { profitAndLoss } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PeriodRowActions, OpenYearButton, CloseBooksButton } from "./period-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  OPEN: "default",
  CLOSED: "secondary",
  LOCKED: "outline",
};

type PeriodRow = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
  status: string;
  closedBy: { name: string } | null;
  _count: { entries: number };
};

export default async function PeriodsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const isSuperAdmin = user.role === "SUPER_ADMIN";

  const company = await requireCompany();
  const periods = await prisma.financialPeriod.findMany({
    where: { companyId: company.id },
    orderBy: [{ financialYear: "desc" }, { periodNumber: "asc" }],
    include: {
      closedBy: { select: { name: true } },
      _count: { select: { entries: true } },
    },
  });

  const years = [...new Set(periods.map((p) => p.financialYear))].sort((a, b) => b - a);
  const currentFy = financialYearOf(new Date(), company.fyStartMonth);
  const nextFy = currentFy + 1;
  const nextFyOpen = years.includes(nextFy);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial Periods"
        subtitle={`${company.legalName} — a closed period refuses new postings; a locked one can never be reopened.`}
        action={
          canApprove && !nextFyOpen ? (
            <OpenYearButton
              financialYear={nextFy}
              label={financialYearLabel(nextFy, company.fyStartMonth)}
            />
          ) : undefined
        }
      />

      {years.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No financial periods exist yet.
          </CardContent>
        </Card>
      )}

      {years.map((year) => {
        const rows = periods.filter((p) => p.financialYear === year);
        const postings = rows.reduce((n, p) => n + p._count.entries, 0);
        return (
          <FinancialYearCard
            key={year}
            year={year}
            rows={rows}
            postings={postings}
            company={company}
            currentFy={currentFy}
            canApprove={canApprove}
            isSuperAdmin={isSuperAdmin}
          />
        );
      })}
    </div>
  );
}

async function FinancialYearCard({
  year,
  rows,
  postings,
  company,
  currentFy,
  canApprove,
  isSuperAdmin,
}: {
  year: number;
  rows: PeriodRow[];
  postings: number;
  company: { legalName: string; fyStartMonth: number };
  currentFy: number;
  canApprove: boolean;
  isSuperAdmin: boolean;
}) {
  const fyStart = rows.reduce((min, p) => (p.startDate < min ? p.startDate : min), rows[0].startDate);
  const fyEnd = rows.reduce((max, p) => (p.endDate > max ? p.endDate : max), rows[0].endDate);
  const netProfit = postings > 0 ? (await profitAndLoss(fyStart, fyEnd)).netProfit : null;
  const allLocked = rows.every((p) => p.status === "LOCKED");

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">
            FY {financialYearLabel(year, company.fyStartMonth)}
            {year === currentFy && (
              <Badge variant="outline" className="ml-2 text-[10px]">current</Badge>
            )}
          </span>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">
              {postings} entr{postings === 1 ? "y" : "ies"} posted
              {netProfit !== null && ` · Net ${netProfit.isNegative() ? "loss" : "profit"} ${formatInr(netProfit.abs())}`}
            </span>
            {isSuperAdmin && !allLocked && (
              <CloseBooksButton financialYear={year} label={financialYearLabel(year, company.fyStartMonth)} />
            )}
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Period</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24 text-right">Entries</TableHead>
              <TableHead>Closed by</TableHead>
              {canApprove && <TableHead className="w-44" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.label}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {p.startDate.toLocaleDateString("en-IN")} to {p.endDate.toLocaleDateString("en-IN")}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[p.status] ?? "secondary"}>{p.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {p._count.entries || "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {p.closedBy?.name ?? "—"}
                </TableCell>
                {canApprove && (
                  <TableCell>
                    <PeriodRowActions
                      periodId={p.id}
                      label={p.label}
                      status={p.status as "OPEN" | "CLOSED" | "LOCKED"}
                      isSuperAdmin={isSuperAdmin}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
