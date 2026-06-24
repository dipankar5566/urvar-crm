import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Phone, Mail, MapPin, Sprout } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  LEAD_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
  CUSTOMER_TYPE_LABELS,
  PIPELINE_STAGE_LABELS,
  inr,
} from "@/lib/constants/labels";
import { LeadActivityTimeline } from "./lead-activity-timeline";
import { LeadStatusForm } from "./lead-status-form";
import { ConvertButton } from "./convert-button";
import { LogCallDialog } from "./log-call-dialog";
import { CallButton } from "./call-button";
import { ScheduleFollowUpDialog } from "./schedule-follow-up-dialog";
import { TaskForm } from "../../tasks/task-form";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "leads", "read");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
    include: {
      assignedTo: { select: { id: true, name: true } },
      pipeline: true,
      activities: {
        orderBy: { createdAt: "desc" },
        include: { createdBy: { select: { name: true } } },
      },
      convertedCustomer: { select: { customerNumber: true } },
    },
  });

  if (!lead) notFound();

  const canWrite = can(user.role, "leads", "write") !== "none";
  const canLogCalls = can(user.role, "calls", "write") !== "none";
  const canScheduleFollowUps = can(user.role, "followups", "write") !== "none";
  const canCreateTasks = can(user.role, "tasks", "write") !== "none";
  const taskAssignScope = can(user.role, "tasks", "write");
  const reps =
    canCreateTasks && taskAssignScope === "all"
      ? await prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
            <Badge variant="secondary">{lead.leadNumber}</Badge>
            {lead.isGovernmentTender && (
              <Badge variant="outline">Govt. Tender</Badge>
            )}
          </div>
          {lead.companyName && (
            <p className="text-sm text-muted-foreground">{lead.companyName}</p>
          )}
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" render={<Link href={`/leads/${lead.id}/edit`} />}>
            <Pencil /> Edit Lead
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground" />
              {lead.phone}
            </div>
            {lead.email && (
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                {lead.email}
              </div>
            )}
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              {lead.district}, {lead.state}
              {lead.pincode ? ` – ${lead.pincode}` : ""}
            </div>
            {lead.cropInterest && (
              <div className="flex items-center gap-2">
                <Sprout className="h-4 w-4 text-muted-foreground" />
                {lead.cropInterest}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 pt-2 text-xs text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">Type</p>
                {CUSTOMER_TYPE_LABELS[lead.customerType] ?? lead.customerType}
              </div>
              <div>
                <p className="font-medium text-foreground">Source</p>
                {LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
              </div>
              <div>
                <p className="font-medium text-foreground">Est. Value</p>
                {inr(lead.estimatedValue ? Number(lead.estimatedValue) : null)}
              </div>
              <div>
                <p className="font-medium text-foreground">Assigned To</p>
                {lead.assignedTo?.name ?? "Unassigned"}
              </div>
            </div>
            {lead.interestedProducts && (
              <div className="pt-2 text-xs">
                <p className="font-medium text-foreground">Interested Products</p>
                <p className="text-muted-foreground">{lead.interestedProducts}</p>
              </div>
            )}
            {lead.remarks && (
              <div className="pt-2 text-xs">
                <p className="font-medium text-foreground">Remarks</p>
                <p className="text-muted-foreground">{lead.remarks}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status & Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Lifecycle Status
              </p>
              {canWrite ? (
                <LeadStatusForm
                  leadId={lead.id}
                  currentStatus={lead.status}
                  currentLostReason={lead.lostReason}
                />
              ) : (
                <Badge>{LEAD_STATUS_LABELS[lead.status] ?? lead.status}</Badge>
              )}
            </div>
            {lead.pipeline && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Pipeline Stage
                </p>
                <Link href="/pipeline" className="hover:underline">
                  <Badge variant="secondary">
                    {PIPELINE_STAGE_LABELS[lead.pipeline.stage] ?? lead.pipeline.stage}
                  </Badge>
                </Link>
              </div>
            )}
            {canWrite && (
              <div className="pt-2">
                <ConvertButton
                  leadId={lead.id}
                  alreadyConverted={!!lead.convertedAt}
                />
                {lead.convertedCustomer && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Customer: {lead.convertedCustomer.customerNumber}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {(canLogCalls || canScheduleFollowUps || canCreateTasks) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {canLogCalls && <CallButton leadId={lead.id} leadName={lead.name} />}
              {canLogCalls && <LogCallDialog leadId={lead.id} />}
              {canScheduleFollowUps && <ScheduleFollowUpDialog leadId={lead.id} />}
              {canCreateTasks && (
                <TaskForm
                  reps={reps}
                  canAssign={taskAssignScope === "all"}
                  currentUserId={user.id}
                  relatedLeadId={lead.id}
                  triggerLabel="Add Task"
                  triggerVariant="outline"
                />
              )}
            </CardContent>
          </Card>
        )}
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Activity Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <LeadActivityTimeline leadId={lead.id} activities={lead.activities} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
