"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  userCreateSchema,
  userUpdateSchema,
  type UserCreateInput,
  type UserUpdateInput,
} from "@/lib/validations/user";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

export async function createUser(input: UserCreateInput): Promise<ActionResult> {
  const actor = await requireRole(["SUPER_ADMIN"]);
  assertCan(actor.role, "users", "write");
  const parsed = userCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) return { error: "A user with this email already exists." };

  let userId: string;
  try {
    const result = await auth.api.signUpEmail({
      body: { name: data.name, email: data.email, password: data.password },
    });
    userId = result.user.id;
  } catch {
    return { error: "Could not create the account. Please try again." };
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      role: data.role as never,
      phone: data.phone,
      territoryStates: data.territoryStates,
      emailVerified: true,
    },
  });

  revalidatePath("/users");

  await logAudit({
    userId: actor.id,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    newValue: { name: user.name, email: user.email, role: user.role },
  });

  return { success: true, id: user.id };
}

export async function updateUser(
  userId: string,
  input: UserUpdateInput,
): Promise<ActionResult> {
  const actor = await requireRole(["SUPER_ADMIN"]);
  assertCan(actor.role, "users", "write");
  const parsed = userUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return { error: "User not found." };

  if (userId === actor.id && data.isActive === false) {
    return { error: "You cannot deactivate your own account." };
  }
  if (userId === actor.id && data.role !== "SUPER_ADMIN") {
    return { error: "You cannot change your own role." };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      name: data.name,
      role: data.role as never,
      phone: data.phone,
      territoryStates: data.territoryStates,
      isActive: data.isActive,
    },
  });

  revalidatePath("/users");

  await logAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "User",
    entityId: userId,
    oldValue: {
      name: existing.name,
      role: existing.role,
      isActive: existing.isActive,
      territoryStates: existing.territoryStates,
    },
    newValue: data,
  });

  return { success: true };
}
