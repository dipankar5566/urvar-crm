import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { gstr2Report } from "@/lib/accounting/gstr-reports";
import { PageHeader } from "@/components/layout/page-header";
import { SheetTable } from "@/components/accounting/sheet-table";
import { ExportLinks } from "@/components/accounting/export-links";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function Gstr2ReportPage({
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

  const sheets = await gstr2Report(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="GSTR-2"
        subtitle="For review, not for filing. Only purchases with a per-line HSN (G14) contribute — a legacy header-blended invoice has no per-line rate to report and is excluded, not guessed at. imps, impg, at and atadj aren't implemented: Urvar has no import or advance-tracking data behind them."
      />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="gstr2" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>
      {sheets.map((sheet) => <SheetTable key={sheet.name} sheet={sheet} />)}
    </div>
  );
}
