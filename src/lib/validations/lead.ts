import { z } from "zod";
import { LeadSource, CustomerType, LeadStatus } from "@/generated/prisma/enums";

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

export const leadFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  companyName: optionalText,
  contactPerson: optionalText,
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
  source: z.enum(Object.values(LeadSource) as [string, ...string[]]),
  customerType: z.enum(Object.values(CustomerType) as [string, ...string[]]),
  interestedProducts: optionalText,
  expectedQuantity: optionalText,
  expectedMonthlyValue: optionalNumber,
  estimatedValue: optionalNumber,
  cropInterest: optionalText,
  isGovernmentTender: z.boolean().optional().default(false),
  remarks: optionalText,
  assignedToId: optionalText,
});

export type LeadFormInput = z.input<typeof leadFormSchema>;
export type LeadFormValues = z.output<typeof leadFormSchema>;

export const leadStatusSchema = z.object({
  status: z.enum(Object.values(LeadStatus) as [string, ...string[]]),
  lostReason: optionalText,
});

export type LeadStatusInput = z.input<typeof leadStatusSchema>;
