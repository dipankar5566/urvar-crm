import { z } from "zod";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

export const quotationItemSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unitPrice: z.coerce.number().nonnegative("Unit price must be 0 or more"),
  discountPercent: z.coerce.number().min(0).max(100).optional().default(0),
});

export const quotationFormSchema = z
  .object({
    customerId: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    leadId: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    validUntil: optionalText,
    discountPercent: z.coerce.number().min(0).max(100).optional().default(0),
    freightAmount: z.coerce.number().nonnegative().optional().default(0),
    termsAndConditions: optionalText,
    notes: optionalText,
    items: z.array(quotationItemSchema).min(1, "Add at least one product"),
  })
  .refine((data) => data.customerId || data.leadId, {
    message: "A quotation must be linked to a customer or a lead",
    path: ["customerId"],
  });

export type QuotationItemInput = z.input<typeof quotationItemSchema>;
export type QuotationFormInput = z.input<typeof quotationFormSchema>;
export type QuotationFormValues = z.output<typeof quotationFormSchema>;

export const quotationStatusSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]),
});

export type QuotationStatusInput = z.input<typeof quotationStatusSchema>;
