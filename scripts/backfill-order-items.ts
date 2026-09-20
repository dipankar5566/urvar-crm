/**
 * Backfills OrderItem for orders created before Phase 2 existed.
 *
 * updateQuotationStatus()'s ACCEPTED branch has always created an Order with
 * a single totalAmount and no lines — OrderItem did not exist until this
 * migration. Every such Order links back to the Quotation it was accepted
 * from, and that quotation's QuotationItem rows are the exact lines that were
 * sold; this just copies them across so the order becomes invoiceable.
 *
 * Idempotent: an order that already has items is skipped. Only touches
 * orders with zero items AND a linked quotation — an order created directly
 * (no quotationId) has no source to backfill from and is left alone,
 * uninvoiceable until someone re-creates it properly.
 *
 *   npx tsx scripts/backfill-order-items.ts            dry run
 *   npx tsx scripts/backfill-order-items.ts --apply    writes
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const candidates = await prisma.order.findMany({
      where: { items: { none: {} }, quotationId: { not: null } },
      include: { quotation: { include: { items: true } } },
    });

    console.log(APPLY ? "APPLYING backfill\n" : "DRY RUN — pass --apply to write\n");
    console.log(`${candidates.length} order(s) with no items and a linked quotation.\n`);

    for (const order of candidates) {
      const qItems = order.quotation?.items ?? [];
      if (qItems.length === 0) {
        console.log(`  ! ${order.orderNumber}: linked quotation has no items either — skipped`);
        continue;
      }
      console.log(`  ${APPLY ? "✓" : "·"} ${order.orderNumber}: backfill ${qItems.length} line(s) from ${order.quotation!.quotationNumber}`);
      if (APPLY) {
        await prisma.orderItem.createMany({
          data: qItems.map((qi, i) => ({
            orderId: order.id,
            productId: qi.productId,
            description: qi.description ?? `Line ${i + 1}`,
            quantity: qi.quantity,
            unitPrice: qi.unitPrice,
            lineTotal: qi.lineTotal,
            lineNumber: i + 1,
          })),
        });
      }
    }

    const skippedNoQuotation = await prisma.order.count({ where: { items: { none: {} }, quotationId: null } });
    if (skippedNoQuotation > 0) {
      console.log(
        `\n${skippedNoQuotation} order(s) have no items and no linked quotation — nothing to backfill ` +
          `from; these stay uninvoiceable until re-entered with lines.`,
      );
    }

    console.log(APPLY ? "\nDone." : "\nRe-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
