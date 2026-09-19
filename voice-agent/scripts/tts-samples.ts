/**
 * Renders agent lines through a spread of Sarvam TTS settings so a human can
 * listen and pick one — voice quality is a judgement call that can't be made
 * from byte counts or docs.
 *
 * Writes playable .wav files to storage/voice-samples/ (gitignored, same
 * tree as call recordings). Sarvam streams raw headerless PCM, which no
 * media player will open, so each file gets a 44-byte RIFF header.
 *
 * Two groups:
 *   01-11  voice character — speaker, pace, sample rate.
 *   q*     question intonation. Heard live: the agent sometimes reads a
 *          question flat, like a statement. The "?" is demonstrably reaching
 *          TTS (243 of 459 logged utterances end in one, and 24/24 unambiguous
 *          English interrogatives carry it), so the text path is not the cause
 *          and the remaining levers are all here. Each question is paired with
 *          the same clause as a statement — a rise can only be judged against
 *          a reference — and each pair is rendered with enable_preprocessing
 *          both on and off, since that normaliser is the one thing standing
 *          between our "?" and the synthesized audio.
 *
 * Run:  npm run tts:samples          (everything)
 *       npm run tts:samples -- q     (only files whose name starts with "q")
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const OUT_DIR = path.join(process.cwd(), "storage", "voice-samples");

/** A realistic turn: code-mixed Bengali/English plus a number, which is
 * exactly what enable_preprocessing is supposed to handle. */
const LINE_PARTS = [
  "হ্যালো দীপঙ্করবাবু,",
  "উর্বর ন্যাচারাল থেকে বলছি।",
  "আপনি কি এখনও জৈব সার নেওয়ার কথা ভাবছেন? আমাদের ২৫ কেজির vermicompost প্যাক আছে।",
];
const LINE_WHOLE = LINE_PARTS.join(" ");

/**
 * Question/statement minimal pairs. Same speaker, same settings, same clause —
 * the only difference is the terminal punctuation, so anything you hear
 * between the two IS the engine's response to "?".
 *
 * Lines are real agent turns, not invented ones: the Bengali pair is the
 * qualifying question from call-flow step 3, the English pair the greeting.
 */
const Q_BN = "আপনি কী চাষ করেন?";
const S_BN = "আপনি ধান চাষ করেন।";
const Q_EN = "Is now a good time to talk?";
const S_EN = "Now is a good time to talk.";
/** A question with a run-up, in case a bare clause gives the engine too
 * little to build a contour on. Taken verbatim from a real call. */
const Q_BN_LONG = "আমাদের কাছে Enriched Vermicompost আছে। আপনি কি এখন একটু try করে দেখতে চান?";
/** The opposite extreme — a two-word question, which is where a missing rise
 * would be most audible. */
const Q_BN_SHORT = "ঠিক আছে?";

type Variant = {
  file: string;
  note: string;
  /** Defaults to LINE_WHOLE. Ignored when `fragmented` is set, which always
   * uses LINE_PARTS. */
  text?: string;
  /** Sarvam TTS has no "auto" — every render needs one code. Defaults to
   * bn-IN, the language these leads actually get. */
  languageCode?: string;
  speaker?: string;
  sampleRate?: number;
  pace?: number;
  temperature?: number;
  preprocessing?: boolean;
  /** Reproduce today's behaviour: separate text messages, spread over time,
   * never flushed. */
  fragmented?: boolean;
};

const VARIANTS: Variant[] = [
  { file: "01-baseline-what-you-heard", note: "shubh, fragmented, no preprocessing, no flush — current behaviour", fragmented: true },
  { file: "02-fixed-shubh", note: "shubh, whole line, preprocessing, flush", preprocessing: true },
  { file: "03-aditya", note: "aditya (male)", speaker: "aditya", preprocessing: true },
  { file: "04-rahul", note: "rahul (male)", speaker: "rahul", preprocessing: true },
  { file: "05-amit", note: "amit (male)", speaker: "amit", preprocessing: true },
  { file: "06-ritu", note: "ritu (female)", speaker: "ritu", preprocessing: true },
  { file: "07-priya", note: "priya (female)", speaker: "priya", preprocessing: true },
  { file: "08-shreya", note: "shreya (female)", speaker: "shreya", preprocessing: true },
  { file: "09-shubh-pace-0.9", note: "shubh, slightly slower", preprocessing: true, pace: 0.9 },
  { file: "10-shubh-warmer", note: "shubh, pace 0.95 + temperature 0.8", preprocessing: true, pace: 0.95, temperature: 0.8 },
  { file: "11-shubh-8khz-phone", note: "8kHz — roughly what the phone network delivers", preprocessing: true, sampleRate: 8000 },

  // --- Script drift. Listen to each r?a/r?b pair back to back: same sentence,
  // Latin spelling against Bengali script, both through the production bn-IN
  // voice. The "a" file is what a West Bengal lead actually heard on
  // 2026-09-19 and called "Hindi-sounding and robotic"; "b" is what the script
  // guard now produces. Render just these with: npm run tts:samples -- r
  { file: "r01a-bn-romanized", note: "greeting, ROMANIZED — what the lead actually heard", text: "Namaskar. Ami Urvar Natural theke call korchi.", preprocessing: true },
  { file: "r01b-bn-native", note: "greeting, Bengali script — the reference for r01a", text: "নমস্কার। আমি Urvar Natural থেকে call করছি।", preprocessing: true },
  { file: "r02a-bn-romanized", note: "qualifying question, ROMANIZED — what the lead actually heard", text: "Apnar jomir poriman ar ki chash koren sheta ektu bolben?", preprocessing: true },
  { file: "r02b-bn-native", note: "qualifying question, Bengali script — the reference for r02a", text: "আপনার জমির পরিমাণ আর কী চাষ করেন সেটা একটু বলবেন?", preprocessing: true },
  { file: "r03a-bn-romanized", note: "recommendation with English nouns, ROMANIZED — what the lead actually heard", text: "Amader team exact rate-ta confirm kore apnake janabe.", preprocessing: true },
  { file: "r03b-bn-native", note: "recommendation with English nouns, Bengali script — the reference for r03a", text: "আমাদের team exact rate-টা confirm করে আপনাকে জানাবে।", preprocessing: true },

  // --- Question intonation. Listen to each q?a/q?b pair back to back. ---
  // Bengali, preprocessing ON — this is exactly what production sends today.
  { file: "q01a-bn-question-prep-on", note: "BN question, preprocessing ON  (production settings)", text: Q_BN, preprocessing: true },
  { file: "q01b-bn-statement-prep-on", note: "BN statement, preprocessing ON  — the reference for q01a", text: S_BN, preprocessing: true },
  // Same pair with preprocessing OFF. If q02a rises and q01a doesn't, the
  // normaliser is eating the "?" and Step 2 is a one-line config change.
  { file: "q02a-bn-question-prep-off", note: "BN question, preprocessing OFF", text: Q_BN },
  { file: "q02b-bn-statement-prep-off", note: "BN statement, preprocessing OFF — the reference for q02a", text: S_BN },

  // English, same two-way split — tells us whether this is Bengali-specific.
  { file: "q03a-en-question-prep-on", note: "EN question, preprocessing ON", text: Q_EN, languageCode: "en-IN", preprocessing: true },
  { file: "q03b-en-statement-prep-on", note: "EN statement, preprocessing ON — the reference for q03a", text: S_EN, languageCode: "en-IN", preprocessing: true },
  { file: "q04a-en-question-prep-off", note: "EN question, preprocessing OFF", text: Q_EN, languageCode: "en-IN" },
  { file: "q04b-en-statement-prep-off", note: "EN statement, preprocessing OFF — the reference for q04a", text: S_EN, languageCode: "en-IN" },

  // Utterance length: does the engine need a run-up to build a contour?
  { file: "q05-bn-question-long", note: "BN question after a lead-in sentence", text: Q_BN_LONG, preprocessing: true },
  { file: "q06-bn-question-short", note: "BN two-word question — worst case for a missing rise", text: Q_BN_SHORT, preprocessing: true },

  // Speaker: question prosody may simply be weaker on shubh than on another
  // voice. Same line as q01a so it is directly comparable.
  { file: "q07-bn-question-aditya", note: "BN question, aditya — compare against q01a", text: Q_BN, speaker: "aditya", preprocessing: true },
  { file: "q08-bn-question-ritu", note: "BN question, ritu — compare against q01a", text: Q_BN, speaker: "ritu", preprocessing: true },

  // Controlled pair for the lead-in effect. q05 (question after a sentence)
  // measured -5.11 semitones where q01a (question alone) measured +3.19, but
  // the two used different question text. These swap it: same question as q05
  // but alone, and same question as q01a but with a lead-in. If the contour
  // follows the lead-in rather than the wording, the chunker's MIN_SPEAK_CHARS
  // merge is what flattens questions in production.
  { file: "q09-bn-q05question-alone", note: "q05's question ALONE — vs q05", text: "আপনি কি এখন একটু try করে দেখতে চান?", preprocessing: true },
  { file: "q10-bn-q01question-after-leadin", note: "q01a's question AFTER a lead-in — vs q01a", text: "আমাদের কাছে ভালো product আছে। আপনি কী চাষ করেন?", preprocessing: true },
];

/** Minimal RIFF/WAVE header for 16-bit mono PCM. */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // format = PCM
  h.writeUInt16LE(1, 22); // channels
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 2 bytes/sample)
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Audio has stopped arriving for this long — the utterance is done. */
const QUIET_MS = 1500;
/** Hard ceiling, in case Sarvam never sends anything at all. */
const MAX_RENDER_MS = 12000;

function render(v: Variant, apiKey: string): Promise<void> {
  const sampleRate = v.sampleRate ?? 16000;
  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";

  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(model)}`, {
      headers: { "API-SUBSCRIPTION-KEY": apiKey },
    });
    const parts: Buffer[] = [];
    let settled = false;
    let lastChunkAt = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      const pcm = Buffer.concat(parts);
      if (pcm.length === 0) {
        console.log(`  ${v.file.padEnd(30)} FAILED (no audio) — ${v.note}`);
        return resolve();
      }
      const out = path.join(OUT_DIR, `${v.file}.wav`);
      fs.writeFileSync(out, Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
      console.log(`  ${v.file.padEnd(30)} ${(pcm.length / 2 / sampleRate).toFixed(2)}s  — ${v.note}`);
      resolve();
    };

    ws.on("open", async () => {
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker: v.speaker ?? process.env.SARVAM_TTS_VOICE ?? "shubh",
            language_code: v.languageCode ?? "bn-IN",
            output_audio_codec: "linear16",
            speech_sample_rate: sampleRate,
            ...(v.preprocessing ? { enable_preprocessing: true } : {}),
            ...(v.pace != null ? { pace: v.pace } : {}),
            ...(v.temperature != null ? { temperature: v.temperature } : {}),
          },
        }),
      );

      if (v.fragmented) {
        // Same shape as the live bug: one message per clause, spread out,
        // and no flush at the end.
        for (const part of LINE_PARTS) {
          ws.send(JSON.stringify({ type: "text", data: { text: part } }));
          await sleep(600);
        }
      } else {
        ws.send(JSON.stringify({ type: "text", data: { text: v.text ?? LINE_WHOLE } }));
        ws.send(JSON.stringify({ type: "flush", data: {} }));
      }
      // Finish once the audio has stopped arriving rather than always waiting
      // the full ceiling — the question samples are one short clause each, and
      // a flat 12s per render turned a 23-sample sweep into five minutes.
      const quiet = setInterval(() => {
        if (lastChunkAt && Date.now() - lastChunkAt > QUIET_MS) {
          clearInterval(quiet);
          finish();
        }
      }, 250);
      setTimeout(() => {
        clearInterval(quiet);
        finish();
      }, MAX_RENDER_MS);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        lastChunkAt = Date.now();
        return void parts.push(data as Buffer);
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && typeof msg.data?.audio === "string") {
          parts.push(Buffer.from(msg.data.audio, "base64"));
          lastChunkAt = Date.now();
        } else if (msg.type === "error" || msg.event === "error") {
          console.log(`  ${v.file.padEnd(30)} error: ${JSON.stringify(msg).slice(0, 140)}`);
        }
      } catch { /* non-JSON frame */ }
    });

    ws.on("error", (err) => {
      console.log(`  ${v.file.padEnd(30)} socket error: ${String(err).slice(0, 100)}`);
      finish();
    });
  });
}

async function main() {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: SARVAM_API_KEY");

  // Optional name prefix, so the question sweep can be re-run on its own
  // without re-rendering the voice-character set: npm run tts:samples -- q
  const filter = process.argv[2];
  const selected = filter ? VARIANTS.filter((v) => v.file.startsWith(filter)) : VARIANTS;
  if (selected.length === 0) {
    throw new Error(
      `No variants match "${filter}". Try "q" for the question set, or "r" for the script-drift pairs.`,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Rendering ${selected.length} samples to ${OUT_DIR}\n`);
  for (const v of selected) await render(v, apiKey);
  console.log(
    `\nDone. For the question set, play each pair back to back — q01a vs q01b,` +
      ` q02a vs q02b, and so on. The "a" file is the question. If "a" and "b"` +
      ` sound identical, the engine is ignoring the "?"; if some variant makes` +
      ` "a" rise, that variant is the fix.`,
  );
}

main();
