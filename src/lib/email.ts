/**
 * Outbound email over plain SMTP.
 *
 * Provider-agnostic on purpose: mail for info@urvarindia.com is served by
 * whatever host holds that mailbox, and this app should not care which. Any
 * SMTP account works by filling in SMTP_HOST/PORT/USER/PASS.
 *
 * Nothing here throws. Every send is a best-effort side effect of something
 * that already succeeded — a quotation was marked sent, a follow-up came
 * due — so a dead mail server must never turn that into a failed request.
 * Callers get a result object and decide what to record.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type SendEmailResult = {
  success: boolean;
  providerMessageId?: string;
  error?: string;
};

let cachedTransporter: Transporter | null = null;

/** True when enough SMTP config exists to attempt a send at all. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const port = Number(process.env.SMTP_PORT || 587);
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587/25 start plaintext and upgrade via STARTTLS.
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return cachedTransporter;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
}): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    // Not an error worth alarming anyone about: it just means SMTP has not
    // been filled in yet on this box. The caller logs it and carries on.
    return { success: false, error: "Email is not configured (SMTP_HOST/SMTP_FROM unset)." };
  }

  try {
    const info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      attachments: params.attachments,
      replyTo: params.replyTo,
    });
    return { success: true, providerMessageId: info.messageId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown email error." };
  }
}
