import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { accumulatedDepreciation } from "@/lib/accounting/fixed-assets";
import { sub } from "@/lib/accounting/money";
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
  DISPOSED: "outline",
  CANCELLED: "destructive",
};

export default async function FixedAssetsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const assets = await prisma.fixedAsset.findMany({
    orderBy: { createdAt: "desc" },
    include: { assetAccount: { select: { code: true, name: true } } },
  });
  const accumulated = await Promise.all(assets.map((a) => accumulatedDepreciation(a.id)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fixed Assets"
        subtitle={`${assets.length} asset${assets.length === 1 ? "" : "s"}.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/accounting/fixed-assets/new" />}>
              New Asset
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Accum. Depreciation</TableHead>
                <TableHead className="text-right">Net Book Value</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No fixed assets recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {assets.map((a, i) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/accounting/fixed-assets/${a.id}`} className="font-medium underline">
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.assetAccount.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(a.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(accumulated[i])}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(sub(a.cost, accumulated[i]))}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status}</Badge>
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
