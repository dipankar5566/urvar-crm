"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import {
  createFixedAsset,
  postDepreciation,
  disposeFixedAsset,
  cancelDepreciationEntry,
  cancelFixedAsset,
  FixedAssetError,
} from "@/lib/accounting/fixed-assets";

type ActionResult = { error: string } | { success: true; fixedAssetId?: string; depreciationEntryId?: string };

const createSchema = z
  .object({
    name: z.string().min(1, "Asset name is required"),
    assetAccountId: z.string().min(1, "Select an asset category"),
    purchaseDate: z.string().min(1, "Purchase date is required"),
    cost: z.coerce.number().positive("Cost must be greater than zero"),
    depreciationRatePercent: z.coerce.number().min(0).max(100, "Depreciation rate must be between 0 and 100"),
    salvageValue: z.coerce.number().min(0).optional(),
    paidFromAccountId: z.string().optional(),
    sourcePurchaseInvoiceId: z.string().optional(),
  })
  .refine((d) => Boolean(d.paidFromAccountId) !== Boolean(d.sourcePurchaseInvoiceId), {
    message: "Provide exactly one of a payment account or a source purchase invoice.",
  });

export async function createFixedAssetAction(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await createFixedAsset({
      name: data.name,
      assetAccountId: data.assetAccountId,
      purchaseDate: new Date(data.purchaseDate),
      cost: data.cost,
      depreciationRatePercent: data.depreciationRatePercent,
      salvageValue: data.salvageValue ?? 0,
      paidFromAccountId: data.paidFromAccountId || undefined,
      sourcePurchaseInvoiceId: data.sourcePurchaseInvoiceId || undefined,
      createdById: user.id,
    });
    revalidatePath("/accounting/fixed-assets");
    return { success: true, fixedAssetId: result.fixedAssetId };
  } catch (err) {
    if (err instanceof FixedAssetError) return { error: err.message };
    throw err;
  }
}

const postDepreciationSchema = z.object({
  fixedAssetId: z.string().min(1),
  financialYear: z.coerce.number().int(),
  runDate: z.string().min(1, "Date is required"),
});

export async function postDepreciationAction(input: z.infer<typeof postDepreciationSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const parsed = postDepreciationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    const result = await postDepreciation({
      fixedAssetId: data.fixedAssetId,
      financialYear: data.financialYear,
      runDate: new Date(data.runDate),
      createdById: user.id,
    });
    revalidatePath(`/accounting/fixed-assets/${data.fixedAssetId}`);
    revalidatePath("/accounting/fixed-assets");
    return { success: true, depreciationEntryId: result.depreciationEntryId };
  } catch (err) {
    if (err instanceof FixedAssetError) return { error: err.message };
    throw err;
  }
}

const disposeSchema = z.object({
  fixedAssetId: z.string().min(1),
  disposalDate: z.string().min(1, "Date is required"),
  proceeds: z.coerce.number().min(0),
  proceedsAccountId: z.string().optional(),
  notes: z.string().optional(),
});

export async function disposeFixedAssetAction(input: z.infer<typeof disposeSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = disposeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  try {
    await disposeFixedAsset({
      fixedAssetId: data.fixedAssetId,
      disposalDate: new Date(data.disposalDate),
      proceeds: data.proceeds,
      proceedsAccountId: data.proceedsAccountId || undefined,
      notes: data.notes?.trim() || null,
      createdById: user.id,
    });
    revalidatePath(`/accounting/fixed-assets/${data.fixedAssetId}`);
    revalidatePath("/accounting/fixed-assets");
    return { success: true };
  } catch (err) {
    if (err instanceof FixedAssetError) return { error: err.message };
    throw err;
  }
}

const cancelDepreciationSchema = z.object({
  depreciationEntryId: z.string().min(1),
  fixedAssetId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the cancellation."),
});

export async function cancelDepreciationEntryAction(input: z.infer<typeof cancelDepreciationSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = cancelDepreciationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelDepreciationEntry({
      depreciationEntryId: parsed.data.depreciationEntryId,
      reason: parsed.data.reason,
      cancelledById: user.id,
    });
    revalidatePath(`/accounting/fixed-assets/${parsed.data.fixedAssetId}`);
    revalidatePath("/accounting/fixed-assets");
    return { success: true };
  } catch (err) {
    if (err instanceof FixedAssetError) return { error: err.message };
    throw err;
  }
}

const cancelAssetSchema = z.object({
  fixedAssetId: z.string().min(1),
  reason: z.string().min(3, "Give a reason for the cancellation."),
});

export async function cancelFixedAssetAction(input: z.infer<typeof cancelAssetSchema>): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const parsed = cancelAssetSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await cancelFixedAsset({ fixedAssetId: parsed.data.fixedAssetId, reason: parsed.data.reason, cancelledById: user.id });
    revalidatePath(`/accounting/fixed-assets/${parsed.data.fixedAssetId}`);
    revalidatePath("/accounting/fixed-assets");
    return { success: true };
  } catch (err) {
    if (err instanceof FixedAssetError) return { error: err.message };
    throw err;
  }
}
