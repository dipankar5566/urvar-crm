/**
 * Detects short acknowledgements people say *while* the other side is still
 * talking — "haan", "ji", "hello", "bataiye".
 *
 * This exists because treating them as interruptions is what made the agent
 * talk over itself: every one fired a `clearAudio` that truncated the AI
 * mid-sentence, so the lead never heard a complete line, said "hello?"
 * again, and the agent re-introduced itself four times in one call
 * (2026-09-10, cmtvzdff5).
 *
 * Only consulted while the AI is actually speaking. Once it has finished,
 * even a bare "hello" is a real turn and deserves a real answer.
 *
 * Lives in its own module rather than server.ts so it can be exercised
 * without booting the media server.
 */

const BACKCHANNEL = new Set([
  // Latin / romanized
  "hello", "helo", "hallo", "hi", "haan", "ha", "han", "haa", "ji", "jee", "jii",
  "ok", "okay", "okey", "acha", "achha", "accha", "theek", "thik", "thike",
  "hmm", "hm", "hmmm", "yes", "yeah", "yep", "right", "sure",
  "bataiye", "batao", "boliye", "bolo", "bolun",
  // Bengali
  "হ্যাঁ", "হ্যা", "হা", "আচ্ছা", "বলুন", "বলো", "জি",
  // Devanagari
  "हाँ", "हां", "जी", "अच्छा", "बताइए", "बताओ", "बोलिए", "ठीक",
]);

/**
 * True when the utterance is nothing but one or two filler acknowledgements.
 *
 * The word-count ceiling matters: "haan" alone is a backchannel, but "haan
 * bhai theek hai bolo" is a real reply and must be allowed to interrupt.
 */
export function isBackchannel(text: string): boolean {
  // \p{M} is essential, not decorative: Indic vowel signs, viramas and the
  // chandrabindu are combining Marks, not Letters, so stripping them turns
  // "হ্যাঁ" into "হ য" and no Bengali or Devanagari entry below would ever
  // match. Caught by test, having originally shipped as \p{L}\p{N} only.
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return true; // punctuation/noise only
  if (words.length > 2) return false;
  return words.every((w) => BACKCHANNEL.has(w));
}
