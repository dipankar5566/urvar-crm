import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { gstTaxRateReport } from "@/lib/accounting/gstr-reports";
import { PageHeader } from "@/components/layout/page-header";
import { SheetTable } from "@/components/accounting/sheet-table";
import { ExportLinks } from "@/components/accounting/export-links";

export const dynamic = "force-dynamic";

export default async function GstTaxRateReportPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  const sheets = await gstTaxRateReport();

  return (
    <div className="space-y-6">
      <PageHeader
        title="GST Tax Rate Report"
        subtitle="Every TaxRate row — which HSN codes are verified and ready to invoice from, and which still need an accountant's sign-off. No SAC equivalent: Urvar sells physical goods, not services."
        action={<ExportLinks report="gst-tax-rate" params={{}} />}
      />
      {sheets.map((sheet) => <SheetTable key={sheet.name} sheet={sheet} />)}
    </div>
  );
}
