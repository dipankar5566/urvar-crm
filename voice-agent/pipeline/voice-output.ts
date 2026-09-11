/**
 * Last stop before text becomes speech.
 *
 * The system prompt already tells the model not to write dashes, bullets or
 * abbreviations, and measured across 103 real AI turns that rule is holding —
 * zero markdown characters reached the TTS. This module exists because "the
 * model usually obeys" is not the same as "cannot happen": one stray asterisk
 * is read aloud, and the person on the phone hears it.
 *
 * Scope is deliberately narrow. It removes things that are unambiguously not
 * speech, and it does NOT rewrite numbers, units or spellings — Sarvam's
 * `enable_preprocessing` already normalises numbers and mixed-script text, and
 * a second layer guessing at the same job would fight it.
 */

/** Emoji and pictographs. An explicit range list rather than a broad property
 * escape, so ordinary punctuation and Indic combining marks are never caught. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Orthographic respellings for words the voice gets wrong.
 *
 * Empty on purpose. Sarvam's `bulbul:v3` has no SSML or phoneme control, so
 * the only available lever is spelling a word differently in the text we send
 * — and a respelling not based on having actually heard the mistake is as
 * likely to break a word as to fix one. Add an entry only after hearing the
 * mispronunciation in a real recording, and confirm the replacement with
 * `npm run tts:samples` before shipping it.
 *
 * Candidates from the business vocabulary, none yet verified by ear:
 * কৃষি, সার, মাটি, ফসল, বিঘা, ডিলার, ভার্মিকম্পোস্ট, হিউমিক অ্যাসিড,
 * জিঙ্ক, বোরন, PROM.
 */
export const PRONUNCIATION_LEXICON: Record<string, string> = {};

function applyLexicon(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(PRONUNCIATION_LEXICON)) {
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Strips anything that is written-text furniture rather than speech.
 *
 * Returns the original string if filtering would leave nothing — a line that
 * is entirely punctuation is better spoken oddly than dropped silently, since
 * silence is the failure mode the caller actually notices.
 */
export function toSpeakableText(raw: string): string {
  const cleaned = raw
    // Markdown emphasis, headings, code fences and inline code.
    .replace(/[*_`#]+/g, " ")
    // Leading list bullets and numbering at the start of a line.
    .replace(/^[ \t]*[-•·]\s+/gm, " ")
    .replace(/^[ \t]*\d+[.)]\s+/gm, " ")
    // Bracketed asides: the model occasionally emits stage directions such as
    // "(pause)" or "[tool: get_product_info]", which must never be voiced.
    .replace(/\([^()]{0,80}\)/g, " ")
    .replace(/\[[^\][]{0,80}\]/g, " ")
    .replace(EMOJI, " ")
    // Collapse the gaps the replacements above leave behind.
    .replace(/\s+/g, " ")
    .trim();

  const spoken = applyLexicon(cleaned).trim();
  return spoken.length > 0 ? spoken : raw.trim();
}
