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

/**
 * Removes a leading acknowledgement the server has already said for itself.
 *
 * The filler word and the model's own opening reaction are two separate
 * features that do not know about each other, and they collide: measured
 * across logs/voice-agent-out-4.log, 44 turns played a filler and then
 * immediately said the same thing again —
 *
 *   "হ্যাঁ..."  then  "হ্যাঁ দাদা, আসলে organic সার নিয়েই ফোন করেছিলাম।"
 *
 * Only the first token goes, and only when real content follows it — the
 * prompt asks the model to react before it asks anything, and that reaction is
 * worth keeping. What is not worth keeping is hearing it twice.
 */
export function stripLeadingAcknowledgement(text: string): string {
  // \p{M} for the same reason isBackchannel needs it: without combining marks
  // in the class "হ্যাঁ" is not one token, and nothing would ever match.
  // [\s\S] rather than `.` with the `s` flag: tsconfig targets below es2018,
  // where the dotAll flag is a compile error.
  const match = /^([\p{L}\p{N}\p{M}]+)[\s,।.!]+([\s\S]+)$/u.exec(text.trim());
  if (!match) return text;

  const [, first, rest] = match;
  if (!BACKCHANNEL.has(first!.toLowerCase())) return text;

  // Never strip down to a fragment: a two-word acknowledgement losing its
  // first word leaves a stray word on its own, which is worse than the
  // repetition it fixes.
  const remainder = rest!.trim();
  if (remainder.length < 4) return text;
  return remainder;
}

/**
 * Shortest partial transcript allowed to destroy audio the lead is currently
 * hearing. `isBackchannel` already absorbs "haan" (4), "achha" (5) and
 * "bataiye" (7), so this only has to reject a single noise token; 6 is about
 * two short Latin words, or "দাম কত".
 *
 * Exported as a constant precisely so tuning it against the `[turn]` logs is
 * a one-line change rather than a hunt through the barge-in logic.
 */
export const MIN_PARTIAL_COMMIT_CHARS = 6;

export type InterruptClass = "backchannel" | "substantive" | "insufficient";

/**
 * Classifies a *partial* transcript for barge-in purposes.
 *
 * Partials are noisier and shorter than finals and are still being revised,
 * so this is deliberately one-way conservative: it only ever returns
 * "substantive" when it is safe to cut the AI off, and everything else waits
 * for the authoritative final to decide. Note the deliberate consequence of
 * reusing `isBackchannel`: "haan haan haan" is more than two words, so it
 * counts as substantive — three acknowledgements while the AI keeps talking
 * really is someone trying to interrupt.
 */
export function classifyInterrupt(text: string, minChars = MIN_PARTIAL_COMMIT_CHARS): InterruptClass {
  const trimmed = text.trim();
  if (!trimmed) return "insufficient";
  if (isBackchannel(trimmed)) return "backchannel";
  return trimmed.length >= minChars ? "substantive" : "insufficient";
}
