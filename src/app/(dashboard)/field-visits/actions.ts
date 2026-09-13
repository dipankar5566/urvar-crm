"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import {
  fieldVisitCheckInSchema,
  fieldVisitCheckOutSchema,
  type FieldVisitCheckInInput,
  type FieldVisitCheckOutInput,
} from "@/lib/validations/fieldvisit";
import { assertPhotoUploadAllowed, saveDocument, UploadRejected } from "@/lib/documents";
import { logAudit } from "@/lib/audit";

type ActionResult = { error: string } | { success: true; id?: string };

/**
 * Attaches an optional check-in photo.
 *
 * Two-step create-then-write, the same as the lead document flow: the File
 * row is created first so its cuid can name the file on disk, then filePath
 * is backfilled. Nothing user-supplied ever reaches the path.
 */
async function attachPhoto(visitId: string, photo: File, uploadedById: string): Promise<void> {
  assertPhotoUploadAllowed(photo);

  const record = await prisma.file.create({
    data: {
      fileName: photo.name,
      filePath: "",
      mimeType: photo.type,
      sizeBytes: photo.size,
      category: "FIELD_VISIT_PHOTO",
      relatedFieldVisitId: visitId,
      uploadedById,
    },
    select: { id: true },
  });

  const filePath = await saveDocument(
    record.id,
    photo.type,
    Buffer.from(await photo.arrayBuffer()),
  );
  await prisma.file.update({ where: { id: record.id }, data: { filePath } });
}

/**
 * Starts a visit against a lead or customer, stamping where the rep actually
 * is. Mirrors logCall's shape: the target is a discriminated union and each
 * branch re-checks that this user may see that record before writing.
 */
export async function checkIn(
  target: { leadId: string } | { customerId: string },
  input: FieldVisitCheckInInput,
  photo?: File | null,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "field_visits", "write");
  const parsed = fieldVisitCheckInSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  // One open visit at a time, or "check out" becomes ambiguous and the
  // duration of every visit stops meaning anything.
  const open = await prisma.fieldVisit.findFirst({
    where: { userId: user.id, checkOutAt: null },
    select: { id: true },
  });
  if (open) {
    return { error: "You already have an open visit. Check out of it first." };
  }

  let leadId: string | null = null;
  let customerId: string | null = null;

  if ("leadId" in target) {
    const leadScope = can(user.role, "leads", "read");
    const lead = await prisma.lead.findFirst({
      where: { id: target.leadId, ...scopeWhere(leadScope, user, "assignedToId") },
      select: { id: true },
    });
    if (!lead) return { error: "Lead not found or access denied." };
    leadId = lead.id;
  } else {
    const customerScope = can(user.role, "customers", "read");
    const customer = await prisma.customer.findFirst({
      where: { id: target.customerId, ...scopeWhere(customerScope, user, "assignedToId") },
      select: { id: true },
    });
    if (!customer) return { error: "Customer not found or access denied." };
    customerId = customer.id;
  }

  const visit = await prisma.fieldVisit.create({
    data: {
      leadId,
      customerId,
      userId: user.id,
      checkInLat: data.latitude,
      checkInLng: data.longitude,
      checkInAccuracy: data.accuracy,
      notes: data.notes,
    },
  });

  if (photo && photo.size > 0) {
    try {
      await attachPhoto(visit.id, photo, user.id);
    } catch (err) {
      // The visit itself is already recorded and is the thing that matters;
      // a rejected photo should not undo the check-in.
      const message =
        err instanceof UploadRejected ? err.message : "The photo could not be saved.";
      console.error(`[field-visits] photo failed for visit ${visit.id}:`, err);
      revalidatePath("/field-visits");
      return { error: `Checked in, but the photo was not saved: ${message}` };
    }
  }

  if (leadId) {
    await prisma.leadActivity.create({
      data: {
        leadId,
        type: "NOTE",
        description: `Field visit started${data.notes ? `: ${data.notes}` : "."}`,
        createdById: user.id,
      },
    });
    revalidatePath(`/leads/${leadId}`);
  }
  if (customerId) revalidatePath(`/customers/${customerId}`);
  revalidatePath("/field-visits");

  await logAudit({
    userId: user.id,
    action: "CHECK_IN",
    entityType: "FieldVisit",
    entityId: visit.id,
    newValue: { leadId, customerId, lat: data.latitude, lng: data.longitude },
  });

  return { success: true, id: visit.id };
}

/** Closes an open visit, stamping where the rep was when they left. */
export async function checkOut(
  visitId: string,
  input: FieldVisitCheckOutInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "field_visits", "write");
  const parsed = fieldVisitCheckOutSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.fieldVisit.findFirst({
    where: { id: visitId, ...scopeWhere(scope, user, "userId") },
  });
  if (!existing) return { error: "Visit not found or access denied." };
  if (existing.checkOutAt) return { error: "That visit is already checked out." };

  await prisma.fieldVisit.update({
    where: { id: visitId },
    data: {
      checkOutAt: new Date(),
      checkOutLat: data.latitude,
      checkOutLng: data.longitude,
      checkOutAccuracy: data.accuracy,
      // Notes typed at check-out are appended, never silently replacing what
      // was written on the way in.
      notes: data.notes
        ? existing.notes
          ? `${existing.notes}\n${data.notes}`
          : data.notes
        : existing.notes,
    },
  });

  if (existing.leadId) revalidatePath(`/leads/${existing.leadId}`);
  if (existing.customerId) revalidatePath(`/customers/${existing.customerId}`);
  revalidatePath("/field-visits");

  await logAudit({
    userId: user.id,
    action: "CHECK_OUT",
    entityType: "FieldVisit",
    entityId: visitId,
    newValue: { lat: data.latitude, lng: data.longitude },
  });

  return { success: true };
}
