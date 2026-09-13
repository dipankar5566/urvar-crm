/**
 * Sends a quotation to the lead or customer it was raised for, over email
 * (with the PDF attached) and WhatsApp (a short template pointing at it).
 *
 * Called when a quotation is marked SENT. Until now "sent" only meant a
 * status column changed — the rep still had to download the PDF and mail it
 * themselves — so nothing recorded whether the customer ever received it.
 *
 * Every send is best-effort and nothing in here throws: marking a quotation
 * as sent must not fail because a mail server is down. Each attempt, success
 * or failure, lands in MessageLog so the question "did this ever go out?" is
 * answerable from the CRM rather than the provider's dashboard.
 */
import { prisma } from "@/lib/prisma";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { sendWhatsAppTemplate, isWhatsAppEnabled } from "@/lib/whatsapp";

/** Formats a Decimal-as-string amount for display in a message body. */
function formatAmount(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export async function notifyQuotationSent(
  quotationId: string,
  sentByUserId: string,
  sentByEmail?: string,
): Promise<void> {
  // A second read rather than reusing the caller's row: rendering the PDF
  // needs the product joined onto every line, which the status-change path
  // has no other reason to load. Mirrors the include in the PDF route.
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      customer: true,
      lead: true,
      items: { include: { product: true } },
    },
  });
  if (!quotation) return;

  const recipient = quotation.customer ?? quotation.lead;
  if (!recipient) return;

  const total = formatAmount(quotation.totalAmount.toString());
  const emailAddress = recipient.email?.trim();
  // whatsapp is a separate opt-in column; fall back to the primary phone,
  // which for an Indian mobile is virtually always the same WhatsApp number.
  const whatsappNumber = recipient.whatsapp?.trim() || recipient.phone?.trim();

  // ---- Email (PDF attached) -------------------------------------------
  if (emailAddress && isEmailConfigured()) {
    let pdf: Buffer | null = null;
    try {
      pdf = await renderQuotationPdf({
        quotationNumber: quotation.quotationNumber,
        status: quotation.status,
        createdAt: quotation.createdAt,
        validUntil: quotation.validUntil,
        subtotal: quotation.subtotal.toString(),
        discountPercent: quotation.discountPercent.toString(),
        discountAmount: quotation.discountAmount.toString(),
        freightAmount: quotation.freightAmount.toString(),
        taxAmount: quotation.taxAmount.toString(),
        totalAmount: quotation.totalAmount.toString(),
        termsAndConditions: quotation.termsAndConditions,
        notes: quotation.notes,
        recipientName: recipient.name,
        recipientReference: quotation.customer
          ? quotation.customer.customerNumber
          : (quotation.lead?.leadNumber ?? ""),
        recipientLocation: `${recipient.district}, ${recipient.state}`,
        items: quotation.items.map((item) => ({
          productName: item.product.name,
          sku: item.product.sku,
          category: item.product.category,
          unit: item.product.unit,
          quantity: item.quantity.toString(),
          unitPrice: item.unitPrice.toString(),
          discountPercent: item.discountPercent.toString(),
          lineTotal: item.lineTotal.toString(),
        })),
      });
    } catch (err) {
      console.error(`[quotation-notify] PDF render failed for ${quotation.id}:`, err);
    }

    const subject = `Quotation ${quotation.quotationNumber} from Urvar Natural`;
    const result = await sendEmail({
      to: emailAddress,
      subject,
      text: [
        `Dear ${recipient.name},`,
        ``,
        `Please find attached our quotation ${quotation.quotationNumber} for a total of Rs ${total}.`,
        quotation.validUntil
          ? `This quotation is valid until ${quotation.validUntil.toLocaleDateString("en-IN")}.`
          : ``,
        ``,
        `Our team will follow up shortly. Do reply to this email with any questions.`,
        ``,
        `Warm regards,`,
        `Urvar Natural Private Limited`,
      ]
        .filter(Boolean)
        .join("\n"),
      attachments: pdf
        ? [
            {
              filename: `${quotation.quotationNumber}.pdf`,
              content: pdf,
              contentType: "application/pdf",
            },
          ]
        : undefined,
      replyTo: sentByEmail,
    });

    await recordMessage({
      quotation,
      sentByUserId,
      channel: "EMAIL",
      recipientAddress: emailAddress,
      subject,
      result,
    });
  }

  // ---- WhatsApp (template) --------------------------------------------
  // No PDF here: a template's document header needs the file pre-uploaded to
  // Meta or served from a public URL, and the quotation PDF route is behind
  // the CRM's own auth. The email above carries the document.
  if (whatsappNumber && isWhatsAppEnabled()) {
    const templateName = process.env.WHATSAPP_TEMPLATE_QUOTATION_SENT ?? "";
    const result = await sendWhatsAppTemplate({
      to: whatsappNumber,
      templateName,
      bodyParams: [recipient.name, quotation.quotationNumber, total],
    });

    await recordMessage({
      quotation,
      sentByUserId,
      channel: "WHATSAPP",
      recipientAddress: whatsappNumber,
      subject: templateName || null,
      result,
    });
  }
}

/**
 * Writes the MessageLog row for one attempt, plus the matching LeadActivity
 * when the quotation belongs to a lead — the lead timeline is where a rep
 * looks first, and EMAIL_SENT/WHATSAPP_SENT have been defined but unused in
 * the ActivityType enum since the schema was written.
 */
async function recordMessage(args: {
  quotation: {
    id: string;
    leadId: string | null;
    customerId: string | null;
    quotationNumber: string;
  };
  sentByUserId: string;
  channel: "EMAIL" | "WHATSAPP";
  recipientAddress: string;
  subject: string | null;
  result: { success: boolean; providerMessageId?: string; error?: string };
}): Promise<void> {
  const { quotation, result, channel } = args;

  try {
    await prisma.messageLog.create({
      data: {
        leadId: quotation.leadId,
        customerId: quotation.customerId,
        quotationId: quotation.id,
        sentById: args.sentByUserId,
        channel,
        purpose: "QUOTATION_SENT",
        recipient: args.recipientAddress,
        subject: args.subject,
        status: result.success ? "SENT" : "FAILED",
        providerMessageId: result.providerMessageId,
        errorMessage: result.error,
      },
    });

    if (quotation.leadId && result.success) {
      await prisma.leadActivity.create({
        data: {
          leadId: quotation.leadId,
          type: channel === "EMAIL" ? "EMAIL_SENT" : "WHATSAPP_SENT",
          description: `Quotation ${quotation.quotationNumber} sent to ${args.recipientAddress}.`,
          createdById: args.sentByUserId,
        },
      });
    }
  } catch (err) {
    console.error(`[quotation-notify] could not record ${channel} attempt:`, err);
  }

  if (!result.success) {
    console.error(
      `[quotation-notify] ${channel} send failed for ${quotation.quotationNumber}: ${result.error}`,
    );
  }
}
