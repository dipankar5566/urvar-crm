import { z } from "zod";
import { ProductCategory } from "@/generated/prisma/enums";

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

export const productFormSchema = z.object({
  sku: z.string().min(2, "SKU is required"),
  name: z.string().min(2, "Name is required"),
  category: z.enum(Object.values(ProductCategory) as [string, ...string[]]),
  hsnCode: optionalText,
  description: optionalText,
  unit: z.string().min(1, "Unit is required"),
  packSize: optionalText,
  mrp: z.coerce.number().nonnegative("MRP must be 0 or more"),
  dealerPrice: optionalNumber,
  distributorPrice: optionalNumber,
  gstPercent: z.coerce.number().min(0).max(100),
  isActive: z.boolean().optional().default(true),
});

export type ProductFormInput = z.input<typeof productFormSchema>;
export type ProductFormValues = z.output<typeof productFormSchema>;
