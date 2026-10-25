import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { gstr3bReport } from "@/lib/accounting/gstr-reports";
import { PageHeader } from "@/components/layout/page-header";
import { SheetTable } from "@/components/accounting/sheet-table";
import { ExportLinks } from "@/components/accounting/export-links";
import { DateRangeFilterForm, isoDate } from "../date-filter-form";

export const dynamic = "force-dynamic";

export default async function Gstr3bReportPage({
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

  const sheets = await gstr3bReport(fromDate, toDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="GSTR-3B"
        subtitle="For review, not for filing. Table 4(D)(1) Section 17(5) is always zero — ITC eligibility only says whether a purchase is ineligible, not which rule made it so, so every ineligible amount lands under 4(D)(2) Others. Table 5 is always zero: composition/exempt/non-GST inward supplies aren't tracked."
      />
      <div className="flex items-center justify-between">
        <DateRangeFilterForm from={from ?? isoDate(fromDate)} to={to ?? isoDate(toDate)} />
        <ExportLinks report="gstr3b" params={{ from: isoDate(fromDate), to: isoDate(toDate) }} />
      </div>
      {sheets.map((sheet) => <SheetTable key={sheet.name} sheet={sheet} />)}
    </div>
  );
}
