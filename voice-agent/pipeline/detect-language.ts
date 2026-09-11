/**
 * Detects what language a lead actually spoke, via Sarvam's /text-lid.
 *
 * Why not just use the speech recogniser's own `language` field: it is
 * unreliable here. Measured against eight real utterances from our call
 * transcripts, STT was wrong on five — reporting `en-IN` for plainly Bengali
 * text like "হ্যাঁ ওখানেই চাই" — while /text-lid got all eight right,
 * including romanized Hindi ("Bataiye" -> hi-IN) and code-mixed lines.
 *
 * The result is stored on Lead.preferredLanguage so the NEXT call to that
 * lead opens in their language. It deliberately does not switch the voice
 * mid-call: Sarvam's TTS config is sent once at socket connect, so changing
 * it means tearing down and rebuilding the socket, and swapping voice
 * halfway through a conversation sounds worse than finishing in the one it
 * started with.
 */
import type { SarvamTtsLanguage } from "./tts-language.js";

const TEXT_LID_URL = "https://api.sarvam.ai/text-lid";

/** The eleven codes our TTS can actually speak. Detection can return others
 * (Assamese, Urdu…); anything we can't voice is discarded rather than
 * stored, so it can never be handed to the TTS config later. */
const SPEAKABLE = new Set<string>([
  "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
]);

/** Below this, a detection is more likely noise than signal — "Hello" and
 * "ok" carry no language information worth persisting. */
const MIN_CHARS = 8;

export async function detectLanguage(text: string): Promise<SarvamTtsLanguage | null> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;

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
