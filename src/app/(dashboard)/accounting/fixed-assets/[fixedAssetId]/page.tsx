import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr, sub } from "@/lib/accounting/money";
import { accumulatedDepreciation } from "@/lib/accounting/fixed-assets";
import { financialYearOf } from "@/lib/accounting/fiscal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PostDepreciationForm, CancelDepreciationEntryButton, DisposeAssetButton, CancelAssetButton,
} from "./asset-actions";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ACTIVE: "default",
  DISPOSED: "outline",
  CANCELLED: "destructive",
};

export default async function FixedAssetDetailPage({ params }: { params: Promise<{ fixedAssetId: string }> }) {
  const { fixedAssetId } = await params;
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";
  const canApprove = can(user.role, "accounting", "approve") !== "none";

  const asset = await prisma.fixedAsset.findUnique({
    where: { id: fixedAssetId },
    include: { assetAccount: { select: { code: true, name: true } } },
  });
  if (!asset) notFound();

  const [entries, accumulated, cashAndBankAccounts] = await Promise.all([
    prisma.depreciationEntry.findMany({
      where: { fixedAssetId },
      orderBy: { financialYear: "asc" },
    }),
    accumulatedDepreciation(fixedAssetId),
    prisma.ledgerAccount.findMany({
      where: { isPostable: true, isActive: true, OR: [{ code: "1110" }, { parent: { code: "1120" } }] },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const netBookValue = sub(asset.cost, accumulated);
  const activeDepreciationCount = entries.filter((e) => !e.cancelledAt).length;
  const canPostDepreciation = canWrite && asset.status === "ACTIVE";
  const canDispose = canApprove && asset.status === "ACTIVE";
  const canCancelAsset = canApprove && asset.status === "ACTIVE" && activeDepreciationCount === 0;
  const suggestedFinancialYear = financialYearOf(new Date());

  return (
    <div className="space-y-6">
      <PageHeader
        title={asset.name}
        subtitle={`${asset.assetAccount.code} · ${asset.assetAccount.name}`}
        action={
          <div className="flex gap-2">
            {canDispose && <DisposeAssetButton fixedAssetId={asset.id} cashAndBankAccounts={cashAndBankAccounts} />}
            {canCancelAsset && <CancelAssetButton fixedAssetId={asset.id} />}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Cost</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">{formatInr(asset.cost)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Accum. Depreciation</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">{formatInr(accumulated)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Net Book Value</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">{formatInr(netBookValue)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle></CardHeader>
          <CardContent><Badge variant={STATUS_VARIANT[asset.status] ?? "secondary"}>{asset.status}</Badge></CardContent>
        </Card>
      </div>

      {canPostDepreciation && (
        <PostDepreciationForm fixedAssetId={asset.id} suggestedFinancialYear={suggestedFinancialYear} />
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Depreciation history (WDV)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>FY</TableHead>
                <TableHead className="text-right">Opening WDV</TableHead>
                <TableHead className="text-right">Charge</TableHead>
                <TableHead className="text-right">Closing WDV</TableHead>
                <TableHead>Status</TableHead>
                {canApprove && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canApprove ? 6 : 5} className="py-10 text-center text-muted-foreground">
                    No depreciation posted yet.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => (
                <TableRow key={e.id} className={e.cancelledAt ? "opacity-50" : undefined}>
                  <TableCell>{e.financialYear}-{String((e.financialYear + 1) % 100).padStart(2, "0")}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(e.openingWdv)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(e.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(e.closingWdv)}</TableCell>
                  <TableCell>{e.cancelledAt ? <Badge variant="outline">Cancelled</Badge> : <Badge>Posted</Badge>}</TableCell>
                  {canApprove && (
                    <TableCell>
                      {!e.cancelledAt && <CancelDepreciationEntryButton depreciationEntryId={e.id} fixedAssetId={asset.id} />}
                    </TableCell>
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
