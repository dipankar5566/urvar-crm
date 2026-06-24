import { z } from "zod";
import { TaskPriority } from "@/generated/prisma/enums";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

export const taskCreateSchema = z.object({
  title: z.string().min(2, "Title is required"),
  description: optionalText,
  assignedToId: z.string().min(1, "Assignee is required"),
  priority: z.enum(Object.values(TaskPriority) as [string, ...string[]]),
  dueAt: optionalText,
});

export type TaskCreateInput = z.input<typeof taskCreateSchema>;
