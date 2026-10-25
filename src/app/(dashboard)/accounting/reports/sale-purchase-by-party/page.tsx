import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { salePurchaseByParty } from "@/lib/accounting/transaction-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function SalePurchaseByPartyPage({
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

  const rows = await salePurchaseByParty(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sale/Purchase by Party"
        subtitle="Sale and purchase totals per party in this range. Customer and Supplier are separate tables here, unlike Vyapar's single party model, so a row is always all-sale or all-purchase. By Party Group is not yet built."
      />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="sale-purchase-by-party" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Party</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Sale Total</TableHead>
                <TableHead className="text-right">Purchase Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No sales or purchases in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={`${r.partyType}-${r.partyId}`}>
                    <TableCell>{r.partyName}</TableCell>
                    <TableCell className="text-muted-foreground">{r.partyType === "CUSTOMER" ? "Customer" : "Supplier"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.saleTotal.isZero() ? "" : formatInr(r.saleTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.purchaseTotal.isZero() ? "" : formatInr(r.purchaseTotal)}</TableCell>
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
