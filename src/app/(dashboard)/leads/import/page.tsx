import { requireRole } from "@/lib/session";
import { ImportWizard } from "./import-wizard";

export default async function LeadImportPage() {
  await requireRole(["SUPER_ADMIN", "SALES_MANAGER"]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import Leads</h1>
        <p className="text-sm text-muted-foreground">
          Bulk-add leads from an Excel or CSV file.
        </p>
      </div>
      <ImportWizard />
    </div>
  );
}
