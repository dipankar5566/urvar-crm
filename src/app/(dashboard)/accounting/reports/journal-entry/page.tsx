import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { journalEntryReport } from "@/lib/accounting/financial-reports";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function JournalEntryReportPage({
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

  const lines = await journalEntryReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader title="Journal Entry Report" subtitle="Every manually-posted journal entry in this range. Every other posting already has its own document-shaped report." />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="journal-entry" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No manual journal entries in this range.
                  </TableCell>
                </TableRow>
              ) : (
                Object.values(
                  lines.reduce<Record<string, typeof lines>>((acc, l) => {
                    (acc[l.entryId] ??= []).push(l);
                    return acc;
                  }, {}),
                ).flatMap((entryLines) =>
                  entryLines.map((l, i) => (
                    <TableRow key={`${l.entryId}-${i}`}>
                      <TableCell>{i === 0 ? l.entryDate.toLocaleDateString("en-IN") : ""}</TableCell>
                      <TableCell>{i === 0 ? l.entryNumber : ""}</TableCell>
                      <TableCell className="text-muted-foreground">{i === 0 ? l.narration : ""}</TableCell>
                      <TableCell>{l.accountCode} {l.accountName}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit.isZero() ? "" : formatInr(l.debit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit.isZero() ? "" : formatInr(l.credit)}</TableCell>
                    </TableRow>
                  )),
                )
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
