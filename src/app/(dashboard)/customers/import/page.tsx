import { requireRole } from "@/lib/session";
import { PageHeader } from "@/components/layout/page-header";
import { ImportWizard } from "./import-wizard";

export default async function CustomerImportPage() {
  await requireRole(["SUPER_ADMIN", "SALES_MANAGER"]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import Customers"
        subtitle="Bulk-add customers from an existing Excel or CSV file."
      />
      <ImportWizard />
    </div>
  );
}
