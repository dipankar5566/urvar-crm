import { z } from "zod";
import { CustomerType, DealerTier } from "@/generated/prisma/enums";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

const optionalNumber = z.coerce
  .number()
  .nonnegative()
  .optional()
  .nullable()
  .transform((v) => (v === undefined ? null : v));

export const customerFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  companyName: optionalText,
  contactPerson: optionalText,
  customerType: z.enum(Object.values(CustomerType) as [string, ...string[]]),
  phone: z.string().min(10, "Valid 10-digit phone number required").max(15),
  whatsapp: optionalText,
  email: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || z.string().email().safeParse(v).success, {
      message: "Invalid email address",
    })
    .transform((v) => (v ? v : null)),
  state: z.string().min(1, "State is required"),
  district: z.string().min(1, "District is required"),
  pincode: optionalText,
  address: optionalText,
  gstNumber: optionalText,
  panNumber: optionalText,
  creditLimit: optionalNumber,
  outstandingAmount: optionalNumber,
  dealerTier: z
    .enum(Object.values(DealerTier) as [string, ...string[]])
    .optional()
    .nullable()
    .transform((v) => v ?? null),
  territoryAssigned: optionalText,
  annualTargetValue: optionalNumber,
  assignedToId: optionalText,
});

export type CustomerFormInput = z.input<typeof customerFormSchema>;
export type CustomerFormValues = z.output<typeof customerFormSchema>;

export const DEALER_TYPES = ["B2B_DEALER", "B2B_DISTRIBUTOR"] as const;

export const customerLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export type CustomerLocationInput = z.input<typeof customerLocationSchema>;
