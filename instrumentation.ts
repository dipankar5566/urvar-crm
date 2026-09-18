/**
 * Next.js calls register() once when a server instance starts, before it
 * serves any request — the one hook this app has for starting background
 * work that must outlive a single request.
 *
 * The cron module is imported inside register() rather than at the top of
 * this file, per Next's own guidance for side-effecting imports: it keeps the
 * scheduling out of the Edge runtime's module graph entirely, where node-cron
 * and the Prisma client cannot run.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerReminderCron } = await import("@/lib/reminder-cron");
  registerReminderCron();

  const { registerAiBacklogCron } = await import("@/lib/ai-backlog-cron");
  registerAiBacklogCron();
}
