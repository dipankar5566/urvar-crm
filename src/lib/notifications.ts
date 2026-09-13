import { prisma } from "@/lib/prisma";
import type { NotificationType } from "@/generated/prisma/enums";

/**
 * Creates an in-app notification for a user. Never notifies someone about
 * their own action (e.g. self-assignment) since that's a no-op for them.
 */
export async function notifyUser(params: {
  userId: string;
  actingUserId: string;
  type: NotificationType;
  title: string;
  body?: string;
  relatedLeadId?: string;
  relatedCustomerId?: string;
}): Promise<void> {
  if (params.userId === params.actingUserId) return;

  await prisma.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      relatedLeadId: params.relatedLeadId,
      relatedCustomerId: params.relatedCustomerId,
    },
  });
}

/**
 * Creates a notification with no acting user — the system itself is the
 * actor, as with the due-reminder cron.
 *
 * Deliberately not a flag on notifyUser: that function's self-notification
 * guard is right for user-triggered events and wrong here. A reminder is
 * *always* addressed to whoever owns the overdue item, so routing it through
 * notifyUser (where userId would equal actingUserId) would silently discard
 * every reminder instead of sending it.
 */
export async function notifySystem(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  relatedLeadId?: string;
  relatedCustomerId?: string;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      relatedLeadId: params.relatedLeadId,
      relatedCustomerId: params.relatedCustomerId,
    },
  });
}
