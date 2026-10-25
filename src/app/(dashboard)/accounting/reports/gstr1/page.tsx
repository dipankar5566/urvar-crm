import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { gstr1Report } from "@/lib/accounting/gstr-reports";
import { PageHeader } from "@/components/layout/page-header";
import { SheetTable } from "@/components/accounting/sheet-table";
import { ExportLinks } from "@/components/accounting/export-links";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function Gstr1ReportPage({
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

  const sheets = await gstr1Report(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="GSTR-1"
        subtitle="For review, not for filing. Shaped against a real Vyapar GSTR-1 export — b2cl, exp, at and atadj aren't implemented because Urvar has no e-commerce, export or advance-tracking data behind them."
      />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="gstr1" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>
      {sheets.map((sheet) => <SheetTable key={sheet.name} sheet={sheet} />)}
    </div>
  );
}
