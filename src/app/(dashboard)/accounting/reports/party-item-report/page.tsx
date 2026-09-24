import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { partyReportByItem } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function PartyItemReportPage({
  searchParams,
}: {
  searchParams: Promise<{ partyId?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { partyId, from, to } = await searchParams;

  if (!partyId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Party report by Item" subtitle="Products bought by one customer over a range." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Pick a customer from{" "}
            <Link href="/accounting/reports/all-parties" className="text-primary hover:underline">All Parties</Link> — append{" "}
            <code className="text-xs">?partyId=&lt;id&gt;</code> to this page&rsquo;s URL for that customer.
          </CardContent>
        </Card>
      </div>
    );
  }

  const today = new Date();
  const fromDate = from ? new Date(from) : new Date(today.getFullYear(), 0, 1);
  const toDate = to ? new Date(to) : today;

  const rows = await partyReportByItem(partyId, fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Party report by Item" subtitle="Products bought by this customer over a range." />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} hidden={{ partyId }} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">No purchases in this range.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.productId ?? r.productName}>
                    <TableCell>{r.productName}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantity.toString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.value)}</TableCell>
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
