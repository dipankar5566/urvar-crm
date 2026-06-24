import { z } from "zod";
import { TaskPriority } from "@/generated/prisma/enums";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

export const followUpCreateSchema = z.object({
  dueAt: z.string().min(1, "Due date is required"),
  priority: z.enum(Object.values(TaskPriority) as [string, ...string[]]),
  notes: optionalText,
});

export type FollowUpCreateInput = z.input<typeof followUpCreateSchema>;

export const followUpRescheduleSchema = z.object({
  dueAt: z.string().min(1, "Due date is required"),
});

export type FollowUpRescheduleInput = z.input<typeof followUpRescheduleSchema>;
