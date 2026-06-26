import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { CustomerForm } from "../customer-form";

export default async function NewCustomerPage() {
  const user = await requireUser();
  const scope = can(user.role, "customers", "write");
  const canAssign = scope === "all" || scope === "territory";

  const reps = canAssign
    ? await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="New Customer"
        subtitle="Onboard a farmer, retailer, dealer, or distributor."
      />
      <CustomerForm reps={reps} canAssign={canAssign} currentUserId={user.id} />
    </div>
  );
}
