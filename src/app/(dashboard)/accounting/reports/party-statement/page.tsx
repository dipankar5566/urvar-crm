import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { partyStatement } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function PartyStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ partyType?: string; partyId?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { partyType, partyId, from, to } = await searchParams;

  if ((partyType !== "CUSTOMER" && partyType !== "SUPPLIER") || !partyId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Party Statement" subtitle="A running ledger for one customer or supplier, with a balance." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Pick a party from{" "}
            <Link href="/accounting/reports/all-parties" className="text-primary hover:underline">All Parties</Link> to view its statement.
          </CardContent>
        </Card>
      </div>
    );
  }

  const today = new Date();
  const fromDate = from ? new Date(from) : new Date(today.getFullYear(), 0, 1);
  const toDate = to ? new Date(to) : today;

  const result = await partyStatement(partyId, partyType, fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Statement — ${result.partyName}`}
        subtitle={partyType === "CUSTOMER" ? "What this customer owes us." : "What we owe this supplier."}
      />
      <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} hidden={{ partyType, partyId }} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">Opening balance</TableCell>
                <TableCell className="text-right tabular-nums font-medium">{formatInr(result.openingBalance)}</TableCell>
              </TableRow>
              {result.lines.map((l) => (
                <TableRow key={l.entryId}>
                  <TableCell>{l.entryDate.toLocaleDateString("en-IN")}</TableCell>
                  <TableCell>{l.entryNumber}</TableCell>
                  <TableCell className="text-muted-foreground">{l.narration}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.debit.isZero() ? "" : formatInr(l.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.credit.isZero() ? "" : formatInr(l.credit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(l.runningBalance)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={5} className="font-semibold">Closing balance</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatInr(result.closingBalance)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
