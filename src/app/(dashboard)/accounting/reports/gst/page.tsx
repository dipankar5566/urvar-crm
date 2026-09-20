import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { gstTaxSummary, gstOutwardSupplyRegister } from "@/lib/accounting/financial-reports";
import { requireCompany } from "@/lib/accounting/company";
import { financialYearOf } from "@/lib/accounting/fiscal";
import { formatInr } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default async function GstReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const { from, to } = await searchParams;

  const company = await requireCompany();
  const fyStart = new Date(financialYearOf(new Date(), company.fyStartMonth), company.fyStartMonth - 1, 1);
  const fromDate = from ? new Date(from) : fyStart;
  const toDate = to ? new Date(to) : new Date();

  const [summary, outward] = await Promise.all([
    gstTaxSummary(fromDate, toDate),
    gstOutwardSupplyRegister(fromDate, toDate),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="GST Registers"
        subtitle={
          `${company.gstin ? `GSTIN ${company.gstin}` : "Company GSTIN not yet set"} — this is an ` +
          "internal register for return preparation, not a filed return and not a claim of GST " +
          "compliance. HSN classification for the live catalogue is still marked unverified pending " +
          "accountant sign-off."
        }
      />

      <form method="GET" className="flex items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="from" className="text-xs text-muted-foreground">From</label>
          <input
            id="from" name="from" type="date" defaultValue={from ?? isoDate(fyStart)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="to" className="text-xs text-muted-foreground">To</label>
          <input
            id="to" name="to" type="date" defaultValue={to ?? isoDate(new Date())}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">
          Update
        </button>
      </form>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">Cess</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Output tax (on sales)</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.outputCgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.outputSgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.outputIgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.outputCess)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatInr(summary.totalOutput)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Input tax credit (on purchases)</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.inputCgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.inputSgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.inputIgst)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInr(summary.inputCess)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatInr(summary.totalInput)}</TableCell>
              </TableRow>
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5} className="font-semibold">
                  {summary.netPayable.isNegative() ? "Net credit carried forward" : "Net GST payable"}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatInr(summary.netPayable.abs())}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2 font-medium">Outward Supply Register (GSTR-1 preparation)</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outward.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No sales invoices in this range.
                  </TableCell>
                </TableRow>
              ) : (
                outward.map((row, i) => (
                  <TableRow key={`${row.invoiceId}-${i}`}>
                    <TableCell>{isoDate(row.invoiceDate)}</TableCell>
                    <TableCell className="font-mono text-xs">{row.invoiceNumber}</TableCell>
                    <TableCell>{row.customerName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.customerGstin ?? "B2C"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.hsnCode}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(row.taxableValue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.taxRatePercent.toFixed(2)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInr(row.total)}</TableCell>
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
