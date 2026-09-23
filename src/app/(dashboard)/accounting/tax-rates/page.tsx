import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { TaxRateRowActions } from "./tax-rate-actions";

export const dynamic = "force-dynamic";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default async function TaxRatesPage() {
  const user = await requireUser();
  assertCan(user.role, "gst", "read");
  const canVerify = can(user.role, "gst", "approve") !== "none";

  const rates = await prisma.taxRate.findMany({
    orderBy: [{ hsnCode: "asc" }, { effectiveFrom: "desc" }],
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tax Rates"
        subtitle={
          "GST rates by HSN code. A row starts unverified until an accountant confirms the HSN " +
          "classification and rate are correct — the tax engine refuses to price an invoice from an " +
          "unverified row, so verifying here is what unblocks invoicing for that HSN code."
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>HSN</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Cess</TableHead>
                <TableHead>Treatment</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead>Note</TableHead>
                {canVerify && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canVerify ? 9 : 8} className="py-8 text-center text-sm text-muted-foreground">
                    No tax rates yet. Run{" "}
                    <code className="font-mono text-xs">npm run db:seed-accounting -- --apply</code>{" "}
                    to seed one per HSN code on the product catalogue.
                  </TableCell>
                </TableRow>
              ) : (
                rates.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.hsnCode}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.description ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.ratePercent.toString()}%</TableCell>
                    <TableCell className="text-right tabular-nums">{r.cessPercent.toString()}%</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.treatment}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {isoDate(r.effectiveFrom)} to {r.effectiveTo ? isoDate(r.effectiveTo) : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.isVerified ? "default" : "secondary"}>
                        {r.isVerified ? "Verified" : "Unverified"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={r.verifiedNote ?? undefined}>
                      {r.verifiedNote ?? "—"}
                    </TableCell>
                    {canVerify && (
                      <TableCell>
                        {!r.isVerified && (
                          <TaxRateRowActions
                            taxRateId={r.id}
                            hsnCode={r.hsnCode}
                            ratePercent={r.ratePercent.toString()}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
