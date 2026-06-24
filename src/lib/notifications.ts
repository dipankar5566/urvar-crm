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
