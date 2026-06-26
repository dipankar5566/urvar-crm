import { z } from "zod";
import { Role } from "@/generated/prisma/enums";

const optionalText = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

export const userCreateSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(Object.values(Role) as [string, ...string[]]),
  phone: optionalText,
  territoryStates: z.array(z.string()).default([]),
});

export const userUpdateSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Enter a valid email"),
  role: z.enum(Object.values(Role) as [string, ...string[]]),
  phone: optionalText,
  territoryStates: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
});

export type UserCreateInput = z.input<typeof userCreateSchema>;
export type UserUpdateInput = z.input<typeof userUpdateSchema>;
