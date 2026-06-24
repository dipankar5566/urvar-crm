import { z } from "zod";
import { CallDirection, CallOutcome } from "@/generated/prisma/enums";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

export const callLogSchema = z.object({
  direction: z.enum(Object.values(CallDirection) as [string, ...string[]]),
  outcome: z.enum(Object.values(CallOutcome) as [string, ...string[]]),
  durationSeconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .nullable()
    .transform((v) => (v === undefined ? null : v)),
  notes: optionalText,
});

export type CallLogInput = z.input<typeof callLogSchema>;

export const callOutcomeUpdateSchema = z.object({
  outcome: z.enum(Object.values(CallOutcome) as [string, ...string[]]),
  notes: optionalText,
});

export type CallOutcomeUpdateInput = z.input<typeof callOutcomeUpdateSchema>;
