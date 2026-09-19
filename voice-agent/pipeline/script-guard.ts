/**
 * Forces the agent's speech into the native script of the call's language,
 * because a `bn-IN` voice handed Latin text does not sound like Bengali.
 *
 * Found live on 2026-09-19. Language resolution was correct on every call
 * (`TTS language=bn-IN (source=state, lead state=West Bengal)`), but the model
 * intermittently wrote romanized Bengali and Sarvam's bulbul applied Indic
 * grapheme-to-phoneme rules to it:
 *
 *   [sarvam-tts] speak: "Apnar jomir poriman ar ki chash koren sheta ektu bolben?"
 *
 * Bengali-script vs Latin-script utterance counts on the four bn-IN calls in
 * logs/voice-agent-out-4.log were 21/0, 45/0, 1/0 and then 7/24 — intermittent,
 * and self-sustaining once it starts, since the romanized history keeps the
 * next turn romanized too. That is what "sometimes it sounds like Hindi
 * Bengali, very robotic" was.
 *
 * The system prompt now says which script to write in, but "the model usually
 * obeys" is not the same as "cannot happen" — the same reasoning that put the
 * deterministic filter in voice-output.ts. This module is the backstop.
 *
 * It runs *alongside* the speech rather than in front of it. The conversion
 * measured 524-875ms per sentence against the live endpoint, which is far too
 * much to make a caller wait for on every sentence of a turn. So the sentence
 * is spoken as the model wrote it and the corrected text is patched into the
 * conversation history a moment later (see consumeStream in openai-agent.ts).
 * That fixes the thing that actually matters: drift does not recur randomly,
 * it recurs because a romanized assistant turn is sitting in the history. One
 * turn can still be heard romanized; the call no longer stays that way.
 */
import type { SarvamTtsLanguage } from "./tts-language.js";

const TRANSLITERATE_URL = "https://api.sarvam.ai/transliterate";

/** Unicode ranges for each language we can voice, used to ask "is this
 * sentence already in the right script?". en-IN is absent on purpose: an
 * English call has no native script to force text into. */
const SCRIPT_RANGES: Partial<Record<SarvamTtsLanguage, RegExp>> = {
  "bn-IN": /[\u0980-\u09FF]/,
  "gu-IN": /[\u0A80-\u0AFF]/,
  "hi-IN": /[\u0900-\u097F]/,
  "kn-IN": /[\u0C80-\u0CFF]/,
  "ml-IN": /[\u0D00-\u0D7F]/,
  "mr-IN": /[\u0900-\u097F]/,
  "od-IN": /[\u0B00-\u0B7F]/,
  "pa-IN": /[\u0A00-\u0A7F]/,
  "ta-IN": /[\u0B80-\u0BFF]/,
  "te-IN": /[\u0C00-\u0C7F]/,
};

/**
 * English function words. Romanized Indic text contains essentially none of
 * these; a genuine English sentence contains several.
 *
 * This is the gate that keeps a *deliberate* English reply intact. The agent
 * is told to follow the lead into English mid-call, and the voice only moves
 * to en-IN after two agreeing detections (see server.ts), so between the lead
 * switching and the voice following there is a window where the call language
 * is still bn-IN and an English sentence is the correct output. Transliterating
 * that would be a new bug in place of the old one.
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "the", "is", "are", "was", "were", "you", "your", "we", "our", "and", "for",
  "with", "will", "have", "has", "can", "that", "this", "from", "what", "how",
  "may", "would", "could", "about", "there", "please", "thank",
]);

/** Below this a Latin fragment carries too little signal to classify — and a
 * one-word acknowledgement is usually already native-script anyway, since the
 * server's own fillers come from tts-language.ts. */
const MIN_CHARS = 8;

/** Enough English function words to call it English rather than drift. Two,
 * not one: "Sorry, ek minute" has one ("minute" is not a function word, but a
 * single stray "for" or "and" inside romanized Bengali should not exempt it). */
const ENGLISH_WORD_THRESHOLD = 2;

/**
 * Ceiling on the transliteration hop.
 *
 * Measured against the live endpoint on 2026-09-19: 524, 603, 671, 789, 825
 * and 875 ms for real call sentences, plus a cold-connection outlier over
 * 1500 ms. The first value tried was 600 ms, which timed out on every single
 * one — the guard was completely inert while its logs looked healthy, which is
 * why the number is written down here.
 *
 * It can afford to be generous now that nothing waits on it: the only cost of
 * a slow reply is that this turn's history keeps the romanized text, and the
 * next drifted turn tries again. Still bounded, so a hung request cannot pin a
 * socket for the length of a call.
 */
const TRANSLITERATE_TIMEOUT_MS = 4000;

/**
 * Words to put back into Latin after transliteration, keyed by exactly what
 * Sarvam returns for them.
 *
 * "Urvar Natural" comes back as "উর্বর ন্যাচারাল", which a Bengali speaker reads
 * as "Urbor" — the company's own name, mispronounced, in the greeting line of
 * every drifted call. Restoring it is not a hack around the guard: a Latin
 * brand name inside a native-script sentence is exactly what correct output
 * looks like here (see docs/VOICE_PERSONA.md on code-switching), and it is
 * what the non-drifted calls in the logs already do.
 *
 * Keyed on the observed rendering rather than the source word because
 * transliteration is one-way — there is no alignment to map back through.
 * Verified stable across repeated calls. If Sarvam's rendering ever changes
 * the entry simply stops matching, which degrades to today's behaviour rather
 * than breaking anything, so a stale entry is safe.
 */
const RESTORE_LATIN: [rendered: string, latin: string][] = [
  ["উর্বর ন্যাচারাল", "Urvar Natural"],
  ["उवरान नैचुरल", "Urvar Natural"],
];

function restoreLatinTerms(text: string): string {
  let out = text;
  for (const [rendered, latin] of RESTORE_LATIN) out = out.split(rendered).join(latin);
  return out;
}

/** Short acknowledgements and stock sentences recur constantly within and
 * across calls, and the API is deterministic, so the same text never needs
 * paying for twice in a process lifetime. Bounded so a long-running pm2
 * process cannot grow it without limit. */
const CACHE_LIMIT = 500;
const cache = new Map<string, string>();

/**
 * True when `text` is drifted romanization that should be converted before it
 * reaches TTS. Pure and local — no network, so it is free to call on every
 * sentence of every turn.
 */
export function needsTransliteration(text: string, language: SarvamTtsLanguage): boolean {
  const script = SCRIPT_RANGES[language];
  if (!script) return false;

  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) return false;

  // Already in the right script, or code-mixed with it — leave it alone. A
  // Bengali sentence carrying "delivery" or "vermicompost" in Latin is exactly
  // how people here speak (see docs/VOICE_PERSONA.md) and must not be touched.
  if (script.test(trimmed)) return false;

  // Any other Indic script present means something stranger than romanization
  // is going on; transliterating from "en-IN" would make it worse.
  for (const [code, range] of Object.entries(SCRIPT_RANGES)) {
    if (code !== language && range.test(trimmed)) return false;
  }

  let englishWords = 0;
  for (const word of trimmed.toLowerCase().split(/[^a-z]+/)) {
    if (ENGLISH_FUNCTION_WORDS.has(word)) englishWords++;
    if (englishWords >= ENGLISH_WORD_THRESHOLD) return false;
  }
  return true;
}

/**
 * Converts romanized text into `language`'s script via Sarvam's transliterate
 * endpoint.
 *
 * `numerals_format: "international"` keeps "25 kg" as "25 kg" rather than
 * rendering the digits natively, which matters because the catalogue's pack
 * sizes and quantities are read aloud.
 *
 * Never throws and never returns empty: every failure path hands back the
 * original text, mirroring detect-language.ts. A drifted sentence is bad; a
 * dropped sentence on a live call is worse.
 */
async function transliterate(text: string, language: SarvamTtsLanguage): Promise<string> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return text;

  const cacheKey = `${language}|${text}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(TRANSLITERATE_URL, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        source_language_code: "en-IN",
        target_language_code: language,
        numerals_format: "international",
      }),
      signal: AbortSignal.timeout(TRANSLITERATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[script-guard] ${res.status} ${(await res.text()).slice(0, 140)}`);
      return text;
    }
    const { transliterated_text: raw } = (await res.json()) as { transliterated_text?: string };
    if (!raw || !raw.trim()) return text;
    const out = restoreLatinTerms(raw);

    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(cacheKey, out);
    return out;
  } catch (err) {
    console.error("[script-guard] failed", err);
    return text;
  }
}

/**
 * The one entry point: hand it a sentence that has just been spoken and the
 * call's language, get back the text that should go into the history.
 *
 * Logs every conversion, so the drift rate stays measurable from the same log
 * file that exposed the problem — if this starts firing on most sentences, the
 * fix belongs in the prompt or the provider, not here.
 */
export async function toNativeScript(text: string, language: SarvamTtsLanguage): Promise<string> {
  if (!needsTransliteration(text, language)) return text;
  const converted = await transliterate(text, language);
  if (converted !== text) {
    console.log(`[script-guard] ${language} romanized -> native: "${text.slice(0, 60)}"`);
  }
  return converted;
}
