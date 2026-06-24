/**
 * Wipes demo/seed data (Leads, Customers, and everything tied to them) while
 * leaving Users, Products, and auth tables untouched, so existing logins keep
 * working. Run via `npm run db:clean-demo`.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Deleting demo data (Leads, Customers, and dependent records)…");

  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.file.deleteMany();
  await prisma.quotationItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.quotation.deleteMany();
  await prisma.pipelineStageHistory.deleteMany();
  await prisma.pipeline.deleteMany();
  await prisma.leadActivity.deleteMany();
  await prisma.call.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.task.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.lead.deleteMany();

  const counts = {
    leads: await prisma.lead.count(),
    customers: await prisma.customer.count(),
    quotations: await prisma.quotation.count(),
    orders: await prisma.order.count(),
    calls: await prisma.call.count(),
    followUps: await prisma.followUp.count(),
    tasks: await prisma.task.count(),
    users: await prisma.user.count(),
    products: await prisma.product.count(),
  };
  console.log("Done. Remaining rows:", counts);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
