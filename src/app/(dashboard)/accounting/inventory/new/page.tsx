import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { requireCompany } from "@/lib/accounting/company";
import { weightedAverageCosts } from "@/lib/accounting/costing";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { NewValuationForm } from "./new-valuation-form";

export const dynamic = "force-dynamic";

export default async function NewStockValuationPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const company = await requireCompany();

  const [periods, products] = await Promise.all([
    prisma.financialPeriod.findMany({
      where: { companyId: company.id, status: "OPEN", stockValuation: null },
      orderBy: [{ financialYear: "desc" }, { periodNumber: "desc" }],
      select: { id: true, label: true, financialYear: true, endDate: true },
    }),
    prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, sku: true, name: true, unit: true },
    }),
  ]);

  if (periods.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="New Inventory Valuation" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No open financial period is available to value — either every open period already has a
            valuation, or no period has been opened yet. See Accounting → Periods.
          </CardContent>
        </Card>
      </div>
    );
  }

  const asOfDate = periods[0].endDate;
  const costs = await weightedAverageCosts(
    products.map((p) => p.id),
    asOfDate,
  );

  const productOptions = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    suggestedUnitCost: costs.get(p.id)?.toFixed(4) ?? null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Inventory Valuation"
        subtitle="Enter the on-hand quantity per product as of the period end — from a physical count or an ERP stock report. The suggested cost is a weighted average of purchase history and can be overridden."
      />
      <NewValuationForm periods={periods} products={productOptions} />
    </div>
  );
}
