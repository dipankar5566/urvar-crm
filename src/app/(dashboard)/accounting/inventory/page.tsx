import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { requireCompany } from "@/lib/accounting/company";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "outline",
  POSTED: "default",
  CANCELLED: "destructive",
};

export default async function InventoryValuationPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const company = await requireCompany();
  const valuations = await prisma.stockValuation.findMany({
    where: { companyId: company.id },
    orderBy: { period: { startDate: "desc" } },
    include: {
      period: { select: { label: true, financialYear: true } },
      createdBy: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Valuation"
        subtitle={
          `${company.legalName} — periodic closing-stock valuation. Quantity is entered by a person ` +
          "(physical count or an ERP report), never read live: the ERP integration for that has not " +
          "been wired into production. Unit cost is a weighted average of purchase history."
        }
        action={
          canWrite ? (
            <Button render={<Link href="/accounting/inventory/new" />}>New Valuation</Button>
          ) : undefined
        }
      />

      {valuations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No closing-stock valuation has been prepared yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Valuation Date</TableHead>
                  <TableHead>Products</TableHead>
                  <TableHead>Total Value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Prepared By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {valuations.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>
                      <Link href={`/accounting/inventory/${v.id}`} className="font-medium hover:underline">
                        {v.period.label} ({v.period.financialYear}-{(v.period.financialYear + 1) % 100})
                      </Link>
                    </TableCell>
                    <TableCell>{v.valuationDate.toISOString().slice(0, 10)}</TableCell>
                    <TableCell>{v._count.lines}</TableCell>
                    <TableCell>{formatInr(v.totalValue)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[v.status] ?? "outline"}>{v.status}</Badge>
                    </TableCell>
                    <TableCell>{v.createdBy.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
