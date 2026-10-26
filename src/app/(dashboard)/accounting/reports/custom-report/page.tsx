import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { listCustomReportDefinitions, CUSTOM_REPORT_COLUMNS, CUSTOM_REPORT_TRANSACTION_TYPES } from "@/lib/accounting/custom-report";
import { PageHeader } from "@/components/layout/page-header";
import { CustomReportBuilder } from "./custom-report-builder";

export const dynamic = "force-dynamic";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default async function CustomReportPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  const saved = await listCustomReportDefinitions(user.id);

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom Report"
        subtitle="Pick columns and filters over the All Transactions Report's own dataset — nothing here can show a figure that report disagrees with."
      />
      <CustomReportBuilder
        allColumns={CUSTOM_REPORT_COLUMNS as unknown as { key: string; label: string }[]}
        allTypes={CUSTOM_REPORT_TRANSACTION_TYPES}
        savedReports={saved}
        defaultFrom={isoDate(from)}
        defaultTo={isoDate(to)}
      />
    </div>
  );
}
