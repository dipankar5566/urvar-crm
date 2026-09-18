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
import { sendWhatsAppTemplate, isWhatsAppEnabled } from "@/lib/whatsapp";
import { notifySystem } from "@/lib/notifications";

/** Every 15 minutes. A reminder is not worth finer resolution than that. */
const SCHEDULE = "*/15 * * * *";

/** How many days a SENT quotation can sit with no response before we chase it. */
const CHASE_AFTER_DAYS = Number(process.env.QUOTATION_CHASE_AFTER_DAYS ?? 3);

/** Two-stage stale-lead SLA, in hours since the lead was created. */
const STALE_LEAD_REP_ALERT_HOURS = Number(process.env.STALE_LEAD_REP_ALERT_HOURS ?? 24);
const STALE_LEAD_MANAGER_ALERT_HOURS = Number(process.env.STALE_LEAD_MANAGER_ALERT_HOURS ?? 72);

/**
 * Fixed, greppable title prefixes used as the dedup guard for the two
 * Notification-based sweeps below, in place of a new reminderSentAt-style
 * column: "have we already sent this alert for this lead" is answered by
 * `notifications: { none: { title: { startsWith } } }` rather than a new
 * schema field, so this phase ships with no migration.
 */
const STALE_LEAD_REP_ALERT_PREFIX = "[stale-lead-rep] ";
const STALE_LEAD_MANAGER_ALERT_PREFIX = "[stale-lead-manager] ";

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

/** Formats a Decimal-as-string amount for a message body. */
function formatInr(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/**
 * Nudges the customer (and notifies the rep) about a quotation that has sat
 * SENT for CHASE_AFTER_DAYS with no response. Phase 1 of all.md — the gap
 * noted there is that notifyQuotationSent() only ever fires once, on the
 * SENT transition itself, and nothing has looked at an unanswered quotation
 * since.
 *
 * Guarded by "no FOLLOWUP_REMINDER MessageLog exists for this quotation yet"
 * rather than a new column — this is a fire-once nudge, exactly like
 * reminderSentAt, just expressed as a relation filter instead of a flag. The
 * MessageLog row is written whether or not the send actually succeeds (see
 * the same rationale on sendFollowUpReminders above), so a customer with no
 * email on file or a down mail server doesn't get re-processed every tick.
 */
async function sendQuotationChaseReminders(now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - CHASE_AFTER_DAYS * 86_400_000);
  const stale = await prisma.quotation.findMany({
    where: {
      status: "SENT",
      sentAt: { lte: threshold },
      respondedAt: null,
      messageLogs: { none: { purpose: "FOLLOWUP_REMINDER" } },
    },
    include: {
      customer: true,
      lead: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
    take: 100,
  });

  for (const quotation of stale) {
    const recipient = quotation.customer ?? quotation.lead;
    if (!recipient) continue;

    const total = formatInr(quotation.totalAmount.toString());
    const title = `Quotation ${quotation.quotationNumber} unanswered after ${CHASE_AFTER_DAYS}+ day(s)`;

    await notifySystem({
      userId: quotation.createdById,
      type: "GENERAL",
      title,
      body: `${recipient.name} hasn't responded to quotation ${quotation.quotationNumber} (Rs ${total}). A reminder has been sent.`,
      relatedLeadId: quotation.leadId ?? undefined,
      relatedCustomerId: quotation.customerId ?? undefined,
    });

    const emailAddress = recipient.email?.trim();
    if (emailAddress && isEmailConfigured()) {
      const subject = `Following up on quotation ${quotation.quotationNumber}`;
      const result = await sendEmail({
        to: emailAddress,
        subject,
        text: [
          `Dear ${recipient.name},`,
          ``,
          `Just following up on our quotation ${quotation.quotationNumber} (Rs ${total}), sent ${quotation.sentAt?.toLocaleDateString("en-IN")}.`,
          `Please let us know if you have any questions, or if you'd like to go ahead.`,
          ``,
          `Warm regards,`,
          `Urvar Natural Private Limited`,
        ].join("\n"),
      });
      if (!result.success) {
        console.error(`[reminder-cron] chase email failed for quotation ${quotation.id}: ${result.error}`);
      }
      await prisma.messageLog.create({
        data: {
          leadId: quotation.leadId,
          customerId: quotation.customerId,
          quotationId: quotation.id,
          sentById: null, // cron-driven — no human actor behind this send
          channel: "EMAIL",
          purpose: "FOLLOWUP_REMINDER",
          recipient: emailAddress,
          subject,
          status: result.success ? "SENT" : "FAILED",
          errorMessage: result.success ? undefined : result.error,
        },
      });
    } else {
      // No email on file, or SMTP not configured — still record the attempt
      // so this quotation isn't re-selected by the `none` guard every tick.
      await prisma.messageLog.create({
        data: {
          leadId: quotation.leadId,
          customerId: quotation.customerId,
          quotationId: quotation.id,
          sentById: null,
          channel: "EMAIL",
          purpose: "FOLLOWUP_REMINDER",
          recipient: emailAddress || "no-email-on-file",
          status: "FAILED",
          errorMessage: emailAddress ? "Email not configured." : "No email address on file.",
        },
      });
    }

    // WhatsApp: dark until Phase 2's WABA/template approval lands
    // (WHATSAPP_ENABLED=false by default) and a chase-specific template name
    // is configured — isWhatsAppEnabled() and the missing template name both
    // make this a no-op today, exactly like notifyQuotationSent()'s pattern.
    const whatsappNumber = recipient.whatsapp?.trim() || recipient.phone?.trim();
    const chaseTemplate = process.env.WHATSAPP_TEMPLATE_QUOTATION_CHASE ?? "";
    if (whatsappNumber && isWhatsAppEnabled() && chaseTemplate) {
      const result = await sendWhatsAppTemplate({
        to: whatsappNumber,
        templateName: chaseTemplate,
        bodyParams: [recipient.name, quotation.quotationNumber, total],
      });
      if (!result.success) {
        console.error(`[reminder-cron] chase WhatsApp failed for quotation ${quotation.id}: ${result.error}`);
      }
      await prisma.messageLog.create({
        data: {
          leadId: quotation.leadId,
          customerId: quotation.customerId,
          quotationId: quotation.id,
          sentById: null,
          channel: "WHATSAPP",
          purpose: "FOLLOWUP_REMINDER",
          recipient: whatsappNumber,
          subject: chaseTemplate,
          status: result.success ? "SENT" : "FAILED",
          providerMessageId: result.providerMessageId,
          errorMessage: result.success ? undefined : result.error,
        },
      });
    }
  }

  return stale.length;
}

/**
 * Two-stage SLA escalation for leads sitting in NEW/CONTACTED with no call
 * ever logged: first a nudge to the assigned rep past
 * STALE_LEAD_REP_ALERT_HOURS, then — only if still untouched —  an
 * escalation to the sales managers covering that lead's state, past the
 * longer STALE_LEAD_MANAGER_ALERT_HOURS. Both stages guard on a
 * Notification with a fixed title prefix already existing for this lead,
 * the same fire-once contract as the other sweeps, without a new column.
 *
 * Uses Lead.createdAt as the SLA clock, not a dedicated stage-entry
 * timestamp (none exists without a schema change) — so this measures "how
 * long has this lead existed unworked", not "how long since it specifically
 * entered NEW/CONTACTED", which is a reasonable proxy today since both
 * statuses are a lead's earliest states.
 */
async function sendStaleLeadEscalations(now: Date): Promise<number> {
  const repThreshold = new Date(now.getTime() - STALE_LEAD_REP_ALERT_HOURS * 3_600_000);
  const managerThreshold = new Date(now.getTime() - STALE_LEAD_MANAGER_ALERT_HOURS * 3_600_000);

  const repStale = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      status: { in: ["NEW", "CONTACTED"] },
      createdAt: { lte: repThreshold },
      assignedToId: { not: null },
      calls: { none: {} },
      notifications: { none: { title: { startsWith: STALE_LEAD_REP_ALERT_PREFIX } } },
    },
    include: { assignedTo: { select: { id: true, name: true, email: true } } },
    take: 100,
  });

  for (const lead of repStale) {
    if (!lead.assignedTo) continue;
    const title = `${STALE_LEAD_REP_ALERT_PREFIX}${lead.name} has had no call yet`;
    const body = `${lead.name} (${lead.leadNumber}) was created ${STALE_LEAD_REP_ALERT_HOURS}+ hours ago with no call logged.`;

    await notifySystem({
      userId: lead.assignedToId!,
      type: "GENERAL",
      title,
      body,
      relatedLeadId: lead.id,
    });

    if (lead.assignedTo.email) {
      const result = await sendEmail({
        to: lead.assignedTo.email,
        subject: title,
        text: [
          `Hi ${lead.assignedTo.name},`,
          ``,
          body,
          ``,
          `Open the lead: ${appUrl(`/leads/${lead.id}`)}`,
        ].join("\n"),
      });
      if (!result.success) {
        console.error(`[reminder-cron] stale-lead rep email failed for ${lead.id}: ${result.error}`);
      }
    }
  }

  const managerStale = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      status: { in: ["NEW", "CONTACTED"] },
      createdAt: { lte: managerThreshold },
      calls: { none: {} },
      notifications: { none: { title: { startsWith: STALE_LEAD_MANAGER_ALERT_PREFIX } } },
    },
    take: 100,
  });

  for (const lead of managerStale) {
    const managers = await prisma.user.findMany({
      where: { role: "SALES_MANAGER", isActive: true, territoryStates: { has: lead.state } },
      select: { id: true, name: true, email: true },
    });
    // No manager covers this lead's state — nothing to escalate to. Left as
    // a console note rather than silently dropped, since it likely means a
    // territory has no manager assigned yet, which is worth someone noticing.
    if (managers.length === 0) {
      console.warn(`[reminder-cron] stale lead ${lead.id} has no SALES_MANAGER covering state ${lead.state}`);
      continue;
    }

    const title = `${STALE_LEAD_MANAGER_ALERT_PREFIX}${lead.name} is still unworked`;
    const body = `${lead.name} (${lead.leadNumber}) has had no call logged in ${STALE_LEAD_MANAGER_ALERT_HOURS}+ hours.`;

    for (const manager of managers) {
      await notifySystem({
        userId: manager.id,
        type: "GENERAL",
        title,
        body,
        relatedLeadId: lead.id,
      });
      if (manager.email) {
        const result = await sendEmail({
          to: manager.email,
          subject: title,
          text: [
            `Hi ${manager.name},`,
            ``,
            body,
            ``,
            `Open the lead: ${appUrl(`/leads/${lead.id}`)}`,
          ].join("\n"),
        });
        if (!result.success) {
          console.error(`[reminder-cron] stale-lead manager email failed for ${lead.id}: ${result.error}`);
        }
      }
    }
  }

  return repStale.length + managerStale.length;
}

/**
 * One pass over everything the cron watches. Exported so it can be invoked
 * directly (a script, or a manual trigger during testing) without waiting
 * for a tick.
 */
export async function runReminderSweep(): Promise<{
  followUps: number;
  tasks: number;
  quotationChases: number;
  staleLeadEscalations: number;
}> {
  const now = new Date();
  const followUps = await sendFollowUpReminders(now);
  const tasks = await sendTaskReminders(now);
  const quotationChases = await sendQuotationChaseReminders(now);
  const staleLeadEscalations = await sendStaleLeadEscalations(now);
  return { followUps, tasks, quotationChases, staleLeadEscalations };
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
        const { followUps, tasks, quotationChases, staleLeadEscalations } = await runReminderSweep();
        if (followUps || tasks || quotationChases || staleLeadEscalations) {
          console.log(
            `[reminder-cron] reminded ${followUps} follow-up(s), ${tasks} task(s), ` +
              `${quotationChases} quotation chase(s), ${staleLeadEscalations} stale-lead escalation(s)`,
          );
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
