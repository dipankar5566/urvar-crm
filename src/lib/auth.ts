import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    // Local dev: no email verification flow wired up yet (Phase 2).
    requireEmailVerification: false,
    minPasswordLength: 6,
    // There is no public sign-up page — only Super Admin creates accounts
    // (via the Users module). Auto sign-in would otherwise replace the
    // admin's own session with the newly created user's session.
    autoSignIn: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "SALES_EXECUTIVE",
        input: false, // never set via public sign-up payload
      },
    },
  },
  // nextCookies must be the last plugin so it can set cookies on server actions.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
