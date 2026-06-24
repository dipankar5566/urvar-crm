import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New Lead</h1>
        <p className="text-sm text-muted-foreground">
          Capture a new prospect and assign it to a sales rep.
        </p>
      </div>
      <LeadForm reps={reps} canAssign={canAssign} currentUserId={user.id} />
    </div>
  );
}
