import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { allPartiesSummary } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AsOfFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function AllPartiesPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { asOf } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const rows = await allPartiesSummary(asOfDate);

  return (
    <div className="space-y-6">
      <PageHeader title="All Parties" subtitle="Every customer and supplier with lifetime invoiced, settled and outstanding as of a date." />
      <AsOfFilterForm asOf={asOf ?? isoDate(asOfDate)} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Party</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Invoiced</TableHead>
                <TableHead className="text-right">Settled</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">No party activity as of this date.</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={`${r.partyType}-${r.partyId}`}>
                    <TableCell>
                      <Link href={`/accounting/reports/party-statement?partyType=${r.partyType}&partyId=${r.partyId}`} className="text-primary hover:underline">
                        {r.partyName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.partyType === "CUSTOMER" ? "Customer" : "Supplier"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.totalInvoiced)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(r.totalSettled)}</TableCell>
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
