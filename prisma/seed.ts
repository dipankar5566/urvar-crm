/**
 * Seed script for Urvar CRM.
 *
 * Run via `npm run db:seed` (configured as `tsx prisma/seed.ts` in
 * prisma.config.ts). Uses RELATIVE imports + a standalone Prisma client and a
 * cookie-less Better Auth instance, because tsx does not resolve the "@/"
 * tsconfig path alias and the Next cookies plugin needs a request context.
 */
import "dotenv/config";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const seedAuth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
});

// ---------- helpers ----------
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(arr: readonly T[]): T => arr[rand(arr.length)];
const pickMany = <T>(arr: readonly T[], n: number): T[] =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const daysAgo = (d: number) =>
  new Date(Date.now() - d * 24 * 60 * 60 * 1000);
const daysFromNow = (d: number) =>
  new Date(Date.now() + d * 24 * 60 * 60 * 1000);
const pad = (n: number, len = 4) => String(n).padStart(len, "0");

const TERRITORIES: Record<string, string[]> = {
  "West Bengal": ["Nadia", "Hooghly", "Bardhaman", "Murshidabad", "North 24 Parganas"],
  Maharashtra: ["Pune", "Nashik", "Kolhapur", "Nagpur", "Ahmednagar"],
  Karnataka: ["Belagavi", "Mysuru", "Shivamogga", "Dharwad", "Tumakuru"],
  "Uttar Pradesh": ["Meerut", "Lucknow", "Varanasi", "Agra", "Bareilly"],
};
const STATES = Object.keys(TERRITORIES);

const LEAD_SOURCES = [
  "WEBSITE", "META_ADS", "GOOGLE_ADS", "TRADE_SHOW", "REFERRAL",
  "DISTRIBUTOR", "DIRECT_CALL", "WHATSAPP", "ORGANIC_SEARCH",
] as const;
const LEAD_STATUSES = [
  "NEW", "CONTACTED", "INTERESTED", "FOLLOW_UP",
  "QUOTATION_SENT", "NEGOTIATION", "WON", "LOST",
] as const;
const CUSTOMER_TYPES = [
  "B2C_FARMER", "B2B_RETAILER", "B2B_DEALER", "B2B_DISTRIBUTOR",
  "AGRI_INPUT_SHOP", "FPO_COOPERATIVE", "CORPORATE_FARM",
] as const;
const STATUS_TO_STAGE: Record<string, string> = {
  NEW: "NEW_LEAD",
  CONTACTED: "FIRST_CONTACT",
  INTERESTED: "PRODUCT_DISCUSSION",
  FOLLOW_UP: "REQUIREMENT_GATHERING",
  QUOTATION_SENT: "QUOTATION_SENT",
  NEGOTIATION: "NEGOTIATION",
  WON: "WON",
  LOST: "LOST",
};
const CROPS = ["Rice", "Wheat", "Sugarcane", "Cotton", "Potato", "Tea", "Banana", "Vegetables"];
const FIRST_NAMES = ["Ramesh", "Suresh", "Anil", "Vijay", "Manoj", "Deepak", "Sanjay", "Prakash", "Ravi", "Gopal", "Kishore", "Mahesh", "Naresh", "Dinesh", "Subhash"];
const LAST_NAMES = ["Patil", "Sharma", "Yadav", "Reddy", "Naik", "Das", "Ghosh", "Kulkarni", "Singh", "Verma", "Gowda", "Mondal", "Pawar", "Chauhan"];
const COMPANY_SUFFIX = ["Agro", "Krishi Kendra", "Agri Solutions", "Farms", "Traders", "Agencies", "Enterprises", "Agritech"];

const PRODUCTS = [
  { sku: "URV-VC-50", name: "Urvar Vermicompost", category: "VERMICOMPOST", unit: "50kg bag", packSize: "50 kg", mrp: 450, dealerPrice: 380, distributorPrice: 340, hsn: "31010099", gst: 5 },
  { sku: "URV-PROM-50", name: "Urvar PROM (Phosphate Rich Organic Manure)", category: "PROM", unit: "50kg bag", packSize: "50 kg", mrp: 650, dealerPrice: 560, distributorPrice: 510, hsn: "31010099", gst: 5 },
  { sku: "URV-HA-25", name: "Urvar Humic Acid Granules", category: "HUMIC_ACID", unit: "25kg bag", packSize: "25 kg", mrp: 1200, dealerPrice: 1040, distributorPrice: 950, hsn: "38249990", gst: 12 },
  { sku: "URV-ONPK-50", name: "Urvar Organic NPK Fertilizer", category: "ORGANIC_FERTILIZER", unit: "50kg bag", packSize: "50 kg", mrp: 980, dealerPrice: 850, distributorPrice: 780, hsn: "31051000", gst: 5 },
  { sku: "URV-MN-1", name: "Urvar Micronutrient Mix (Zn+Fe+B)", category: "MICRONUTRIENT", unit: "1kg pack", packSize: "1 kg", mrp: 320, dealerPrice: 270, distributorPrice: 245, hsn: "38249990", gst: 12 },
  { sku: "URV-SC-25", name: "Urvar Soil Conditioner Plus", category: "SOIL_CONDITIONER", unit: "25kg bag", packSize: "25 kg", mrp: 750, dealerPrice: 640, distributorPrice: 585, hsn: "38249990", gst: 5 },
  { sku: "URV-BIO-1", name: "Urvar Bio NPK Consortia", category: "BIO_FERTILIZER", unit: "1L can", packSize: "1 litre", mrp: 480, dealerPrice: 410, distributorPrice: 375, hsn: "31010099", gst: 5 },
  { sku: "URV-CN-500", name: "Urvar Crop Nutrition Booster", category: "CROP_NUTRITION", unit: "500ml bottle", packSize: "500 ml", mrp: 390, dealerPrice: 330, distributorPrice: 300, hsn: "38089390", gst: 18 },
];

const USERS = [
  { name: "Admin User", email: "admin@urvar.in", role: "SUPER_ADMIN", phone: "9830000001", states: STATES },
  { name: "Rajesh Mehta", email: "rajesh.manager@urvar.in", role: "SALES_MANAGER", phone: "9830000002", states: STATES },
  { name: "Priya Sharma", email: "priya.sales@urvar.in", role: "SALES_EXECUTIVE", phone: "9830000003", states: ["West Bengal", "Maharashtra", "Karnataka", "Uttar Pradesh"] },
  { name: "Amit Kulkarni", email: "amit.distributor@urvar.in", role: "DISTRIBUTOR_MANAGER", phone: "9830000004", states: ["Maharashtra", "Karnataka"] },
  { name: "Sunita Rao", email: "sunita.accounts@urvar.in", role: "ACCOUNTS_TEAM", phone: "9830000005", states: STATES },
];
const PASSWORD = "Urvar@123";

async function main() {
  console.log("Clearing existing data…");
  // Delete in FK-safe order.
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
  await prisma.product.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.verification.deleteMany();
  await prisma.user.deleteMany();

  // ---------- Users ----------
  console.log("Creating users…");
  const userIdByEmail: Record<string, string> = {};
  for (const u of USERS) {
    await seedAuth.api.signUpEmail({
      body: { email: u.email, password: PASSWORD, name: u.name },
    });
    const updated = await prisma.user.update({
      where: { email: u.email },
      data: {
        role: u.role as never,
        phone: u.phone,
        territoryStates: u.states,
        emailVerified: true,
      },
    });
    userIdByEmail[u.email] = updated.id;
  }
  const managerId = userIdByEmail["rajesh.manager@urvar.in"];
  const salesId = userIdByEmail["priya.sales@urvar.in"];
  const distId = userIdByEmail["amit.distributor@urvar.in"];
  const salesUsers = [salesId, managerId];

  // ---------- Products ----------
  console.log("Creating products…");
  const products = [];
  for (const p of PRODUCTS) {
    const created = await prisma.product.create({
      data: {
        sku: p.sku,
        name: p.name,
        category: p.category as never,
        unit: p.unit,
        packSize: p.packSize,
        hsnCode: p.hsn,
        mrp: p.mrp,
        dealerPrice: p.dealerPrice,
        distributorPrice: p.distributorPrice,
        gstPercent: p.gst,
      },
    });
    products.push(created);
  }

  // ---------- Leads (+ pipeline, activity) ----------
  console.log("Creating leads…");
  const leads = [];
  for (let i = 1; i <= 40; i++) {
    const state = pick(STATES);
    const district = pick(TERRITORIES[state]);
    const status = pick(LEAD_STATUSES);
    const ctype = pick(CUSTOMER_TYPES);
    const contact = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const isCompany = ctype !== "B2C_FARMER";
    const created = daysAgo(rand(120));
    const lead = await prisma.lead.create({
      data: {
        leadNumber: `LD-2026-${pad(i)}`,
        name: contact,
        contactPerson: contact,
        companyName: isCompany ? `${pick(LAST_NAMES)} ${pick(COMPANY_SUFFIX)}` : null,
        phone: `98${pad(rand(100000000), 8)}`,
        whatsapp: `98${pad(rand(100000000), 8)}`,
        email: Math.random() > 0.5 ? `lead${i}@example.com` : null,
        state,
        district,
        pincode: `${700000 + rand(99999)}`,
        source: pick(LEAD_SOURCES) as never,
        status: status as never,
        customerType: ctype as never,
        interestedProducts: pickMany(PRODUCTS, 1 + rand(3)).map((p) => p.name).join(", "),
        expectedQuantity: `${(1 + rand(20)) * 5} bags / month`,
        expectedMonthlyValue: (1 + rand(20)) * 5000,
        estimatedValue: (5 + rand(50)) * 10000,
        cropInterest: pick(CROPS),
        isGovernmentTender: Math.random() > 0.92,
        remarks: "Imported from seed data.",
        assignedToId: Math.random() > 0.15 ? pick(salesUsers) : null,
        createdAt: created,
      },
    });

    await prisma.pipeline.create({
      data: {
        leadId: lead.id,
        stage: STATUS_TO_STAGE[status] as never,
        enteredStageAt: created,
        expectedCloseDate: daysFromNow(rand(60)),
        probability: status === "WON" ? 100 : status === "LOST" ? 0 : 20 + rand(60),
        stageHistory: {
          create: {
            toStage: STATUS_TO_STAGE[status] as never,
            movedById: lead.assignedToId ?? managerId,
            movedAt: created,
          },
        },
      },
    });

    await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: "NOTE",
        description: `Lead created from ${lead.source}.`,
        createdById: lead.assignedToId ?? managerId,
        createdAt: created,
      },
    });

    leads.push(lead);
  }

  // ---------- Customers (some converted from leads) ----------
  console.log("Creating customers…");
  const customers = [];
  const wonLeads = leads.filter((l) => l.status === "WON");
  let custNum = 1;
  // Convert won leads to customers
  for (const l of wonLeads) {
    const dealerType = ["B2B_DEALER", "B2B_DISTRIBUTOR"].includes(l.customerType);
    const c = await prisma.customer.create({
      data: {
        customerNumber: `CUST-${pad(custNum++)}`,
        name: l.name,
        companyName: l.companyName,
        contactPerson: l.contactPerson,
        customerType: l.customerType,
        phone: l.phone,
        whatsapp: l.whatsapp,
        email: l.email,
        state: l.state,
        district: l.district,
        pincode: l.pincode,
        gstNumber: dealerType ? `27ABCDE${1000 + rand(8999)}F1Z5` : null,
        creditLimit: dealerType ? (5 + rand(20)) * 100000 : null,
        outstandingAmount: dealerType ? rand(5) * 25000 : 0,
        dealerTier: dealerType ? (pick(["GOLD", "SILVER", "BRONZE"]) as never) : null,
        territoryAssigned: dealerType ? l.district : null,
        annualTargetValue: dealerType ? (10 + rand(40)) * 100000 : null,
        assignedToId: l.assignedToId ?? salesId,
        sourceLeadId: l.id,
      },
    });
    await prisma.lead.update({
      where: { id: l.id },
      data: { convertedAt: new Date() },
    });
    customers.push(c);
  }
  // Standalone distributors/dealers to ensure a healthy distributor book
  const extraTypes = ["B2B_DISTRIBUTOR", "B2B_DEALER", "B2B_DISTRIBUTOR", "B2B_DEALER", "AGRI_INPUT_SHOP", "FPO_COOPERATIVE"] as const;
  for (let i = 0; i < 16; i++) {
    const state = pick(STATES);
    const district = pick(TERRITORIES[state]);
    const ctype = i < extraTypes.length ? extraTypes[i] : pick(CUSTOMER_TYPES);
    const dealerType = ["B2B_DEALER", "B2B_DISTRIBUTOR"].includes(ctype);
    const contact = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const c = await prisma.customer.create({
      data: {
        customerNumber: `CUST-${pad(custNum++)}`,
        name: contact,
        companyName: `${pick(LAST_NAMES)} ${pick(COMPANY_SUFFIX)}`,
        contactPerson: contact,
        customerType: ctype as never,
        phone: `98${pad(rand(100000000), 8)}`,
        state,
        district,
        gstNumber: dealerType ? `27ABCDE${1000 + rand(8999)}F1Z5` : null,
        creditLimit: dealerType ? (5 + rand(20)) * 100000 : null,
        outstandingAmount: dealerType ? rand(6) * 25000 : 0,
        dealerTier: dealerType ? (pick(["GOLD", "SILVER", "BRONZE"]) as never) : null,
        territoryAssigned: dealerType ? district : null,
        annualTargetValue: dealerType ? (10 + rand(40)) * 100000 : null,
        assignedToId: dealerType ? distId : salesId,
      },
    });
    customers.push(c);
  }

  // ---------- Quotations (+ items) ----------
  console.log("Creating quotations…");
  const QUOTE_STATUSES = ["DRAFT", "SENT", "SENT", "ACCEPTED", "ACCEPTED", "REJECTED"] as const;
  const quotations = [];
  for (let i = 1; i <= 14; i++) {
    const customer = pick(customers);
    const status = pick(QUOTE_STATUSES);
    const lineProducts = pickMany(products, 2 + rand(3));
    let subtotal = 0;
    const itemsData = lineProducts.map((p) => {
      const qty = (1 + rand(20)) * 5;
      const unitPrice = Number(p.dealerPrice ?? p.mrp);
      const lineTotal = qty * unitPrice;
      subtotal += lineTotal;
      return {
        productId: p.id,
        description: p.name,
        quantity: qty,
        unitPrice,
        lineTotal,
      };
    });
    const discountPercent = pick([0, 0, 2, 5, 10]);
    const discountAmount = Math.round((subtotal * discountPercent) / 100);
    const taxable = subtotal - discountAmount;
    const taxAmount = Math.round(taxable * 0.05);
    const freight = pick([0, 500, 1000, 1500]);
    const total = taxable + taxAmount + freight;
    const created = daysAgo(rand(60));

    const q = await prisma.quotation.create({
      data: {
        quotationNumber: `QT-2026-${pad(i)}`,
        customerId: customer.id,
        createdById: pick(salesUsers),
        status: status as never,
        validUntil: daysFromNow(15),
        subtotal,
        discountPercent,
        discountAmount,
        freightAmount: freight,
        taxAmount,
        totalAmount: total,
        termsAndConditions: "Payment within 30 days. Goods once sold will not be taken back.",
        sentAt: status === "DRAFT" ? null : created,
        respondedAt: ["ACCEPTED", "REJECTED"].includes(status) ? daysAgo(rand(20)) : null,
        createdAt: created,
        items: { create: itemsData },
      },
    });
    quotations.push({ ...q, customer, total });
  }

  // ---------- Orders (from accepted quotations) ----------
  console.log("Creating orders…");
  const accepted = quotations.filter((q) => q.status === "ACCEPTED");
  let orderNum = 1;
  for (const q of accepted) {
    await prisma.order.create({
      data: {
        orderNumber: `ORD-2026-${pad(orderNum++)}`,
        quotationId: q.id,
        customerId: q.customer.id,
        totalAmount: q.total,
        status: pick(["CONFIRMED", "DELIVERED"]) as never,
        paymentStatus: pick(["PENDING", "PARTIAL", "PAID"]) as never,
        state: q.customer.state,
        district: q.customer.district,
        createdById: q.createdById,
        orderedAt: daysAgo(rand(15)),
      },
    });
  }

  // ---------- Calls ----------
  console.log("Creating calls…");
  const CALL_OUTCOMES = ["CONNECTED", "NOT_REACHABLE", "BUSY", "INTERESTED", "FOLLOW_UP_REQUIRED", "QUOTATION_REQUESTED"] as const;
  for (let i = 0; i < 24; i++) {
    const lead = pick(leads);
    await prisma.call.create({
      data: {
        leadId: lead.id,
        userId: lead.assignedToId ?? salesId,
        direction: pick(["INBOUND", "OUTBOUND"]) as never,
        outcome: pick(CALL_OUTCOMES) as never,
        durationSeconds: rand(600),
        notes: "Discussed product requirement and pricing.",
        calledAt: daysAgo(rand(30)),
      },
    });
  }

  // ---------- Follow-ups ----------
  console.log("Creating follow-ups…");
  for (let i = 0; i < 18; i++) {
    const lead = pick(leads);
    const r = Math.random();
    // Mix of overdue, due-today, future, and completed
    let dueAt: Date;
    let status: string;
    if (r < 0.3) { dueAt = daysAgo(1 + rand(5)); status = "PENDING"; } // overdue
    else if (r < 0.45) { dueAt = new Date(); status = "PENDING"; } // today
    else if (r < 0.75) { dueAt = daysFromNow(1 + rand(10)); status = "PENDING"; }
    else { dueAt = daysAgo(rand(10)); status = "COMPLETED"; }
    await prisma.followUp.create({
      data: {
        leadId: lead.id,
        assignedToId: lead.assignedToId ?? salesId,
        dueAt,
        priority: pick(["LOW", "MEDIUM", "HIGH"]) as never,
        status: status as never,
        notes: "Follow up on quotation / requirement.",
        completedAt: status === "COMPLETED" ? dueAt : null,
      },
    });
  }

  // ---------- Tasks ----------
  console.log("Creating tasks…");
  const TASK_TITLES = ["Send product catalogue", "Arrange sample dispatch", "Visit dealer", "Confirm payment", "Prepare quotation", "Schedule demo at farm"];
  for (let i = 0; i < 12; i++) {
    const lead = pick(leads);
    await prisma.task.create({
      data: {
        title: pick(TASK_TITLES),
        description: "Auto-generated demo task.",
        assignedToId: pick(salesUsers),
        assignedById: managerId,
        relatedLeadId: lead.id,
        dueAt: daysFromNow(rand(14) - 3),
        priority: pick(["LOW", "MEDIUM", "HIGH"]) as never,
        status: pick(["OPEN", "OPEN", "IN_PROGRESS", "DONE"]) as never,
      },
    });
  }

  // ---------- Notifications ----------
  await prisma.notification.createMany({
    data: [
      { userId: salesId, type: "FOLLOWUP_DUE", title: "3 follow-ups due today", body: "Check your follow-up list." },
      { userId: salesId, type: "LEAD_ASSIGNED", title: "New lead assigned", body: "A new lead was assigned to you." },
      { userId: managerId, type: "QUOTATION_RESPONSE", title: "Quotation accepted", body: "A customer accepted a quotation." },
    ],
  });

  const counts = {
    users: await prisma.user.count(),
    products: await prisma.product.count(),
    leads: await prisma.lead.count(),
    customers: await prisma.customer.count(),
    quotations: await prisma.quotation.count(),
    orders: await prisma.order.count(),
    calls: await prisma.call.count(),
    followUps: await prisma.followUp.count(),
    tasks: await prisma.task.count(),
  };
  console.log("Seed complete:", counts);
  console.log(`\nLogin with any account below (password: ${PASSWORD})`);
  USERS.forEach((u) => console.log(`  ${u.role.padEnd(20)} ${u.email}`));
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
