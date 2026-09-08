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

export async function summarizeCall(fullTranscript: string): Promise<CallSummary> {
  const res = await openai().chat.completions.create({
    model: MODEL,
    max_completion_tokens: 300,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: fullTranscript || "(no speech detected)" },
    ],
  });

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
