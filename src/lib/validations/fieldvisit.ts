import { z } from "zod";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

/**
 * A GPS fix as the browser's Geolocation API reports it. Bounds are checked
 * because these arrive from the client and end up plotted on a map — a
 * transposed or garbage pair should be refused at the door, not stored.
 */
const coordinates = {
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  /** Metres of uncertainty; the browser omits it on some devices. */
  accuracy: z.coerce
    .number()
    .nonnegative()
    .optional()
    .nullable()
    .transform((v) => (v === undefined ? null : v)),
};

export const fieldVisitCheckInSchema = z.object({
  ...coordinates,
  notes: optionalText,
});

export type FieldVisitCheckInInput = z.input<typeof fieldVisitCheckInSchema>;

export const fieldVisitCheckOutSchema = z.object({
  ...coordinates,
  notes: optionalText,
});

export type FieldVisitCheckOutInput = z.input<typeof fieldVisitCheckOutSchema>;
