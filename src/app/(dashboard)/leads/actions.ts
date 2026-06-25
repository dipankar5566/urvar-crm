"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, scopeWhere } from "@/lib/permissions";
import {
  leadFormSchema,
  leadStatusSchema,
  type LeadFormInput,
  type LeadFormValues,
  type LeadStatusInput,
} from "@/lib/validations/lead";
import { generateCustomerNumber, generateLeadNumber } from "@/lib/id-sequences";
import { STAGE_TO_STATUS, PIPELINE_STAGE_LABELS } from "@/lib/constants/labels";
import { notifyUser } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

type ActionResult =
  | { error: string }
  | { success: true; id?: string; customerNumber?: string };

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function insertLeadRecord(
  data: LeadFormValues,
  assignedToId: string | null,
  actorId: string,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const leadNumber = await generateLeadNumber();
      const lead = await prisma.lead.create({
        data: {
          leadNumber,
          name: data.name,
          companyName: data.companyName,
          contactPerson: data.contactPerson,
          phone: data.phone,
          whatsapp: data.whatsapp,
          email: data.email,
          state: data.state,
          district: data.district,
          pincode: data.pincode,
          address: data.address,
          source: data.source as never,
          customerType: data.customerType as never,
          interestedProducts: data.interestedProducts,
          expectedQuantity: data.expectedQuantity,
          expectedMonthlyValue: data.expectedMonthlyValue,
          estimatedValue: data.estimatedValue,
          cropInterest: data.cropInterest,
          isGovernmentTender: data.isGovernmentTender,
          remarks: data.remarks,
          assignedToId,
          pipeline: { create: { stage: "NEW_LEAD" } },
          activities: {
            create: {
              type: "STATUS_CHANGE",
              description: "Lead created.",
              createdById: actorId,
            },
          },
        },
      });

      await logAudit({
        userId: actorId,
        action: "CREATE",
        entityType: "Lead",
        entityId: lead.id,
        newValue: { leadNumber: lead.leadNumber, name: lead.name, assignedToId },
      });

      return lead;
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("Could not create lead. Please try again.");
}

export async function createLead(input: LeadFormInput): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");
  const parsed = leadFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  let assignedToId: string | null = user.id;
  if (data.assignedToId) {
    if (scope !== "all" && scope !== "territory") {
      return { error: "You cannot assign leads to other users." };
    }
    assignedToId = data.assignedToId;
  }

  try {
    const lead = await insertLeadRecord(data, assignedToId, user.id);

    revalidatePath("/leads");
    revalidatePath("/pipeline");
    revalidatePath("/dashboard");

    if (assignedToId) {
      await notifyUser({
        userId: assignedToId,
        actingUserId: user.id,
        type: "LEAD_ASSIGNED",
        title: `New lead assigned: ${lead.name}`,
        body: `${user.name} assigned you lead ${lead.leadNumber}.`,
        relatedLeadId: lead.id,
      });
    }

    return { success: true, id: lead.id };
  } catch {
    return { error: "Could not create lead. Please try again." };
  }
}

export async function updateLead(
  leadId: string,
  input: LeadFormInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");
  const parsed = leadFormSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Lead not found or access denied." };

  let assignedToId = existing.assignedToId;
  const reassigning =
    data.assignedToId !== null && data.assignedToId !== existing.assignedToId;
  if (reassigning) {
    if (scope !== "all" && scope !== "territory") {
      return { error: "You cannot reassign this lead." };
    }
    assignedToId = data.assignedToId;
  }

  await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: {
        name: data.name,
        companyName: data.companyName,
        contactPerson: data.contactPerson,
        phone: data.phone,
        whatsapp: data.whatsapp,
        email: data.email,
        state: data.state,
        district: data.district,
        pincode: data.pincode,
        address: data.address,
        source: data.source as never,
        customerType: data.customerType as never,
        interestedProducts: data.interestedProducts,
        expectedQuantity: data.expectedQuantity,
        expectedMonthlyValue: data.expectedMonthlyValue,
        estimatedValue: data.estimatedValue,
        cropInterest: data.cropInterest,
        isGovernmentTender: data.isGovernmentTender,
        remarks: data.remarks,
        assignedToId,
      },
    }),
    prisma.leadActivity.create({
      data: {
        leadId,
        type: reassigning ? "LEAD_ASSIGNED" : "NOTE",
        description: reassigning
          ? "Lead reassigned."
          : "Lead details updated.",
        createdById: user.id,
      },
    }),
  ]);

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Lead",
    entityId: leadId,
    oldValue: existing,
    newValue: data,
  });

  if (reassigning && assignedToId) {
    await notifyUser({
      userId: assignedToId,
      actingUserId: user.id,
      type: "LEAD_ASSIGNED",
      title: `Lead reassigned to you: ${data.name}`,
      body: `${user.name} reassigned lead ${existing.leadNumber} to you.`,
      relatedLeadId: leadId,
    });
  }

  return { success: true };
}

export async function updateLeadStatus(
  leadId: string,
  input: LeadStatusInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");
  const parsed = leadStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Lead not found or access denied." };

  await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: {
        status: data.status as never,
        lostReason: data.status === "LOST" ? data.lostReason : null,
      },
    }),
    prisma.leadActivity.create({
      data: {
        leadId,
        type: "STATUS_CHANGE",
        description: `Status changed to ${data.status}.`,
        createdById: user.id,
      },
    }),
  ]);

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "STATUS_CHANGE",
    entityType: "Lead",
    entityId: leadId,
    oldValue: { status: existing.status },
    newValue: { status: data.status, lostReason: data.lostReason },
  });

  return { success: true };
}

export async function updateLeadAssignee(
  leadId: string,
  assignedToId: string | null,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");

  const existing = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Lead not found or access denied." };

  if (assignedToId === existing.assignedToId) return { success: true };

  // Same restriction updateLead() already applies to reassignment, extended
  // to cover unassignment too — both are "change of ownership."
  if (scope !== "all" && scope !== "territory") {
    return { error: "You cannot reassign this lead." };
  }

  if (assignedToId) {
    const rep = await prisma.user.findFirst({
      where: { id: assignedToId, isActive: true },
      select: { id: true },
    });
    if (!rep) return { error: "Selected user not found or inactive." };
  }

  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { assignedToId } }),
    prisma.leadActivity.create({
      data: {
        leadId,
        type: "LEAD_ASSIGNED",
        description: assignedToId ? "Lead reassigned." : "Lead unassigned.",
        createdById: user.id,
      },
    }),
  ]);

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Lead",
    entityId: leadId,
    oldValue: { assignedToId: existing.assignedToId },
    newValue: { assignedToId },
  });

  if (assignedToId) {
    await notifyUser({
      userId: assignedToId,
      actingUserId: user.id,
      type: "LEAD_ASSIGNED",
      title: `Lead reassigned to you: ${existing.name}`,
      body: `${user.name} reassigned lead ${existing.leadNumber} to you.`,
      relatedLeadId: leadId,
    });
  }

  return { success: true };
}

export async function addLeadNote(
  leadId: string,
  note: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");
  const trimmed = note.trim();
  if (!trimmed) return { error: "Note cannot be empty." };

  const existing = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!existing) return { error: "Lead not found or access denied." };

  await prisma.leadActivity.create({
    data: {
      leadId,
      type: "NOTE",
      description: trimmed,
      createdById: user.id,
    },
  });

  revalidatePath(`/leads/${leadId}`);
  return { success: true };
}

export async function updateLeadStage(
  leadId: string,
  toStage: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "pipeline", "write");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
    include: { pipeline: true },
  });
  if (!lead || !lead.pipeline) return { error: "Lead not found or access denied." };

  const fromStage = lead.pipeline.stage;
  if (fromStage === toStage) return { success: true };

  const newStatus = STAGE_TO_STATUS[toStage] ?? lead.status;
  const stageLabel = PIPELINE_STAGE_LABELS[toStage] ?? toStage;

  await prisma.$transaction([
    prisma.pipeline.update({
      where: { leadId },
      data: { stage: toStage as never, enteredStageAt: new Date() },
    }),
    prisma.pipelineStageHistory.create({
      data: {
        pipelineId: lead.pipeline.id,
        fromStage: fromStage as never,
        toStage: toStage as never,
        movedById: user.id,
      },
    }),
    prisma.lead.update({
      where: { id: leadId },
      data: { status: newStatus as never },
    }),
    prisma.leadActivity.create({
      data: {
        leadId,
        type: "STAGE_CHANGE",
        description: `Stage moved to ${stageLabel}.`,
        createdById: user.id,
      },
    }),
  ]);

  revalidatePath("/pipeline");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");

  await logAudit({
    userId: user.id,
    action: "STAGE_CHANGE",
    entityType: "Lead",
    entityId: leadId,
    oldValue: { stage: fromStage },
    newValue: { stage: toStage },
  });

  return { success: true };
}

export async function convertLead(leadId: string): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "leads", "write");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
    include: { pipeline: true },
  });
  if (!lead) return { error: "Lead not found or access denied." };
  if (lead.convertedAt) return { error: "Lead has already been converted." };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const customerNumber = await generateCustomerNumber();
      const customer = await prisma.$transaction(async (tx) => {
        const c = await tx.customer.create({
          data: {
            customerNumber,
            name: lead.name,
            companyName: lead.companyName,
            contactPerson: lead.contactPerson,
            customerType: lead.customerType,
            phone: lead.phone,
            whatsapp: lead.whatsapp,
            email: lead.email,
            state: lead.state,
            district: lead.district,
            pincode: lead.pincode,
            address: lead.address,
            assignedToId: lead.assignedToId,
            sourceLeadId: lead.id,
          },
        });

        await tx.lead.update({
          where: { id: leadId },
          data: { convertedAt: new Date(), status: "WON" },
        });

        if (lead.pipeline && lead.pipeline.stage !== "WON") {
          await tx.pipeline.update({
            where: { leadId },
            data: { stage: "WON", enteredStageAt: new Date() },
          });
          await tx.pipelineStageHistory.create({
            data: {
              pipelineId: lead.pipeline.id,
              fromStage: lead.pipeline.stage,
              toStage: "WON",
              movedById: user.id,
            },
          });
        }

        await tx.leadActivity.create({
          data: {
            leadId,
            type: "LEAD_CONVERTED",
            description: `Converted to customer ${customerNumber}.`,
            createdById: user.id,
          },
        });

        return c;
      });

      revalidatePath(`/leads/${leadId}`);
      revalidatePath("/leads");
      revalidatePath("/pipeline");
      revalidatePath("/customers");
      revalidatePath("/dashboard");

      await logAudit({
        userId: user.id,
        action: "CONVERT",
        entityType: "Lead",
        entityId: leadId,
        newValue: { customerId: customer.id, customerNumber: customer.customerNumber },
      });

      return { success: true, customerNumber: customer.customerNumber };
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 2) continue;
      throw err;
    }
  }
  return { error: "Could not convert lead. Please try again." };
}
