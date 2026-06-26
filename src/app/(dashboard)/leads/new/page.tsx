import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { LeadForm } from "../lead-form";

export default async function NewLeadPage() {
  const user = await requireUser();
  const scope = can(user.role, "leads", "write");
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
        title="New Lead"
        subtitle="Capture a new prospect and assign it to a sales rep."
      />
      <LeadForm reps={reps} canAssign={canAssign} currentUserId={user.id} />
    </div>
  );
}
