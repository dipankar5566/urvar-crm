/**
 * Detects what language a lead actually spoke, via Sarvam's /text-lid.
 *
 * Why not just use the speech recogniser's own `language` field: it is
 * unreliable here. Measured against eight real utterances from our call
 * transcripts, STT was wrong on five — reporting `en-IN` for plainly Bengali
 * text like "হ্যাঁ ওখানেই চাই" — while /text-lid got all eight right,
 * including romanized Hindi ("Bataiye" -> hi-IN) and code-mixed lines.
 *
 * The result is used *within the call only*, to switch the TTS voice to match
 * the lead (see trackSpokenLanguage in server.ts). It is deliberately no
 * longer written to Lead.preferredLanguage: that column is rep-set now.
 * Auto-writing it corrupted two real leads — one West Bengal farmer was
 * relanguaged to Telugu off the single mis-heard utterance "Ice cream"
 * (STT confidence 0.12), and every later call to them opened in the wrong
 * language with no way for a rep to see or fix it.
 */
import type { SarvamTtsLanguage } from "./tts-language.js";

const TEXT_LID_URL = "https://api.sarvam.ai/text-lid";

/** The eleven codes our TTS can actually speak. Detection can return others
 * (Assamese, Urdu…); anything we can't voice is discarded rather than
 * stored, so it can never be handed to the TTS config later. */
const SPEAKABLE = new Set<string>([
  "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
]);

/** Below this, a detection is more likely noise than signal. Was 8, which let
 * the two-word mis-hear "Ice cream" (9 chars) decide a lead's language; a
 * real answer that carries language information is longer than this. */
const MIN_CHARS = 20;

/** Sarvam's STT confidence below which a final is not worth classifying at
 * all. Both bad detections on record came from finals under this: "Ice cream"
 * at 0.12 and "is available." at 0.56. Language ID cannot be better than the
 * transcript it is handed. */
const MIN_STT_CONFIDENCE = 0.7;

export async function detectLanguage(
  text: string,
  /** Sarvam's confidence for the final this text came from, when known.
   * Omitted means "not from STT" and skips the gate. */
  sttConfidence?: number | null,
): Promise<SarvamTtsLanguage | null> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;

  if (typeof sttConfidence === "number" && sttConfidence < MIN_STT_CONFIDENCE) return null;

  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) return null;

  try {
    const res = await fetch(TEXT_LID_URL, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ input: trimmed }),
    });
    if (!res.ok) {
      console.error(`[detect-language] ${res.status} ${(await res.text()).slice(0, 140)}`);
      return null;
    }
    const { language_code: code } = (await res.json()) as { language_code?: string };
    if (!code || !SPEAKABLE.has(code)) {
      if (code) console.log(`[detect-language] ignoring "${code}" — not a language our TTS speaks`);
      return null;
    }
    return code as SarvamTtsLanguage;
  } catch (err) {
    // Never let language detection break a live call — it is an
    // optimisation for the next one, not part of this conversation.
    console.error("[detect-language] failed", err);
    return null;
  }
}
