import { config } from "dotenv";

// Tests run against the dev database (urvar_crm_dev) configured in .env.test.
// dotenv never overrides a variable that is already set, so loading .env.test
// first makes its DATABASE_URL win over the production one in .env.
config({ path: ".env.test" });
config();

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://invalid/").pathname.slice(1);
if (dbName === "urvar_crm" && process.env.ALLOW_PRODUCTION_TESTS !== "true") {
  throw new Error(
    "Refusing to run tests against the production database (urvar_crm). " +
      "Create .env.test pointing at urvar_crm_dev, or set ALLOW_PRODUCTION_TESTS=true to override.",
  );
}
