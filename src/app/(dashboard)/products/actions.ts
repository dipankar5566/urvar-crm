"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { productFormSchema, type ProductFormInput } from "@/lib/validations/product";
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

export async function createProduct(input: ProductFormInput): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "products", "write");
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  try {
    const product = await prisma.product.create({
      data: {
        sku: data.sku,
        name: data.name,
        category: data.category as never,
        hsnCode: data.hsnCode,
        description: data.description,
        unit: data.unit,
        packSize: data.packSize,
        mrp: data.mrp,
        dealerPrice: data.dealerPrice,
        distributorPrice: data.distributorPrice,
        gstPercent: data.gstPercent,
        isActive: data.isActive,
      },
    });
    revalidatePath("/products");

    await logAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "Product",
      entityId: product.id,
      newValue: { sku: product.sku, name: product.name },
    });

    return { success: true, id: product.id };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A product with this SKU already exists." };
    }
    throw err;
  }
}

export async function updateProduct(
  productId: string,
  input: ProductFormInput,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "products", "write");
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.product.findUnique({ where: { id: productId } });
  if (!existing) return { error: "Product not found." };

  try {
    await prisma.product.update({
      where: { id: productId },
      data: {
        sku: data.sku,
        name: data.name,
        category: data.category as never,
        hsnCode: data.hsnCode,
        description: data.description,
        unit: data.unit,
        packSize: data.packSize,
        mrp: data.mrp,
        dealerPrice: data.dealerPrice,
        distributorPrice: data.distributorPrice,
        gstPercent: data.gstPercent,
        isActive: data.isActive,
      },
    });
    revalidatePath("/products");

    await logAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Product",
      entityId: productId,
      oldValue: existing,
      newValue: data,
    });

    return { success: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A product with this SKU already exists." };
    }
    throw err;
  }
}

export async function setProductActive(
  productId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "products", "write");

  const existing = await prisma.product.findUnique({ where: { id: productId } });
  if (!existing) return { error: "Product not found." };

  await prisma.product.update({ where: { id: productId }, data: { isActive } });
  revalidatePath("/products");

  await logAudit({
    userId: user.id,
    action: isActive ? "ACTIVATE" : "DEACTIVATE",
    entityType: "Product",
    entityId: productId,
    oldValue: { isActive: existing.isActive },
    newValue: { isActive },
  });

  return { success: true };
}
