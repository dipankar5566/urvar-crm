import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { User } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";

/**
 * Returns the full app User row (including role + territoryStates) for the
 * currently authenticated request, or null. Cached per-request so multiple
 * server components / actions in one render don't re-query.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  if (!user || !user.isActive) return null;
  return user;
});

/** Require an authenticated, active user or redirect to /login. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Require one of the given roles, or redirect to /dashboard (no access). */
export async function requireRole(roles: Role[]): Promise<User> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/dashboard");
  return user;
}
