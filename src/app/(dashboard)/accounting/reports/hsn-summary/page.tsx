import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { hsnSummary } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function HsnSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { from, to } = await searchParams;

  const today = new Date();
  const fromDate = from ? new Date(from) : new Date(today.getFullYear(), today.getMonth(), 1);
  const toDate = to ? new Date(to) : today;

  const rows = await hsnSummary(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sale Summary By HSN"
        subtitle="Outward supply detail aggregated by HSN code, for GSTR-1 preparation. Not a filed return — no compliance claim is made here."
      />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>HSN</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Taxable Value</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No outward supply in this range.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.hsnCode}>
                    <TableCell>{r.hsnCode}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.taxableValue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.cgst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.sgst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.igst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.total)}</TableCell>
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
