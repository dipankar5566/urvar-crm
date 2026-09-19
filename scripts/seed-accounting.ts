/**
 * Seeds the accounting foundation: company record, chart of accounts,
 * account mappings, financial periods, and HSN tax rates.
 *
 *   npx tsx scripts/seed-accounting.ts            dry run, prints what it would do
 *   npx tsx scripts/seed-accounting.ts --apply    writes
 *   npx tsx scripts/seed-accounting.ts --apply --fy 2026
 *
 * Idempotent: every write is an upsert keyed on a natural key (account code,
 * mapping key, company+FY+period). Running it twice changes nothing the
 * second time, which is what makes it safe to re-run after adding an account.
 *
 * Deliberately NOT wired into `prisma/seed.ts`. That script wipes the
 * database to build demo data; this one runs against production to install
 * structure. Conflating them is how a demo seed ends up truncating a ledger.
 *
 * It never invents company identity. GSTIN, address and bank details are left
 * null for an admin to fill in, because a fabricated GSTIN on a tax invoice is
 * a legal problem, not a placeholder.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  CHART_OF_ACCOUNTS,
  DEFAULT_ACCOUNT_MAPPINGS,
  defaultNormalBalance,
} from "../src/lib/accounting/chart-of-accounts.js";
import { financialYearOf, financialYearLabel, periodsForYear } from "../src/lib/accounting/fiscal.js";

const APPLY = process.argv.includes("--apply");
const fyArgIdx = process.argv.indexOf("--fy");
const FY_ARG = fyArgIdx >= 0 ? Number(process.argv[fyArgIdx + 1]) : null;

const COMPANY_LEGAL_NAME = "Urvar Natural Private Limited";
/**
 * Origin state for place-of-supply. Inferred from the business, not invented:
 * the CRM's customers, the voice agent's default language (Bengali) and the
 * lead book are all West Bengal. Override with --state if that is wrong; it
 * decides CGST+SGST vs IGST on every invoice, so it must be right before
 * Phase 2 goes live.
 */
const stateArgIdx = process.argv.indexOf("--state");
const COMPANY_STATE = stateArgIdx >= 0 ? String(process.argv[stateArgIdx + 1]) : "West Bengal";

/** Stand-in id so a dry run can trace work that depends on created rows. */
const DRY_RUN_ID = "(dry-run)";

const log = (...a: unknown[]) => console.log(...a);
const plan = (msg: string) => log(`${APPLY ? "  ✓" : "  ·"} ${msg}`);

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    log(APPLY ? "APPLYING accounting seed\n" : "DRY RUN — pass --apply to write\n");

    // ---------------------------------------------------------- company
    let company = await prisma.company.findFirst({ where: { isActive: true } });
    if (company) {
      log(`Company: existing "${company.legalName}" (state ${company.state})`);
    } else {
      plan(`create company "${COMPANY_LEGAL_NAME}", state "${COMPANY_STATE}"`);
      if (APPLY) {
        company = await prisma.company.create({
          data: { legalName: COMPANY_LEGAL_NAME, state: COMPANY_STATE, fyStartMonth: 4 },
        });
      }
    }

    // ------------------------------------------------ chart of accounts
    const existingAccounts = await prisma.ledgerAccount.findMany({
      select: { id: true, code: true },
    });
    const idByCode = new Map(existingAccounts.map((a) => [a.code, a.id]));

    let created = 0;
    let updated = 0;

    // Pass 1: upsert every account without its parent link, so ordering in
    // CHART_OF_ACCOUNTS does not have to be topological.
    for (const acc of CHART_OF_ACCOUNTS) {
      const data = {
        name: acc.name,
        type: acc.type,
        normalBalance: acc.normalBalance ?? defaultNormalBalance(acc.type),
        isPostable: acc.isPostable ?? true,
        isSystem: true,
        description: acc.description ?? null,
      };
      if (idByCode.has(acc.code)) {
        updated++;
        if (APPLY) {
          await prisma.ledgerAccount.update({ where: { code: acc.code }, data });
        }
      } else {
        created++;
        if (APPLY) {
          const row = await prisma.ledgerAccount.create({
            data: { code: acc.code, ...data },
          });
          idByCode.set(acc.code, row.id);
        } else {
          // So the dry run can still report the mapping and period work that
          // would follow, instead of reporting a misleading zero.
          idByCode.set(acc.code, DRY_RUN_ID);
        }
      }
    }
    plan(`accounts: ${created} to create, ${updated} to refresh (${CHART_OF_ACCOUNTS.length} total)`);

    // Pass 2: parent links.
    if (APPLY) {
      for (const acc of CHART_OF_ACCOUNTS) {
        if (!acc.parent) continue;
        const parentId = idByCode.get(acc.parent);
        if (!parentId) throw new Error(`Account ${acc.code} names a parent ${acc.parent} that does not exist`);
        await prisma.ledgerAccount.update({ where: { code: acc.code }, data: { parentId } });
      }
      plan("parent links set");
    }

    // -------------------------------------------------- account mappings
    let mapCreated = 0;
    let mapExisting = 0;
    for (const [key, code] of Object.entries(DEFAULT_ACCOUNT_MAPPINGS)) {
      const accountId = idByCode.get(code);
      if (!accountId) {
        throw new Error(`Mapping ${key} points at missing account code ${code}`);
      }
      if (accountId === DRY_RUN_ID) {
        mapCreated++;
        continue;
      }
      const existing = await prisma.accountMapping.findUnique({ where: { key } });
      if (existing) {
        mapExisting++;
        // Do not silently repoint a mapping an accountant may have changed
        // on purpose. Only report the divergence.
        if (existing.accountId !== accountId) {
          log(`  ! mapping ${key} points elsewhere than the default (${code}) — left as-is`);
        }
      } else {
        mapCreated++;
        if (APPLY) {
          await prisma.accountMapping.create({
            data: { key, accountId, description: `Default mapping to ${code}` },
          });
        }
      }
    }
    plan(`mappings: ${mapCreated} to create, ${mapExisting} already set`);

    // -------------------------------------------------- financial periods
    const fyStartMonth = company?.fyStartMonth ?? 4;
    const targetFy = FY_ARG ?? financialYearOf(new Date(), fyStartMonth);
    if (company) {
      const periods = periodsForYear(targetFy, fyStartMonth);
      let periodsCreated = 0;
      for (const p of periods) {
        const existing = await prisma.financialPeriod.findUnique({
          where: {
            companyId_financialYear_periodNumber: {
              companyId: company.id,
              financialYear: p.financialYear,
              periodNumber: p.periodNumber,
            },
          },
        });
        if (existing) continue;
        periodsCreated++;
        if (APPLY) {
          await prisma.financialPeriod.create({
            data: {
              companyId: company.id,
              financialYear: p.financialYear,
              periodNumber: p.periodNumber,
              label: p.label,
              startDate: p.startDate,
              endDate: p.endDate,
            },
          });
        }
      }
      plan(
        `periods FY ${financialYearLabel(targetFy, fyStartMonth)}: ${periodsCreated} to create ` +
          `(${12 - periodsCreated} already open)`,
      );
    } else {
      plan("periods: skipped in dry run (no company row yet)");
    }

    // -------------------------------------------------------- tax rates
    //
    // Seeded UNVERIFIED on purpose. These mirror what Product.gstPercent
    // already says (5% on HSN 3101) rather than asserting anything new, and
    // the tax engine refuses to price an invoice from an unverified row — so
    // the gap is visible in the UI instead of silently becoming fact.
    const distinctHsn = await prisma.product.findMany({
      where: { isActive: true, hsnCode: { not: null } },
      select: { hsnCode: true, gstPercent: true },
      distinct: ["hsnCode"],
    });
    let ratesCreated = 0;
    for (const row of distinctHsn) {
      const hsnCode = row.hsnCode!;
      const existing = await prisma.taxRate.findFirst({ where: { hsnCode } });
      if (existing) continue;
      ratesCreated++;
      if (APPLY) {
        await prisma.taxRate.create({
          data: {
            hsnCode,
            ratePercent: row.gstPercent,
            treatment: "TAXABLE",
            effectiveFrom: new Date(targetFy, (fyStartMonth - 1) % 12, 1),
            isVerified: false,
            description: `Carried over from Product.gstPercent for HSN ${hsnCode}`,
            verifiedNote:
              "NOT VERIFIED. Rate and HSN classification copied from the product " +
              "catalogue, not confirmed by a tax professional. Organic-manure " +
              "classification is rate-sensitive, and all four products currently " +
              "share HSN 3101 including Liquid Humic Acid, which is worth a second " +
              "look. Invoicing stays blocked on this row until an accountant signs " +
              "it off.",
          },
        });
      }
    }
    plan(`tax rates: ${ratesCreated} to create (unverified), from ${distinctHsn.length} distinct HSN codes`);

    // ------------------------------------------------------- validation
    if (APPLY) {
      const mappings = await prisma.accountMapping.findMany({
        select: {
          key: true,
          account: { select: { code: true, name: true, isPostable: true, isActive: true } },
        },
      });
      const bad = mappings.filter((m) => !m.account.isPostable || !m.account.isActive);
      const expected = Object.keys(DEFAULT_ACCOUNT_MAPPINGS).length;

      log("");
      log(`Mappings present: ${mappings.length}/${expected}`);
      if (bad.length) {
        log("PROBLEM — these map to a non-postable or inactive account:");
        for (const m of bad) log(`  ${m.key} -> ${m.account.code} ${m.account.name}`);
        process.exitCode = 1;
      } else if (mappings.length < expected) {
        log("PROBLEM — some mappings are missing.");
        process.exitCode = 1;
      } else {
        log("All account mappings resolve to active, postable accounts.");
      }

      const co = await prisma.company.findFirst({ where: { isActive: true } });
      if (co && !co.gstin) {
        log("");
        log("NEXT: the company has no GSTIN, address or bank details.");
        log("      Fill these in before raising an invoice — they print on it,");
        log("      and nothing here will invent them.");
      }
    }

    log("");
    log(APPLY ? "Done." : "Dry run complete — nothing written. Re-run with --apply.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
