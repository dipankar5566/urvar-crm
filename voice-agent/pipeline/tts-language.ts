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
const PHRASES: Partial<
  Record<
    SarvamTtsLanguage,
    { fillers: string[]; closing: string; holding: string; fallback: string }
  >
> = {
  // Eight fillers per language, not four. Measured across the 766 spoken
  // utterances in logs/voice-agent-out-4.log: 203 of them (26.5%) were fillers
  // drawn from a four-word list, and 32 immediately repeated the one before.
  // Hearing the same handful of words open every reply is itself the robotic
  // thing the filler exists to avoid.
  "bn-IN": {
    fillers: [
      "জি...",
      "আচ্ছা...",
      "হ্যাঁ...",
      "ঠিক আছে...",
      "বুঝলাম...",
      "শুনছি...",
      "আচ্ছা আচ্ছা...",
      "হ্যাঁ হ্যাঁ...",
    ],
    closing: "ধন্যবাদ, ভালো থাকবেন।",
    holding: "একটু ধরুন, দেখে নিচ্ছি।",
    fallback: "দুঃখিত, আমাদের একজন আপনাকে ফোন করে জানাবেন।",
  },
  "hi-IN": {
    fillers: [
      "जी...",
      "अच्छा...",
      "हाँ जी...",
      "ठीक है...",
      "समझ गया...",
      "सुन रहा हूँ...",
      "अच्छा अच्छा...",
      "जी हाँ...",
    ],
    closing: "धन्यवाद, नमस्ते।",
    holding: "एक मिनट, मैं देख रहा हूँ।",
    fallback: "माफ़ कीजिए, हमारी टीम से कोई आपको कॉल करेगा।",
  },
  "en-IN": {
    fillers: [
      "Sure...",
      "Okay...",
      "Right...",
      "Got it...",
      "I see...",
      "Understood...",
      "Yes...",
      "Okay okay...",
    ],
    closing: "Thank you, have a good day.",
    holding: "One moment, let me check that.",
    fallback: "Sorry, let me have someone call you back.",
  },
};

const FALLBACK_PHRASES = PHRASES["en-IN"]!;

/**
 * Spoken the instant a turn starts if the model is still thinking, so the
 * lead hears a response rather than a gap.
 *
 * `index` must advance once per *filler*, not once per utterance. It used to
 * be handed session.utteranceSeq, which every streamed sentence, closing line
 * and holding line also bumps — so the documented cycle never actually
 * happened and one word came up 47 times in a single log. `previous` is the
 * last filler this call spoke; the pick steps past it so the same word is
 * never said twice running.
 */
export function fillerWord(
  code: SarvamTtsLanguage,
  index = 0,
  previous?: string | null,
): string {
  const { fillers } = PHRASES[code] ?? FALLBACK_PHRASES;
  const start = Math.abs(index) % fillers.length;
  const pick = fillers[start]!;
  if (pick !== previous || fillers.length === 1) return pick;
  return fillers[(start + 1) % fillers.length]!;
}

/** Spoken by the server's own wrap-up guards before hanging up. */
export function closingLine(code: SarvamTtsLanguage): string {
  return (PHRASES[code] ?? FALLBACK_PHRASES).closing;
}

/**
 * Spoken when a turn stalls — a slow tool hop, or a model error — so the lead
 * hears something rather than dead air.
 *
 * Exists because this line was a hardcoded Hindi string in server.ts, spoken
 * verbatim on every call in every language: a West Bengal lead mid-way through
 * a Bengali conversation would suddenly hear "Sorry, ek minute. Main check kar
 * raha hoon."
 */
export function holdingLine(code: SarvamTtsLanguage): string {
  return (PHRASES[code] ?? FALLBACK_PHRASES).holding;
}

/**
 * Spoken when the agent runs out of tool hops without producing a reply of its
 * own. Same reason as holdingLine: this was a hardcoded English sentence in
 * openai-agent.ts, read aloud mid-way through a Bengali call.
 */
export function fallbackLine(code: SarvamTtsLanguage): string {
  return (PHRASES[code] ?? FALLBACK_PHRASES).fallback;
}

/** Which rule decided the voice — reported in the log so a surprising
 * language can be traced without guessing. */
export type TtsLanguageSource = "env-override" | "rep-set" | "state" | "default";

/**
 * Resolves the voice language for a call, in priority order:
 *
 *   1. `SARVAM_TTS_LANGUAGE` — a global override, for testing one voice
 *      across every call.
 *   2. `preferred` — `Lead.preferredLanguage`, set by a rep in the CRM.
 *      A human's explicit choice beats the state proxy. This used to be
 *      auto-written from one /text-lid detection per call and was wrong both
 *      times it ever fired (see detect-language.ts); nothing in the voice
 *      agent writes it now.
 *   3. The lead's state — a proxy, and wrong for anyone who has moved.
 *   4. Hindi.
 */
export function resolveTtsLanguageWithSource(
  state: string | null | undefined,
  preferred?: string | null,
): { code: SarvamTtsLanguage; source: TtsLanguageSource } {
  const override = process.env.SARVAM_TTS_LANGUAGE;
  if (override) return { code: override as SarvamTtsLanguage, source: "env-override" };

  // Guarded because the column is a free-text String?, so a stale or bad
  // value could otherwise reach Sarvam's TTS config and be rejected mid-call.
  if (preferred && preferred in LANGUAGE_NAMES) {
    return { code: preferred as SarvamTtsLanguage, source: "rep-set" };
  }

  const normalized = (state ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const mapped = STATE_TO_LANGUAGE[normalized];
  if (mapped) return { code: mapped, source: "state" };

  return { code: DEFAULT_TTS_LANGUAGE, source: "default" };
}

export function resolveTtsLanguage(
  state: string | null | undefined,
  preferred?: string | null,
): SarvamTtsLanguage {
  return resolveTtsLanguageWithSource(state, preferred).code;
}
