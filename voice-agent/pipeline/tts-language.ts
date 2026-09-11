/**
 * Maps a lead's state to a Sarvam TTS language code.
 *
 * Unlike the STT side, Sarvam's TTS has no "auto" — it needs one fixed
 * BCP-47 code per session from a closed enum, since it has to know what to
 * synthesize rather than detect. Our leads code-switch mid-sentence
 * (Hindi/English/Bengali in one call), so no single code is ever fully
 * correct; the best available proxy is the lead's own state, which is a
 * required column on Lead.
 *
 * Only the eleven codes Sarvam's TTS actually accepts are valid here
 * (bn/en/gu/hi/kn/ml/mr/od/pa/ta/te-IN) — anything else is rejected, so
 * languages without a Sarvam voice fall back to the nearest one that has
 * a voice (e.g. Assamese -> bn-IN) rather than their true language.
 */

/** The eleven language codes Sarvam's TTS accepts. */
export type SarvamTtsLanguage =
  | "bn-IN"
  | "en-IN"
  | "gu-IN"
  | "hi-IN"
  | "kn-IN"
  | "ml-IN"
  | "mr-IN"
  | "od-IN"
  | "pa-IN"
  | "ta-IN"
  | "te-IN";

export const DEFAULT_TTS_LANGUAGE: SarvamTtsLanguage = "hi-IN";

// Keyed on a normalized state name (lowercased, non-letters stripped) so
// "West Bengal", "west bengal" and "WEST_BENGAL" all resolve. States not
// listed here fall through to DEFAULT_TTS_LANGUAGE, which covers the
// Hindi belt (UP, Bihar, MP, Rajasthan, Delhi, Haryana, Jharkhand,
// Chhattisgarh, Uttarakhand, Himachal) without needing an entry each.
const STATE_TO_LANGUAGE: Record<string, SarvamTtsLanguage> = {
  westbengal: "bn-IN",
  tripura: "bn-IN",
  // Assamese has no Sarvam TTS voice — Bengali is the closest available.
  assam: "bn-IN",
  odisha: "od-IN",
  orissa: "od-IN",
  gujarat: "gu-IN",
  maharashtra: "mr-IN",
  goa: "mr-IN",
  punjab: "pa-IN",
  chandigarh: "pa-IN",
  karnataka: "kn-IN",
  kerala: "ml-IN",
  lakshadweep: "ml-IN",
  tamilnadu: "ta-IN",
  puducherry: "ta-IN",
  pondicherry: "ta-IN",
  telangana: "te-IN",
  andhrapradesh: "te-IN",
};

/**
 * Plain-English names for the same codes, for the agent's system prompt.
 *
 * The TTS `language_code` only picks the *voice*; what language actually
 * gets spoken is whatever text the LLM writes. Both therefore have to be
 * driven from the same resolution or you get a Bengali voice reading Hindi
 * text, which is what a West Bengal lead heard on 2026-09-10.
 */
const LANGUAGE_NAMES: Record<SarvamTtsLanguage, string> = {
  "bn-IN": "Bengali",
  "en-IN": "Indian English",
  "gu-IN": "Gujarati",
  "hi-IN": "Hindi",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

export function languageName(code: SarvamTtsLanguage): string {
  return LANGUAGE_NAMES[code] ?? "Hindi";
}

/**
 * Short spoken phrases the server says on its own, without going through
 * the model.
 *
 * Only the three languages this business actually calls in are authored
 * here; everything else falls back to Indian English rather than shipping
 * machine translations nobody on the team can check. A wrong-sounding word
 * in someone's own language is worse than a neutral English one.
 */
const PHRASES: Partial<Record<SarvamTtsLanguage, { fillers: string[]; closing: string }>> = {
  // Several fillers per language, because hearing the identical word before
  // every single reply is itself robotic — people vary their acknowledgements.
  "bn-IN": { fillers: ["জি...", "আচ্ছা...", "হ্যাঁ...", "ঠিক আছে..."], closing: "ধন্যবাদ, ভালো থাকবেন।" },
  "hi-IN": { fillers: ["जी...", "अच्छा...", "हाँ जी...", "ठीक है..."], closing: "धन्यवाद, नमस्ते।" },
  "en-IN": { fillers: ["Sure...", "Okay...", "Right...", "Got it..."], closing: "Thank you, have a good day." },
};

const FALLBACK_PHRASES = PHRASES["en-IN"]!;

/**
 * Spoken the instant a turn starts if the model is still thinking, so the
 * lead hears a response rather than a gap. `index` is the turn counter —
 * pass it so successive turns cycle through the variants rather than
 * repeating one word.
 */
export function fillerWord(code: SarvamTtsLanguage, index = 0): string {
  const { fillers } = PHRASES[code] ?? FALLBACK_PHRASES;
  return fillers[Math.abs(index) % fillers.length];
}

/** Spoken by the server's own wrap-up guards before hanging up. */
export function closingLine(code: SarvamTtsLanguage): string {
  return (PHRASES[code] ?? FALLBACK_PHRASES).closing;
}

/**
 * Resolves the voice language for a call, in priority order:
 *
 *   1. `SARVAM_TTS_LANGUAGE` — a global override, for testing one voice
 *      across every call.
 *   2. `preferred` — a language this lead was actually heard speaking on an
 *      earlier call (see detect-language.ts). Evidence beats inference.
 *   3. The lead's state — a proxy, and wrong for anyone who has moved.
 *   4. Hindi.
 */
export function resolveTtsLanguage(
  state: string | null | undefined,
  preferred?: string | null,
): SarvamTtsLanguage {
  const override = process.env.SARVAM_TTS_LANGUAGE;
  if (override) return override as SarvamTtsLanguage;

  // Guarded because the column is a free-text String?, so a stale or bad
  // value could otherwise reach Sarvam's TTS config and be rejected mid-call.
  if (preferred && preferred in LANGUAGE_NAMES) return preferred as SarvamTtsLanguage;

  const normalized = (state ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return STATE_TO_LANGUAGE[normalized] ?? DEFAULT_TTS_LANGUAGE;
}
