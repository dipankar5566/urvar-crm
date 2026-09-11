/**
 * Per-turn and per-call latency instrumentation for AI calls.
 *
 * Until this existed there was no latency measurement anywhere in the running
 * system — the only number in the repo came from the offline `eval:agent`
 * script — so every claim about the agent being faster or slower was an
 * opinion. Three sources measured the same thing this week and disagreed
 * (eval said 552ms median TTFT, a live probe said 393-472ms, and the 400ms
 * filler word fired on only ~42% of non-greeting turns), which is exactly
 * what this module exists to settle.
 *
 * Design constraints, all of them load-bearing:
 *
 *   - Nothing here may await, touch the network, or sit on the audio path.
 *     Everything is integer assignment into a plain object; the only output
 *     is one `console.log` per turn and one per call.
 *   - No transcript text, lead name or phone number is ever logged. Character
 *     counts and a language code carry the signal without putting customer
 *     speech into logs/ on a production box.
 *   - `Date.now()` rather than `performance.now()`, because timestamps are
 *     compared across module boundaries (openai-agent.ts reports the LLM's
 *     first token back as a plain number) and a shared wall clock is the only
 *     origin they both agree on. Millisecond resolution is ample for spans
 *     measured in hundreds of milliseconds.
 *   - logfmt, not JSON, so a line can be read with `grep -o 'ttft=[0-9]*'`
 *     on this Windows box without jq and without quoting pain.
 */

export type TurnTrigger = "greeting" | "final" | "queued";

/** Which barge-in path fired during this turn — see server.ts. */
export type BargeStage = "none" | "A" | "B" | "abort";

export type TurnMetrics = {
  callId: string;
  turn: number;
  trigger: TurnTrigger;
  /** When the lead stopped speaking (or the call connected, for a greeting). */
  startedAt: number;
  /** How long this utterance sat in `pendingUtterance` before being run,
   * counted from when the lead finished speaking rather than from when we
   * dequeued it — otherwise the metric hides precisely the worst turns. */
  queuedMs: number;
  llmRequestAt: number | null;
  firstTokenAt: number | null;
  /** First sentence handed to TTS. The gap between this and `firstTokenAt` is
   * our own sentence-chunking cost, which measured larger than the model's
   * own time to first token. */
  firstSentenceAt: number | null;
  firstTtsChunkAt: number | null;
  firstPlayAudioAt: number | null;
  endedAt: number | null;
  spokeFiller: boolean;
  interrupted: boolean;
  bargeStage: BargeStage;
  /** True when the turn ended because the provider timed out or errored, so a
   * stall rate can be read off the logs rather than guessed at. */
  stalled: boolean;
  hops: number;
  tools: string[];
  leadChars: number;
  replyChars: number;
  lang: string | null;
};

export function startTurn(
  callId: string,
  turn: number,
  trigger: TurnTrigger,
  startedAt: number,
  queuedMs = 0,
): TurnMetrics {
  return {
    callId,
    turn,
    trigger,
    startedAt,
    queuedMs,
    llmRequestAt: null,
    firstTokenAt: null,
    firstSentenceAt: null,
    firstTtsChunkAt: null,
    firstPlayAudioAt: null,
    endedAt: null,
    spokeFiller: false,
    interrupted: false,
    bargeStage: "none",
    stalled: false,
    hops: 0,
    tools: [],
    leadChars: 0,
    replyChars: 0,
    lang: null,
  };
}

/** Offset in ms from the turn's start, or -1 for "never happened". */
function offset(m: TurnMetrics, at: number | null): number {
  return at == null ? -1 : at - m.startedAt;
}

/**
 * One line per turn. PM2 is not configured with `time: true` and no existing
 * log line carries a timestamp, so this one carries its own rather than
 * reformatting every other line in the file.
 */
export function formatTurnLog(m: TurnMetrics): string {
  return [
    "[turn]",
    `ts=${new Date().toISOString()}`,
    `call=${m.callId}`,
    `turn=${m.turn}`,
    `trigger=${m.trigger}`,
    `queued=${m.queuedMs}`,
    `llm=${offset(m, m.llmRequestAt)}`,
    `ttft=${offset(m, m.firstTokenAt)}`,
    `sentence=${offset(m, m.firstSentenceAt)}`,
    `tts=${offset(m, m.firstTtsChunkAt)}`,
    `play=${offset(m, m.firstPlayAudioAt)}`,
    `total=${offset(m, m.endedAt)}`,
    `barge=${m.bargeStage}`,
    `filler=${m.spokeFiller ? 1 : 0}`,
    `stalled=${m.stalled ? 1 : 0}`,
    `hops=${m.hops}`,
    `tools=${m.tools.join("+") || "-"}`,
    `leadChars=${m.leadChars}`,
    `replyChars=${m.replyChars}`,
    `lang=${m.lang ?? "-"}`,
  ].join(" ");
}

/**
 * Audio-transport health for one call.
 *
 * The AI's media stream reaches this process through the same Cloudflare
 * Tunnel that serves the CRM website, and a hairpin probe measured a warm
 * round trip of 143-167ms with repeated spikes past 1.7s. Those were HTTP
 * probes rather than real Plivo traffic, so instead of re-architecting on
 * that evidence these counters measure the real thing: if inter-arrival p90
 * passes ~200ms, or frame gaps over 500ms appear on more than a few percent
 * of calls, the transport is the bottleneck and not the pipeline.
 */
export type FrameStats = {
  lastFrameAt: number | null;
  /** Inter-arrival deltas in ms. Capped: a 5-minute call at 50 frames/s is
   * 15k entries, and past the cap the percentile is already well determined. */
  gaps: number[];
  /** Deltas over 500ms — an audible hole in the inbound audio. */
  longGaps: number;
};

const MAX_GAP_SAMPLES = 20_000;

export function newFrameStats(): FrameStats {
  return { lastFrameAt: null, gaps: [], longGaps: 0 };
}

export function recordFrame(stats: FrameStats, now: number): void {
  if (stats.lastFrameAt != null) {
    const delta = now - stats.lastFrameAt;
    if (stats.gaps.length < MAX_GAP_SAMPLES) stats.gaps.push(delta);
    if (delta > 500) stats.longGaps++;
  }
  stats.lastFrameAt = now;
}

/** Nearest-rank percentile. Sorts a copy, and is only ever called once per
 * call at finalize — never on the audio path. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
}

export type CallMetricsSnapshot = {
  callId: string;
  durationSec: number;
  turns: number;
  interrupts: number;
  bargeAborts: number;
  stalls: number;
  /** Derived from bytes actually sent to Plivo at 16kHz 16-bit mono. Excludes
   * audio held and then dropped, but does count audio sent and then killed
   * mid-playback by clearAudio — a known small over-count, recorded here
   * rather than dressed up as exact. */
  aiTalkSec: number;
  /** Summed from VAD speech_start/speech_end. Null when two-stage barge-in is
   * switched off, so a disabled feature never reports a silent lead. */
  leadTalkSec: number | null;
  ttftP50: number;
  ttftP90: number;
  totalP50: number;
  totalP90: number;
  frameGapP50: number;
  frameGapP90: number;
  frameGapMax: number;
  longGaps: number;
  clearAckP50: number;
};

export function formatCallLog(c: CallMetricsSnapshot): string {
  return [
    "[call-metrics]",
    `ts=${new Date().toISOString()}`,
    `call=${c.callId}`,
    `durationSec=${c.durationSec}`,
    `turns=${c.turns}`,
    `interrupts=${c.interrupts}`,
    `bargeAborts=${c.bargeAborts}`,
    `stalls=${c.stalls}`,
    `aiTalkSec=${c.aiTalkSec}`,
    `leadTalkSec=${c.leadTalkSec ?? "-"}`,
    `ttftP50=${c.ttftP50}`,
    `ttftP90=${c.ttftP90}`,
    `totalP50=${c.totalP50}`,
    `totalP90=${c.totalP90}`,
    `frameGapP50=${c.frameGapP50}`,
    `frameGapP90=${c.frameGapP90}`,
    `frameGapMax=${c.frameGapMax}`,
    `longGaps=${c.longGaps}`,
    `clearAckP50=${c.clearAckP50}`,
  ].join(" ");
}
