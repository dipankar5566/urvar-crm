/**
 * Create (or refresh) a SUPER_ADMIN login in the DEV database only.
 *
 *   npx tsx --env-file=.env.test scripts/seed-dev-user.ts
 *
 * The integration tests need one active user to post as (tests/helpers/db.ts
 * testUserId), and `npm run dev` against urvar_crm_dev needs someone to log in
 * as. Production must never get this account (CLAUDE.md: never create test
 * users on production), so the script refuses to run against urvar_crm.
 *
 * Password: DEV_ADMIN_PASSWORD if set, otherwise a random one printed once.
 * Same credential-row pattern as users/actions.ts (better-auth's own hash).
 */
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Run with --env-file=.env.test.");
const dbName = new URL(url).pathname.slice(1);
if (dbName === "urvar_crm") {
  throw new Error("Refusing to create a dev login in the production database (urvar_crm).");
}

const EMAIL = "dev-admin@urvar.local";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const password = process.env.DEV_ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { isActive: true, role: "SUPER_ADMIN" },
    create: { name: "Dev Admin", email: EMAIL, emailVerified: true, role: "SUPER_ADMIN" },
  });

  const credential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (credential) {
    await prisma.account.update({ where: { id: credential.id }, data: { password: passwordHash } });
  } else {
    await prisma.account.create({
      data: { userId: user.id, providerId: "credential", accountId: user.id, password: passwordHash },
    });
  }

  console.log(`Dev login ready in ${dbName}: ${EMAIL}`);
  if (!process.env.DEV_ADMIN_PASSWORD) console.log(`Password (shown once): ${password}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
