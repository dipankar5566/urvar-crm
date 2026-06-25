/**
 * Leads/customers are entered as plain 10-digit Indian mobile numbers (see
 * lib/validations/lead.ts, customer.ts). Twilio's <Dial><Number> requires
 * E.164 to route a PSTN call reliably, so callers must be normalized here
 * before dialing.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+91${digits.slice(1)}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}
