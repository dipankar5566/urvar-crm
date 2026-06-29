"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, scopeWhere } from "@/lib/permissions";
import {
  customerFormSchema,
  customerLocationSchema,
  type CustomerFormInput,
  type CustomerFormValues,
  type CustomerLocationInput,
} from "@/lib/validations/customer";
import { generateCustomerNumber } from "@/lib/id-sequences";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Shared by createCustomer and the bulk Excel importer (customers/import) so
 * both paths generate customerNumber/create/audit-log identically.
 */
export async function insertCustomerRecord(
  data: CustomerFormValues,
  assignedToId: string | null,
  actorId: string,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const customerNumber = await generateCustomerNumber();
      const customer = await prisma.customer.create({
        data: {
          customerNumber,
          name: data.name,
          companyName: data.companyName,
          contactPerson: data.contactPerson,
          customerType: data.customerType as never,
          phone: data.phone,
          whatsapp: data.whatsapp,
          email: data.email,
          state: data.state,
          district: data.district,
          pincode: data.pincode,
          address: data.address,
          gstNumber: data.gstNumber,
          panNumber: data.panNumber,
          creditLimit: data.creditLimit,
          outstandingAmount: data.outstandingAmount ?? 0,
          dealerTier: data.dealerTier as never,
          territoryAssigned: data.territoryAssigned,
          annualTargetValue: data.annualTargetValue,
          assignedToId,
        },
      });

      await logAudit({
        userId: actorId,
        action: "CREATE",
        entityType: "Customer",
        entityId: customer.id,
        newValue: { customerNumber: customer.customerNumber, name: customer.name },
      });

      return customer;
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("Could not create customer. Please try again.");
}

export async function createCustomer(input: CustomerFormInput): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "customers", "write");
  const parsed = customerFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  if (scope === "territory" && !user.territoryStates.includes(data.state)) {
    return { error: "You cannot create a customer outside your territory." };
  }

  let assignedToId: string | null = user.id;
  if (data.assignedToId) {
    if (scope !== "all" && scope !== "territory") {
      return { error: "You cannot assign customers to other users." };
    }
    assignedToId = data.assignedToId;
  }

  try {
    const customer = await insertCustomerRecord(data, assignedToId, user.id);
    revalidatePath("/customers");
    revalidatePath("/customers/distributors");
    revalidatePath("/dashboard");
    return { success: true, id: customer.id };
  } catch {
    return { error: "Could not create customer. Please try again." };
  }
}

export async function updateCustomer(
  customerId: string,
  input: CustomerFormInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "customers", "write");
  const parsed = customerFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Customer not found or access denied." };

  if (scope === "territory" && !user.territoryStates.includes(data.state)) {
    return { error: "You cannot move a customer outside your territory." };
  }

  let assignedToId = existing.assignedToId;
  const reassigning =
    data.assignedToId !== null && data.assignedToId !== existing.assignedToId;
  if (reassigning) {
    if (scope !== "all" && scope !== "territory") {
      return { error: "You cannot reassign this customer." };
    }
    assignedToId = data.assignedToId;
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: data.name,
      companyName: data.companyName,
      contactPerson: data.contactPerson,
      customerType: data.customerType as never,
      phone: data.phone,
      whatsapp: data.whatsapp,
      email: data.email,
      state: data.state,
      district: data.district,
      pincode: data.pincode,
      address: data.address,
      gstNumber: data.gstNumber,
      panNumber: data.panNumber,
      creditLimit: data.creditLimit,
      outstandingAmount: data.outstandingAmount ?? existing.outstandingAmount,
      dealerTier: data.dealerTier as never,
      territoryAssigned: data.territoryAssigned,
      annualTargetValue: data.annualTargetValue,
      assignedToId,
    },
  });

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");
  revalidatePath("/customers/distributors");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Customer",
    entityId: customerId,
    oldValue: existing,
    newValue: data,
  });

  return { success: true };
}

export async function updateCustomerLocation(
  customerId: string,
  input: CustomerLocationInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "customers", "write");
  const parsed = customerLocationSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid coordinates" };
  }
  const { latitude, longitude } = parsed.data;

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
    select: { id: true, latitude: true, longitude: true },
  });
  if (!existing) return { error: "Customer not found or access denied." };

  await prisma.customer.update({
    where: { id: customerId },
    data: { latitude, longitude },
  });

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Customer",
    entityId: customerId,
    oldValue: { latitude: existing.latitude, longitude: existing.longitude },
    newValue: { latitude, longitude },
  });

  revalidatePath(`/customers/${customerId}`);
  return { success: true };
}

export async function clearCustomerLocation(customerId: string): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "customers", "write");

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
    select: { id: true, latitude: true, longitude: true },
  });
  if (!existing) return { error: "Customer not found or access denied." };

  await prisma.customer.update({
    where: { id: customerId },
    data: { latitude: null, longitude: null },
  });

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Customer",
    entityId: customerId,
    oldValue: { latitude: existing.latitude, longitude: existing.longitude },
    newValue: { latitude: null, longitude: null },
  });

  revalidatePath(`/customers/${customerId}`);
  return { success: true };
}
