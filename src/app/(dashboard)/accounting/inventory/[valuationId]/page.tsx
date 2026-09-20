import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PostValuationButton, DeleteDraftButton, CancelValuationButton } from "./valuation-detail-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "outline",
  POSTED: "default",
  CANCELLED: "destructive",
};

const COST_SOURCE_LABEL: Record<string, string> = {
  WEIGHTED_AVERAGE: "Weighted average",
  MANUAL: "Manual override",
};

export default async function StockValuationDetailPage({
  params,
}: {
  params: Promise<{ valuationId: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";
  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const { valuationId } = await params;

  const valuation = await prisma.stockValuation.findUnique({
    where: { id: valuationId },
    include: {
      period: true,
      createdBy: { select: { name: true } },
      lines: { include: { product: { select: { name: true, sku: true, unit: true } } } },
      company: true,
    },
  });
  if (!valuation) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Inventory Valuation — ${valuation.period.label}`}
        subtitle={`${valuation.company.legalName} — ${valuation.period.financialYear}-${(valuation.period.financialYear + 1) % 100}`}
        action={
          <div className="flex gap-2">
            {valuation.status === "DRAFT" && canWrite && <DeleteDraftButton valuationId={valuation.id} />}
            {valuation.status === "DRAFT" && canApprove && <PostValuationButton valuationId={valuation.id} />}
            {valuation.status === "POSTED" && canApprove && <CancelValuationButton valuationId={valuation.id} />}
          </div>
        }
      />

      <Card>
        <CardContent className="grid gap-4 py-6 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Status</div>
            <Badge variant={STATUS_VARIANT[valuation.status] ?? "outline"}>{valuation.status}</Badge>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Valuation Date</div>
            <div className="font-medium">{valuation.valuationDate.toISOString().slice(0, 10)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Total Value</div>
            <div className="font-medium">{formatInr(valuation.totalValue)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Prepared By</div>
            <div className="font-medium">{valuation.createdBy.name}</div>
          </div>
          {valuation.notes && (
            <div className="sm:col-span-4">
              <div className="text-xs text-muted-foreground">Source of Quantities</div>
              <div className="text-sm">{valuation.notes}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Quantity On Hand</TableHead>
                <TableHead>Unit Cost</TableHead>
                <TableHead>Cost Source</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {valuation.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <div className="font-medium">{line.product.name}</div>
                    <div className="text-xs text-muted-foreground">{line.product.sku}</div>
                  </TableCell>
                  <TableCell>
                    {line.quantityOnHand.toFixed(2)} {line.product.unit}
                  </TableCell>
                  <TableCell>{formatInr(line.unitCost, { alwaysPaise: true })}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {COST_SOURCE_LABEL[line.costSource] ?? line.costSource}
                  </TableCell>
                  <TableCell>{formatInr(line.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {valuation.postedEntryId && (
        <p className="text-sm text-muted-foreground">
          Posted to{" "}
          <Link href="/accounting/journal" className="underline">
            the journal
          </Link>
          .
        </p>
      )}
    </div>
  );
}
