import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { salesAgeingByInvoice, AGEING_BUCKET_LABELS } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AsOfFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function SalesAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const rows = await salesAgeingByInvoice(asOfDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Sales Aging" subtitle="Every open sales invoice, individually, bucketed by days past its due date — bill-wise, unlike AR Ageing's per-customer net." />
      <AsOfFilterForm asOf={asOf ?? isoDate(asOfDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">No open invoices as of this date.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.invoiceId}>
                    <TableCell>{r.invoiceNumber}</TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell>{r.dueDate ? r.dueDate.toLocaleDateString("en-IN") : "—"}</TableCell>
                    <TableCell>{AGEING_BUCKET_LABELS[r.bucket]}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.outstanding)}</TableCell>
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
