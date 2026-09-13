/**
 * Due-reminder scheduler.
 *
 * Follow-ups and tasks have always had a dueAt, but nothing ever looked at it
 * — a rep only learned an item was overdue by opening the list. This scans
 * for items that have come due and pushes one reminder per item: an in-app
 * notification plus an email to the assignee.
 *
 * Registered from instrumentation.ts's register() hook, which Next calls once
 * per server instance. Safe as a single in-process job because this app runs
 * as one `next start` process under PM2 — see CLAUDE.md. If it were ever
 * scaled to multiple instances, each would run its own copy of this scan and
 * the reminderSentAt guard below would become a race rather than a guarantee.
 */
import cron from "node-cron";
import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { notifySystem } from "@/lib/notifications";

/** Every 15 minutes. A reminder is not worth finer resolution than that. */
const SCHEDULE = "*/15 * * * *";

/** Guards against double registration if this module is imported twice. */
let registered = false;

function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "";
  return `${base}${path}`;
}

/**
 * Emails and notifies the assignee of every follow-up that has come due and
 * has not already been reminded about.
 *
 * reminderSentAt is stamped whether or not the email succeeded: the in-app
 * notification has already landed, and retrying a broken mail server every
 * 15 minutes forever would bury the assignee once it came back.
 */
async function sendFollowUpReminders(now: Date): Promise<number> {
  const due = await prisma.followUp.findMany({
    where: { status: "PENDING", dueAt: { lte: now }, reminderSentAt: null },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      lead: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
    },
    // A backlog on first run (every overdue item at once) should not turn
    // into hundreds of emails in one tick.
    take: 100,
  });

  for (const followUp of due) {
    const about = followUp.lead?.name ?? followUp.customer?.name ?? "a record";
    const title = `Follow-up due: ${about}`;
    const body = followUp.notes?.trim()
      ? followUp.notes.trim()
      : `Your follow-up for ${about} is due.`;

    await notifySystem({
      userId: followUp.assignedToId,
      type: "FOLLOWUP_DUE",
      title,
      body,
      relatedLeadId: followUp.leadId ?? undefined,
      relatedCustomerId: followUp.customerId ?? undefined,
    });

    if (followUp.assignedTo.email) {
      const result = await sendEmail({
        to: followUp.assignedTo.email,
        subject: title,
        text: [
          `Hi ${followUp.assignedTo.name},`,
          ``,
          body,
          ``,
          `Due: ${followUp.dueAt.toLocaleString("en-IN")}`,
          `Priority: ${followUp.priority}`,
          ``,
          `Open your follow-ups: ${appUrl("/follow-ups")}`,
        ].join("\n"),
      });
      if (!result.success) {
        console.error(`[reminder-cron] follow-up ${followUp.id} email failed: ${result.error}`);
      }
    }

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { reminderSentAt: now },
    });
  }

  return due.length;
}

/** The same treatment for tasks, which carry an optional dueAt. */
async function sendTaskReminders(now: Date): Promise<number> {
  const due = await prisma.task.findMany({
    where: {
      status: { in: ["OPEN", "IN_PROGRESS"] },
      dueAt: { lte: now, not: null },
      reminderSentAt: null,
    },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
    },
    take: 100,
  });

  for (const task of due) {
    const title = `Task due: ${task.title}`;
    const body = task.description?.trim() || `Your task "${task.title}" is due.`;

    await notifySystem({
      userId: task.assignedToId,
      type: "TASK_DUE",
      title,
      body,
      relatedLeadId: task.relatedLeadId ?? undefined,
      relatedCustomerId: task.relatedCustomerId ?? undefined,
    });

    if (task.assignedTo.email) {
      const result = await sendEmail({
        to: task.assignedTo.email,
        subject: title,
        text: [
          `Hi ${task.assignedTo.name},`,
          ``,
          body,
          ``,
          `Due: ${task.dueAt ? task.dueAt.toLocaleString("en-IN") : "—"}`,
          `Priority: ${task.priority}`,
          ``,
          `Open your tasks: ${appUrl("/tasks")}`,
        ].join("\n"),
      });
      if (!result.success) {
        console.error(`[reminder-cron] task ${task.id} email failed: ${result.error}`);
      }
    }

    await prisma.task.update({
      where: { id: task.id },
      data: { reminderSentAt: now },
    });
  }

  return due.length;
}

/**
 * One pass over both tables. Exported so it can be invoked directly (a
 * script, or a manual trigger during testing) without waiting for a tick.
 */
export async function runReminderSweep(): Promise<{ followUps: number; tasks: number }> {
  const now = new Date();
  const followUps = await sendFollowUpReminders(now);
  const tasks = await sendTaskReminders(now);
  return { followUps, tasks };
}

export function registerReminderCron(): void {
  if (registered) return;
  registered = true;

  if (!isEmailConfigured()) {
    // Still worth running: the in-app notifications land regardless, and
    // this way reminders are not silently absent once SMTP is filled in.
    console.warn("[reminder-cron] SMTP not configured — reminders will be in-app only.");
  }

  cron.schedule(
    SCHEDULE,
    async () => {
      try {
        const { followUps, tasks } = await runReminderSweep();
        if (followUps || tasks) {
          console.log(`[reminder-cron] reminded ${followUps} follow-up(s), ${tasks} task(s)`);
        }
      } catch (err) {
        // A throw inside a cron callback would otherwise surface as an
        // unhandled rejection and could take the server process down.
        console.error("[reminder-cron] sweep failed:", err);
      }
    },
    {
      name: "due-reminders",
      // A slow sweep must not have a second one starting on top of it —
      // both would read the same not-yet-stamped rows and double-send.
      noOverlap: true,
      timezone: "Asia/Kolkata",
    },
  );

  console.log(`[reminder-cron] scheduled (${SCHEDULE}, Asia/Kolkata)`);
}
