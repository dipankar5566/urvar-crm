import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, scopeWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CALL_MODE_LABELS,
  CALL_OUTCOME_LABELS,
  CALL_SENTIMENT_LABELS,
} from "@/lib/constants/labels";

const SENTIMENT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  POSITIVE: "default",
  NEUTRAL: "secondary",
  NEGATIVE: "destructive",
  ESCALATED: "destructive",
};

/**
 * AI Voice Agent (Phase 1): read-only transcript/summary view for an
 * AI_ASSISTED call — the human-picked outcome/notes still live on the
 * regular calls list; this page is purely the supplementary AI record.
 */
export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ callId: string }>;
}) {
  const { callId } = await params;
  const user = await requireUser();
  const scope = assertCan(user.role, "calls", "read");

  const call = await prisma.call.findFirst({
    where: { id: callId, ...scopeWhere(scope, user, "userId") },
    include: {
      lead: { select: { id: true, name: true, leadNumber: true } },
      customer: { select: { id: true, name: true, customerNumber: true } },
      user: { select: { name: true } },
    },
  });
  if (!call) notFound();

  const transcriptLines = Array.isArray(call.transcript)
    ? (call.transcript as unknown[]).filter((l): l is string => typeof l === "string")
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Call Details"
        subtitle={format(call.calledAt, "d MMM yyyy, h:mm a")}
      />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{CALL_MODE_LABELS[call.callMode] ?? call.callMode}</Badge>
            {call.outcome && (
              <Badge variant="secondary">{CALL_OUTCOME_LABELS[call.outcome] ?? call.outcome}</Badge>
            )}
            {call.aiSentiment && (
              <Badge variant={SENTIMENT_VARIANT[call.aiSentiment] ?? "secondary"}>
                {CALL_SENTIMENT_LABELS[call.aiSentiment] ?? call.aiSentiment}
              </Badge>
            )}
          </div>

          <div className="grid gap-1 text-sm">
            <p>
              <span className="text-muted-foreground">Contact: </span>
              {call.lead ? (
                <Link href={`/leads/${call.lead.id}`} className="hover:underline">
                  {call.lead.name}
                </Link>
              ) : call.customer ? (
                <Link href={`/customers/${call.customer.id}`} className="hover:underline">
                  {call.customer.name}
                </Link>
              ) : (
                "—"
              )}
            </p>
            <p>
              <span className="text-muted-foreground">Rep: </span>
              {call.user?.name ?? "AI Agent"}
            </p>
            {call.durationSeconds !== null && (
              <p>
                <span className="text-muted-foreground">Duration: </span>
                {call.durationSeconds}s
              </p>
            )}
          </div>

          {call.aiSummary && (
            <div>
              <h3 className="mb-1 text-sm font-medium">AI Summary</h3>
              <p className="text-sm text-muted-foreground">{call.aiSummary}</p>
            </div>
          )}

          {call.aiIntentTags.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Intent Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {call.aiIntentTags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {transcriptLines.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Transcript</h3>
              <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
                {transcriptLines.map((line, i) => (
                  <p key={i} className="text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}

          {call.notes && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Rep Notes</h3>
              <p className="text-sm text-muted-foreground">{call.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
