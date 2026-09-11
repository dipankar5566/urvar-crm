import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { InvoiceIntake } from "./invoice-intake";

export default async function NewPurchaseInvoicePage() {
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Record a supplier invoice</h1>
        <p className="text-sm text-muted-foreground">
          Upload a scan or photo. Everything read from it is shown for you to check before
          anything is saved.
        </p>
      </div>
      <InvoiceIntake />
    </div>
  );
}
