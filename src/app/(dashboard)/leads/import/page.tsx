import { requireRole } from "@/lib/session";
import { PageHeader } from "@/components/layout/page-header";
import { ImportWizard } from "./import-wizard";

export default async function LeadImportPage() {
  await requireRole(["SUPER_ADMIN", "SALES_MANAGER"]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import Leads"
        subtitle="Bulk-add leads from an Excel or CSV file."
      />
      <ImportWizard />
    </div>
  );
}
