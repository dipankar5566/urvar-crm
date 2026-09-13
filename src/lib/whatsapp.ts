/**
 * Outbound WhatsApp via Plivo, which is a Meta Solution Provider as well as
 * our voice carrier — so this reuses the same account and credentials the
 * calling code already has (see lib/plivo.ts).
 *
 * Business-initiated WhatsApp messages must use a template that Meta has
 * approved in advance; free-form text is only allowed inside the 24-hour
 * window after a customer messages first, which is never the case here. That
 * approval is a manual, multi-day step in the Plivo/Meta console, entirely
 * outside this codebase, so every send is gated behind WHATSAPP_ENABLED and
 * the whole feature ships switched off. Flip the flag once the WABA and the
 * templates are live — no redeploy required.
 *
 * Register the quotation template under Meta's **Utility** category, not
 * Marketing: it is a transactional record the customer asked for, and at
 * India rates that is ~Rs 0.13/message against ~Rs 0.95 for Marketing.
 *
 * Like lib/email.ts, nothing here throws — a send is a best-effort side
 * effect of something that already succeeded.
 */
import { toE164 } from "@/lib/phone";

export type SendWhatsAppResult = {
  success: boolean;
  providerMessageId?: string;
  error?: string;
};

/**
 * A Meta template component parameter. Positional templates use {{1}}, {{2}}
 * placeholders and are filled in order; named templates carry parameterName.
 */
export type TemplateTextParam = {
  type: "text";
  text: string;
  parameterName?: string;
};

/** True only when the flag is on AND the sender number is configured. */
export function isWhatsAppEnabled(): boolean {
  return process.env.WHATSAPP_ENABLED === "true" && Boolean(process.env.PLIVO_WHATSAPP_NUMBER);
}

/**
 * Plivo's Node SDK types only declare the positional
 * `create(src, dst, text, optionalParams)` overload, but its runtime detects
 * a single-object argument (`arguments.length == 1`) and that object form is
 * what Plivo's own docs use for WhatsApp templates — it is the only shape
 * that leaves `text` unset, which is what a template message wants. Casting
 * to this narrow local type keeps the object form type-checked at the call
 * site rather than reaching for `any`.
 */
type WhatsAppCreate = (params: {
  src: string;
  dst: string;
  type: "whatsapp";
  template: {
    name: string;
    language: string;
    components: { type: string; parameters: TemplateTextParam[] }[];
  };
}) => Promise<{ messageUuid?: string[] | string }>;

export async function sendWhatsAppTemplate(params: {
  /** Plain 10-digit Indian mobile as stored, or any form toE164 understands. */
  to: string;
  templateName: string;
  /** Meta language code of the approved template, e.g. "en" / "en_US". */
  languageCode?: string;
  /** Values for the template body's placeholders, in order. */
  bodyParams: string[];
}): Promise<SendWhatsAppResult> {
  if (!isWhatsAppEnabled()) {
    return { success: false, error: "WhatsApp is disabled (WHATSAPP_ENABLED not true)." };
  }
  if (!params.templateName) {
    return { success: false, error: "No WhatsApp template name configured for this message." };
  }

  const dst = toE164(params.to);
  if (!dst) {
    return { success: false, error: "No usable WhatsApp number for this recipient." };
  }

  try {
    // Imported here, not at module scope. lib/plivo.ts builds its client
    // eagerly and throws if PLIVO_AUTH_ID/TOKEN are missing, so a top-level
    // import would make the whole quotations module fail to load on any
    // deployment without Plivo configured — even with WhatsApp switched off,
    // which is exactly what the kill switch is supposed to prevent.
    const { plivoClient } = await import("@/lib/plivo");
    const create = plivoClient.messages.create.bind(
      plivoClient.messages,
    ) as unknown as WhatsAppCreate;

    const response = await create({
      src: process.env.PLIVO_WHATSAPP_NUMBER as string,
      dst,
      type: "whatsapp",
      template: {
        name: params.templateName,
        language: params.languageCode || "en",
        components: [
          {
            type: "body",
            parameters: params.bodyParams.map((text) => ({ type: "text" as const, text })),
          },
        ],
      },
    });

    const uuid = Array.isArray(response?.messageUuid)
      ? response.messageUuid[0]
      : response?.messageUuid;
    return { success: true, providerMessageId: uuid };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown WhatsApp error." };
  }
}
