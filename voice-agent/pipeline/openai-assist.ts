/**
 * OpenAI reasoning layer for Phase 1's live call-assist: turns a rolling
 * transcript into an occasional short suggestion for the rep, and produces
 * a final summary/sentiment/intent-tags once the call ends. Text in/out
 * only — no tool-calling yet (that's Phase 2's `voice-agent/tools/`).
 *
 * Swapped from Claude to OpenAI 2026-09-09 (see the plan's Vendor stack
 * decision) — scoped to this reasoning layer only. Sarvam still handles all
 * Hindi/English/Bengali speech-to-text/text-to-speech, so this swap doesn't
 * affect the Indic-language handling; the system prompts already instruct
 * the model to respond in English regardless of transcript language mix.
 *
 * Confirmed against the installed `openai@7.10.0` package's own type
 * declarations, not assumed: `chat.completions.create` (not the newer
 * Responses API) with `max_completion_tokens` (`max_tokens` is deprecated),
 * and `gpt-5.4-mini` is a real current model id in `Shared.ChatModel`.
 */
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

// Lazy: matches the same defensive pattern used for Sarvam/Claude before it
// — don't let a missing OPENAI_API_KEY crash the whole voice-agent process
// at module load (it holds every concurrent call's session state).
let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

const SUGGESTION_SYSTEM_PROMPT = `You are a live call-assist copilot for a sales rep at Urvar Natural, an organic-fertilizer company in India, listening in on an ongoing phone call. You are given the transcript so far. Reply with ONE short, actionable suggestion (max 20 words) ONLY if it would genuinely help the rep right now — e.g. the customer asked a specific question, mentioned a product/price/complaint, or the conversation has stalled. If there's nothing useful to add, reply with exactly: NONE. Never repeat something already obvious from context. Never invent facts you weren't given. The transcript may mix Hindi, English, and Bengali — respond in English regardless.`;

export async function maybeGenerateSuggestion(rollingTranscript: string): Promise<string | null> {
  if (!rollingTranscript.trim()) return null;

  const res = await openai().chat.completions.create({
    model: MODEL,
    max_completion_tokens: 60,
    messages: [
      { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
      { role: "user", content: rollingTranscript },
    ],
  });

  const text = res.choices[0]?.message?.content?.trim() ?? "";
  if (!text || text === "NONE") return null;
  return text;
}

const SUMMARY_SYSTEM_PROMPT = `Summarize this sales call transcript in 2-3 sentences for a CRM record, then classify overall sentiment and list up to 5 short lowercase-hyphenated intent tags (e.g. "price-inquiry", "wants-callback"). Respond as strict JSON with exactly these keys: {"summary": string, "sentiment": "POSITIVE"|"NEUTRAL"|"NEGATIVE"|"ESCALATED", "intentTags": string[]}.`;

export type CallSummary = {
  summary: string;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "ESCALATED";
  intentTags: string[];
};

/**
 * The facts worth keeping from a call, in a shape that can be queried and fed
 * back into the next call's prompt.
 *
 * A prose summary reads well to a human and is useless to everything else:
 * you cannot filter leads by it, and dropping it into the next system prompt
 * re-states the conversation instead of its conclusions. Every field is
 * nullable because a 30-second call genuinely does not establish acreage, and
 * inventing it would be worse than leaving it blank.
 */
export type CallFacts = {
  customerType: string | null;
  location: string | null;
  crop: string | null;
  acreage: string | null;
  productsInterested: string[];
  currentProducts: string[];
  painPoints: string[];
  objections: string[];
  purchaseIntent: "HIGH" | "MEDIUM" | "LOW" | "NONE" | null;
  quantityEstimate: string | null;
  callbackRequested: boolean;
  callbackTime: string | null;
  nextAction: string | null;
  leadTemperature: "HOT" | "WARM" | "COLD" | null;
  language: string | null;
};

const FACTS_SYSTEM_PROMPT = `Extract what this sales call established, as strict JSON with exactly these keys:
{"customerType": string|null, "location": string|null, "crop": string|null, "acreage": string|null, "productsInterested": string[], "currentProducts": string[], "painPoints": string[], "objections": string[], "purchaseIntent": "HIGH"|"MEDIUM"|"LOW"|"NONE"|null, "quantityEstimate": string|null, "callbackRequested": boolean, "callbackTime": string|null, "nextAction": string|null, "leadTemperature": "HOT"|"WARM"|"COLD"|null, "language": string|null}
Use null or an empty array for anything the call did not actually establish. Never guess a number, a crop, or an acreage that was not said. The transcript may mix Hindi, English and Bengali; answer in English.`;

const EMPTY_FACTS: CallFacts = {
  customerType: null,
  location: null,
  crop: null,
  acreage: null,
  productsInterested: [],
  currentProducts: [],
  painPoints: [],
  objections: [],
  purchaseIntent: null,
  quantityEstimate: null,
  callbackRequested: false,
  callbackTime: null,
  nextAction: null,
  leadTemperature: null,
  language: null,
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 8) : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Never returns a half-parsed object: a bad extraction must cost the
 * structured record only, never the transcript it was derived from. Each
 * field is validated rather than trusted, so a model that invents an enum
 * value stores null instead of poisoning a query later.
 */
export async function extractCallFacts(fullTranscript: string): Promise<CallFacts | null> {
  if (!fullTranscript.trim()) return null;

  const res = await openai().chat.completions.create(
    {
      model: MODEL,
      max_completion_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FACTS_SYSTEM_PROMPT },
        { role: "user", content: fullTranscript },
      ],
    },
    { timeout: 20_000, maxRetries: 1 },
  );

  const text = res.choices[0]?.message?.content?.trim() ?? "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      ...EMPTY_FACTS,
      customerType: stringOrNull(parsed.customerType),
      location: stringOrNull(parsed.location),
      crop: stringOrNull(parsed.crop),
      acreage: stringOrNull(parsed.acreage),
      productsInterested: stringArray(parsed.productsInterested),
      currentProducts: stringArray(parsed.currentProducts),
      painPoints: stringArray(parsed.painPoints),
      objections: stringArray(parsed.objections),
      purchaseIntent: oneOf(parsed.purchaseIntent, ["HIGH", "MEDIUM", "LOW", "NONE"] as const),
      quantityEstimate: stringOrNull(parsed.quantityEstimate),
      callbackRequested: parsed.callbackRequested === true,
      callbackTime: stringOrNull(parsed.callbackTime),
      nextAction: stringOrNull(parsed.nextAction),
      leadTemperature: oneOf(parsed.leadTemperature, ["HOT", "WARM", "COLD"] as const),
      language: stringOrNull(parsed.language),
    };
  } catch {
    return null;
  }
}

export async function summarizeCall(fullTranscript: string): Promise<CallSummary> {
  const res = await openai().chat.completions.create(
    {
      model: MODEL,
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: fullTranscript || "(no speech detected)" },
      ],
    },
    // The call is already over, so nothing is waiting on this — except the
    // transcript write that follows it in finalizeSession. The SDK's default
    // is 10 minutes with retries; bounded here so a stalled summarizer delays
    // the transcript by seconds rather than by the better part of an hour.
    { timeout: 20_000, maxRetries: 1 },
  );

  const text = res.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    const parsed = JSON.parse(text);
    const sentiment: CallSummary["sentiment"] = ["POSITIVE", "NEUTRAL", "NEGATIVE", "ESCALATED"].includes(
      parsed.sentiment,
    )
      ? parsed.sentiment
      : "NEUTRAL";
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      sentiment,
      intentTags: Array.isArray(parsed.intentTags) ? parsed.intentTags.slice(0, 5) : [],
    };
  } catch {
    // Model didn't return valid JSON — fall back to the raw text as the
    // summary rather than losing the call's content entirely.
    return { summary: text.slice(0, 500), sentiment: "NEUTRAL", intentTags: [] };
  }
}
