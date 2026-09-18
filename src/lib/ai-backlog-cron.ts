/**
 * Phase 7 of the sales-funnel automation roadmap (all.md): an in-process
 * cron sweep that dials AI outbound calls into the backlog of leads reps
 * have never gotten to — coverage, not cold prospecting, and not a
 * re-engagement campaign (a lead with even one Call row, any outcome, is
 * permanently excluded — see the query below).
 *
 * ============================================================================
 * DO NOT SET AI_OUTBOUND_BACKLOG_ENABLED="true" IN PRODUCTION until legal /
 * compliance has signed off on TRAI DND exposure for this lead population.
 * This sweep autonomously places real phone calls with no human in the
 * loop. AI_OUTBOUND_BACKLOG_ENABLED is the sole gate — see all.md's Phase 7.
 * ============================================================================
 *
 * Own file, not folded into reminder-cron.ts: a misconfigured reminder
 * email is an annoyance, a misconfigured auto-dial sweep is a live phone
 * call and a compliance question, so this stays independently reviewable
 * and deletable without touching the reminder sweep at all.
 *
 * Registered from instrumentation.ts alongside registerReminderCron(),
 * mirroring its exact in-process node-cron pattern — safe as a single
 * in-process job for the same reason documented there (this app runs as
 * one `next start` process under PM2).
 */
import cron from "node-cron";
import { prisma } from "@/lib/prisma";
import { dialAiCall } from "@/lib/ai-call-dialer";

/** Deliberately past both existing stale-lead escalation thresholds in
 * reminder-cron.ts (rep at 24h, manager at 72h) — this sweep is a
 * last-resort coverage net for backlog that has already gone through both
 * human-escalation stages and is still untouched, not a race against them. */
const MIN_AGE_HOURS = Number(process.env.AI_OUTBOUND_BACKLOG_MIN_AGE_HOURS ?? 96);

/** Conservative cap against a dialing storm on first enable. */
const MAX_PER_TICK = Number(process.env.AI_OUTBOUND_BACKLOG_MAX_PER_TICK ?? 5);

/** Quiet hours are enforced by the cron schedule string itself (below), not
 * a runtime clock check — a stronger guarantee, since no call can ever be
 * scheduled outside the window in the first place. Fires at :00/:30 past
 * hours 10-18 IST (last fire 18:30), ordinary Indian business hours. */
const SCHEDULE = "0,30 10-18 * * *";

let registered = false;

export async function runAiBacklogSweep(): Promise<{ dialed: number; skipped: number; eligible: number }> {
  if (process.env.AI_OUTBOUND_BACKLOG_ENABLED !== "true") {
    return { dialed: 0, skipped: 0, eligible: 0 };
  }

  const threshold = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);
  const eligible = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      status: { in: ["NEW", "CONTACTED"] },
      doNotCall: false,
      createdAt: { lte: threshold },
      // Never dialed even once — coverage, not re-engagement. Also
      // self-guards across ticks: once dialAiCall creates a Call row, the
      // lead drops out of every future sweep's query automatically.
      calls: { none: {} },
    },
    select: { id: true, leadNumber: true, name: true },
    take: 200,
    orderBy: { createdAt: "asc" },
  });

  const toDial = eligible.slice(0, MAX_PER_TICK);
  let dialed = 0;
  let skipped = 0;

  for (const lead of toDial) {
    const result = await dialAiCall(lead.id);
    if ("success" in result) {
      dialed++;
      console.log(`[ai-backlog-cron] dialed ${lead.leadNumber} (${lead.name})`);
    } else {
      skipped++;
      console.log(`[ai-backlog-cron] skipped ${lead.leadNumber} (${lead.name}): ${result.error}`);
    }
  }

  return { dialed, skipped, eligible: eligible.length };
}

export function registerAiBacklogCron(): void {
  if (registered) return;
  registered = true;

  cron.schedule(
    SCHEDULE,
    async () => {
      try {
        const { dialed, skipped, eligible } = await runAiBacklogSweep();
        if (dialed || skipped) {
          console.log(
            `[ai-backlog-cron] tick: dialed ${dialed}, skipped ${skipped}, ${eligible} eligible in backlog`,
          );
        }
      } catch (err) {
        console.error("[ai-backlog-cron] sweep failed:", err);
      }
    },
    {
      name: "ai-outbound-backlog",
      noOverlap: true,
      timezone: "Asia/Kolkata",
    },
  );

  console.log(
    `[ai-backlog-cron] scheduled (${SCHEDULE}, Asia/Kolkata) — ` +
      `AI_OUTBOUND_BACKLOG_ENABLED=${process.env.AI_OUTBOUND_BACKLOG_ENABLED === "true"}`,
  );
}
