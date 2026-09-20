/**
 * AI Voice Agent media server.
 *
 * Phase 0 built the transport (HTTP health check + two WS paths). Phase 1
 * wires in the real pipeline for AI_ASSISTED calls: Plivo's <Stream> audio
 * -> Sarvam streaming STT -> a rolling transcript, occasionally handed to
 * Claude for a short suggestion, pushed live to the browser's live-assist
 * panel over the paired /assist/{callId} connection. At stream stop, the
 * full transcript is summarized and written to the Call row.
 *
 * This process is a trusted backend peer of the Next.js app (same trust
 * model as the Plivo webhook routes: signature/token validation instead of
 * a user session) — it talks to the same Postgres database directly via the
 * generated Prisma client.
 *
 * Run via `npx tsx voice-agent/server.ts` (see ecosystem.config.js for the
 * PM2 entry) — same tsx-for-standalone-scripts convention as
 * `prisma/clean-demo-data.ts` (`npm run db:clean-demo`).
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaPg } from "@prisma/adapter-pg";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { verifyAssistToken } from "../src/lib/voice-agent-token.js";
import { plivoClient } from "../src/lib/plivo.js";
import {
  createSarvamSttSession,
  type SarvamSttSession,
  type SttVadEvent,
} from "./pipeline/sarvam-stt.js";
import { createSarvamTtsSession, type SarvamTtsSession } from "./pipeline/sarvam-tts.js";
import {
  resolveTtsLanguageWithSource,
  languageName,
  fillerWord,
  closingLine,
  holdingLine,
  type SarvamTtsLanguage,
  type TtsLanguageSource,
} from "./pipeline/tts-language.js";
import {
  isBackchannel,
  classifyInterrupt,
  stripLeadingAcknowledgement,
} from "./pipeline/backchannel.js";
import { toSpeakableText } from "./pipeline/voice-output.js";
import {
  startTurn,
  formatTurnLog,
  formatCallLog,
  newFrameStats,
  recordFrame,
  percentile,
  type TurnMetrics,
  type TurnTrigger,
  type FrameStats,
  type CallMetricsSnapshot,
} from "./pipeline/turn-metrics.js";
import { detectLanguage } from "./pipeline/detect-language.js";
import {
  maybeGenerateSuggestion,
  summarizeCall,
  extractCallFacts,
  type CallSummary,
  type CallFacts,
} from "./pipeline/openai-assist.js";
import {
  buildSystemPrompt,
  runAgentTurn,
  type LeadBrief,
  type ProductBrief,
  type PriorCallBrief,
} from "./pipeline/openai-agent.js";
import { isKnowledgeGraphEnabled, startKeepAlive } from "./lib/neo4j.js";
import { resolveGraphFacts, EMPTY_GRAPH_FACTS, type GraphFactsBrief } from "./lib/graph-facts.js";
import { recordCallOutcome } from "./tools/crm-tools.js";

const SUGGESTION_MIN_INTERVAL_MS = 8000;
// Safety-net if Plivo's checkpoint/playedStream mechanism (used to hang up
// only once the AI's farewell has actually finished playing) doesn't fire
// as expected — never leave a call open indefinitely after end_call.
const HANGUP_FALLBACK_TIMEOUT_MS = 8000;

// The model cannot be relied on to call end_call — on 2026-09-10 it never
// did, so a finished conversation just sat there until the lead hung up.
// These are server-side guards that don't depend on it behaving.
/** Nobody talking — neither side — for this long ends the call. */
const SILENCE_HANGUP_MS = 15_000;
/** Hard ceiling on an AI call; real qualification calls run 90-155s. */
const MAX_CALL_MS = 5 * 60 * 1000;
/** If the model hasn't produced a speakable fragment this fast, say a
 * one-word acknowledgement so the lead isn't listening to silence.
 *
 * Was 400ms, which is inside the normal spread of the model's own time to
 * first sentence (350-450ms in the logs), so the filler was firing on a
 * quarter of everything the agent said — 203 of 766 utterances. A filler is a
 * latency cover, not a personality trait (docs/VOICE_PERSONA.md); at that rate
 * it becomes the personality. 600ms only covers turns that are genuinely
 * slow. */
const FILLER_DELAY_MS = 600;
/** Time allowed for a closing line to play before the line is dropped. */
const CLOSING_PLAY_MS = 4000;

// Two-stage barge-in. Until this existed the interrupt could not fire until
// Sarvam emitted a *final* transcript, which needs silence_duration_ms (300ms)
// of quiet after the lead stops — so the AI talked over them for the whole
// length of their sentence plus 300ms. Stage A reacts to speech onset, Stage B
// commits once the partial proves it was real speech and not a cough.
/** Longest an unresolved VAD hit may hold TTS audio before we conclude it was
 * noise and resume. Covers silence_duration_ms=300 plus partial jitter, and is
 * short enough to be inaudible given Plivo is usually holding a queue. Tune
 * from the `[turn]` logs rather than by feel. */
const BARGE_HOLD_MAX_MS = 600;
/** ~2s of 16kHz 16-bit mono. Second safety net, in case the timer is starved. */
const HELD_AUDIO_MAX_BYTES = 64_000;
/** Bytes of 16kHz 16-bit mono audio per millisecond — one millisecond is
 * exactly 32 bytes, which is what lets playback time be computed locally
 * rather than waited on. */
const AUDIO_BYTES_PER_MS = 32;
/** How long to assume we are speaking after handing text to TTS but before any
 * of its audio has arrived. Measured first-byte latency is ~230ms, so this only
 * has to outlast that; erring short risks an extra turn, erring long costs the
 * caller silence, and silence is the worse failure. */
const TTS_FIRST_BYTE_GRACE_MS = 800;
/** Kill switch, same revert-in-seconds pattern as VOICE_AGENT_LLM_PROVIDER:
 * set to "final-only" and restart to get exactly the previous behaviour. */
const TWO_STAGE_BARGE_IN = (process.env.VOICE_AGENT_BARGE_IN ?? "two-stage") !== "final-only";

/** How long to hold a single-word, non-backchannel final before dispatching
 * it as its own agent turn, in case it was only the first fragment of one
 * answer that Sarvam's VAD (silence_duration_ms=300) split on a mid-sentence
 * pause. Real bug: a lead answering "Amra ... Harmicompost" (2026-09-13,
 * cmtzvvkuy) arrived as two finals, and the agent answered "Amra" alone with
 * an apology plus a verbatim repeat of its own question. 600ms comfortably
 * clears the 300ms VAD gap without being long enough to read as a stall. */
const FRAGMENT_COALESCE_MS = Number(process.env.VOICE_AGENT_COALESCE_MS) || 600;

/** Agreeing /text-lid detections needed before the voice switches language.
 * One was enough under the old code, and one is exactly what the mis-heard
 * "Ice cream" (STT confidence 0.12) needed to relanguage a Bengali farmer to
 * Telugu for every subsequent call. */
const LANGUAGE_SWITCH_VOTES = 2;
/** How often a pending voice switch re-checks whether the agent has stopped
 * talking. The switch rebuilds the TTS socket and drops audio in flight, so
 * it has to land in a gap. */
const LANGUAGE_SWITCH_RETRY_MS = 300;

/**
 * True only for a single content word that isn't a recognized backchannel
 * ("haan", "achha", ...) — i.e. it reads like the start of a sentence that
 * got cut off, not a complete short answer. Deliberately narrow: a number or
 * short phrase ("6 ton", "15 tarikh") is two tokens and dispatches at once,
 * so this only adds latency to the specific shape that caused the bug.
 */
function looksLikeFragment(text: string): boolean {
  const words = text
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 1 && !isBackchannel(text);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PORT = Number(process.env.VOICE_AGENT_PORT ?? 3010);

type CallSession = {
  mode: "AI_ASSISTED" | "AI_AUTONOMOUS";
  leadId: string | null;
  /**
   * Set only when this Lead has actually converted to a Customer
   * (`Customer.sourceLeadId`), resolved once here rather than trusted from
   * anything the caller says. `get_account_status` (Phase 6) refuses to
   * disclose any figure while this is null — a Lead who hasn't converted has
   * no account to report on, and this is never guessed from a name or phone
   * number match, only this one authoritative relation.
   */
  customerId: string | null;
  // Fetched alongside the Call row in handlePlivoStream so the greeting's
  // critical path doesn't need a second query, and so the TTS voice
  // language can be picked from the lead's state before the socket opens.
  leadName: string | null;
  leadState: string | null;
  /** Qualification facts injected into the system prompt so the agent
   * doesn't burn a get_lead_context round trip on what we already know. */
  leadBrief: Omit<LeadBrief, "name">;
  /** The whole catalogue, loaded once at connect. Small enough to inline, and
   * inlining it removes a tool round trip from price questions — the turns
   * that decide a sale and, measured, the slowest in the call. */
  products: ProductBrief[];
  /** What happened on the last few calls to this lead, so the agent stops
   * re-asking things they already answered. */
  priorCalls: PriorCallBrief[];
  /** Knowledge-graph facts for this lead's district/crop, resolved once at
   * connect (see the preload block in handlePlivoStream) — empty unless
   * KNOWLEDGE_GRAPH_ENABLED is on and a district/crop actually matched a
   * graph node. See voice-agent/lib/graph-facts.ts. */
  graphFacts: GraphFactsBrief;
  providerCallSid: string | null;
  transcriptSegments: string[];
  assistSocket: WebSocket | null;
  sttSession: SarvamSttSession | null;
  ttsSession: SarvamTtsSession | null;
  plivoWs: WebSocket | null;
  agentHistory: ChatCompletionMessageParam[];
  agentTurnInFlight: boolean;
  /** When the audio we have actually sent will finish playing, computed from
   * bytes sent rather than waited on. Plivo's `playedStream` ack is the
   * documented signal but it is not dependable — on one call it never arrived
   * at all, leaving the agent permanently "still speaking", which silently
   * swallowed every lead utterance as a backchannel for 44 seconds. */
  audioPlayingUntil: number;
  /** Covers the gap between handing text to TTS and its first audio arriving,
   * so a turn isn't treated as finished before it has made a sound. */
  speechPendingUntil: number;
  /** Bumped per utterance so each checkpoint ack maps to its own utterance
   * and a stale ack can't clear a newer one. */
  utteranceSeq: number;
  /** Bumped once per *filler*, which utteranceSeq is not — every streamed
   * sentence, closing line and holding line bumps that one too, so handing it
   * to fillerWord() produced no cycle at all and one word came up 47 times in
   * a single log. */
  fillerSeq: number;
  /** The last filler this call spoke, so the next pick can step past it. 32 of
   * the 203 logged fillers immediately repeated the one before. */
  lastFiller: string | null;
  /** Set when a real barge-in happens, so the in-flight streamed reply stops
   * queueing further sentences. */
  cancelTurn: boolean;
  /** Something the lead said while a reply was still generating, held so it
   * gets answered instead of dropped. */
  pendingUtterance: string | null;
  /** Holds a single-word, non-backchannel final for FRAGMENT_COALESCE_MS in
   * case Sarvam's VAD split one answer across a short mid-sentence pause
   * ("Amra" / "Harmicompost" on one real call) — see looksLikeFragment. */
  coalesceTimer: NodeJS.Timeout | null;
  coalesceText: string | null;
  coalesceSpokeAt: number | null;
  coalesceInterrupted: boolean;
  /** How many times each candidate language has been detected this call.
   * A switch needs LANGUAGE_SWITCH_VOTES agreeing detections — one is what
   * let the mis-heard "Ice cream" relanguage a lead to Telugu. */
  languageVotes: Map<SarvamTtsLanguage, number>;
  /** At most one voice switch per call. A second one costs another socket
   * rebuild with audio dropped, and past the first it says more about STT
   * noise on a code-switching line than about the lead. */
  languageSwitched: boolean;
  /** A switch waiting for the agent to stop talking — see
   * switchVoiceLanguage. */
  languageSwitchTimer: NodeJS.Timeout | null;
  endingCall: boolean;
  /** Set when the call was handed to a rep, so the wrap-up guard records
   * TRANSFERRED_TO_HUMAN instead of inventing a CONNECTED outcome. */
  transferred: boolean;
  /** Voice language for this call, reused by the server's own spoken lines
   * (filler, closing) so they match what the agent is speaking. */
  languageCode: SarvamTtsLanguage;
  /** Which rule picked `languageCode` at call start, for the log line — a
   * lead opening in an unexpected language should be one grep, not a
   * reconstruction. */
  languageSource: TtsLanguageSource;
  silenceTimer: NodeJS.Timeout | null;
  maxCallTimer: NodeJS.Timeout | null;
  /** When MAX_CALL_MS runs out, as an absolute time, so a cancelled wrap-up
   * can re-arm the cap for the time actually left on it. */
  maxCallDeadline: number;
  /** The pending hangup from an *automatic* wrap-up (silence, max-duration),
   * kept so a lead who answers during the goodbye can call it off. A
   * model-decided end_call deliberately leaves none: it already said its
   * farewell and is meant to end. */
  wrapUpTimer: NodeJS.Timeout | null;
  fillerTimer: NodeJS.Timeout | null;
  lastSuggestionAt: number;
  suggestionInFlight: boolean;
  finalized: boolean;

  // --- Two-stage barge-in ---
  /** How TTS audio is routed right now. "holding" is a provisional barge-in —
   * Stage A, nothing destroyed yet. A committed barge-in doesn't need a gate
   * state: it resets the TTS socket so the cancelled audio never arrives. */
  ttsGate: "open" | "holding";
  heldAudio: Buffer[];
  heldAudioBytes: number;
  /** Which VAD utterance opened the current hold, so a stale partial from an
   * earlier utterance cannot commit or abort it. */
  holdUtteranceIdx: number | null;
  holdTimer: NodeJS.Timeout | null;
  holdStartedAt: number | null;
  /** Stage B already stopped playback; the final still has to tell the model
   * it was cut off. */
  bargeCommitted: boolean;
  vadStartedAt: number | null;

  // --- Telemetry (see pipeline/turn-metrics.ts) ---
  currentTurn: TurnMetrics | null;
  turnCount: number;
  interruptionCount: number;
  bargeAbortCount: number;
  stallCount: number;
  ttsBytesSent: number;
  leadSpeechMs: number;
  callStartedAt: number;
  frameStats: FrameStats;
  ttftSamples: number[];
  totalSamples: number[];
  clearAckSamples: number[];
  clearSentAt: number | null;
  /** When the lead finished the utterance now sitting in `pendingUtterance`,
   * so a queued turn's latency is measured from their speech, not from the
   * moment we got round to it. */
  pendingUtteranceAt: number | null;
  lastLanguage: string | null;
};

const sessions = new Map<string, CallSession>();

type LeadRow = {
  name: string;
  state: string;
  preferredLanguage: string | null;
  district: string;
  status: string;
  customerType: string;
  interestedProducts: string | null;
  expectedQuantity: string | null;
  cropInterest: string | null;
  remarks: string | null;
  convertedCustomer: { id: string } | null;
};

function createSession(
  mode: CallSession["mode"],
  leadId: string | null,
  lead?: LeadRow | null,
  products: ProductBrief[] = [],
  priorCalls: PriorCallBrief[] = [],
  graphFacts: GraphFactsBrief = EMPTY_GRAPH_FACTS,
): CallSession {
  const languageResolution = resolveTtsLanguageWithSource(
    lead?.state ?? null,
    lead?.preferredLanguage ?? null,
  );
  return {
    mode,
    leadId,
    customerId: lead?.convertedCustomer?.id ?? null,
    leadName: lead?.name ?? null,
    leadState: lead?.state ?? null,
    leadBrief: {
      state: lead?.state ?? null,
      district: lead?.district ?? null,
      status: lead?.status ?? null,
      customerType: lead?.customerType ?? null,
      interestedProducts: lead?.interestedProducts ?? null,
      expectedQuantity: lead?.expectedQuantity ?? null,
      cropInterest: lead?.cropInterest ?? null,
      remarks: lead?.remarks ?? null,
    },
    products,
    priorCalls,
    graphFacts,
    providerCallSid: null,
    transcriptSegments: [],
    assistSocket: null,
    sttSession: null,
    ttsSession: null,
    plivoWs: null,
    agentHistory: [],
    agentTurnInFlight: false,
    audioPlayingUntil: 0,
    speechPendingUntil: 0,
    utteranceSeq: 0,
    fillerSeq: 0,
    lastFiller: null,
    cancelTurn: false,
    pendingUtterance: null,
    coalesceTimer: null,
    coalesceText: null,
    coalesceSpokeAt: null,
    coalesceInterrupted: false,
    languageVotes: new Map(),
    languageSwitched: false,
    languageSwitchTimer: null,
    endingCall: false,
    transferred: false,
    // A rep's explicit choice on the lead beats the guess made from their
    // state, which is only a proxy and is wrong for anyone who has moved.
    // Falls back to the state map when no rep has set one.
    languageCode: languageResolution.code,
    languageSource: languageResolution.source,
    silenceTimer: null,
    maxCallTimer: null,
    maxCallDeadline: 0,
    wrapUpTimer: null,
    fillerTimer: null,
    lastSuggestionAt: 0,
    suggestionInFlight: false,
    finalized: false,

    ttsGate: "open",
    heldAudio: [],
    heldAudioBytes: 0,
    holdUtteranceIdx: null,
    holdTimer: null,
    holdStartedAt: null,
    bargeCommitted: false,
    vadStartedAt: null,

    currentTurn: null,
    turnCount: 0,
    interruptionCount: 0,
    bargeAbortCount: 0,
    stallCount: 0,
    ttsBytesSent: 0,
    leadSpeechMs: 0,
    callStartedAt: Date.now(),
    frameStats: newFrameStats(),
    ttftSamples: [],
    totalSamples: [],
    clearAckSamples: [],
    clearSentAt: null,
    pendingUtteranceAt: null,
    lastLanguage: null,
  };
}

/** Used only by the Phase 1 assist WS, which can connect before the Plivo
 * stream does — AI_AUTONOMOUS sessions are always created by handlePlivoStream
 * itself, once it knows the call's mode/leadId from the DB. */
function getOrCreateAssistSession(callId: string): CallSession {
  let session = sessions.get(callId);
  if (!session) {
    session = createSession("AI_ASSISTED", null);
    sessions.set(callId, session);
  }
  return session;
}

/**
 * Speaks one utterance and asks Plivo to tell us when it has finished
 * playing, via the same checkpoint/playedStream pair the farewell hangup
 * already relies on. Without this the process has no idea whether audio it
 * handed over seconds ago is still playing.
 */
function speakWithCheckpoint(session: CallSession, text: string) {
  if (!session.ttsSession) return;
  // Hold the "we are speaking" state open until this utterance's audio shows
  // up, so the gap between handing text to TTS and hearing it back isn't
  // mistaken for the turn having ended.
  session.speechPendingUntil = Date.now() + TTS_FIRST_BYTE_GRACE_MS;
  // Single choke point for everything the caller hears — streamed sentences,
  // filler words, the closing line and the holding line — so the speech
  // filter cannot be bypassed by adding another call site later.
  session.ttsSession.speak(toSpeakableText(text));
  if (session.plivoWs?.readyState === WebSocket.OPEN) {
    session.plivoWs.send(JSON.stringify({ event: "checkpoint", name: `utt-${session.utteranceSeq}` }));
  }
}

/**
 * Ends a call the model failed to end itself: says a short goodbye in the
 * lead's language, then hangs up. Deliberately does not ask the model to
 * produce the closing line — the whole point of these guards is that they
 * work when the model isn't cooperating.
 */
function wrapUpCall(session: CallSession, callId: string, reason: string) {
  if (session.endingCall || session.finalized) return;
  session.endingCall = true;
  clearCallTimers(session);
  console.log(`[call ${callId}] wrapping up automatically (${reason})`);

  session.utteranceSeq += 1;
  speakWithCheckpoint(session, closingLine(session.languageCode));
  // Nothing follows this line, so it would otherwise sit in Sarvam's buffer
  // until the socket closed — i.e. the goodbye would never be heard.
  session.ttsSession?.flush();
  session.wrapUpTimer = setTimeout(
    () => hangUpAutonomousCall(session, callId, reason),
    CLOSING_PLAY_MS,
  );
}

/**
 * Calls off an automatic wrap-up because the lead turned out to be there
 * after all. The silence guard can only fire on a timer, and a lead drawing
 * breath — or one whose sentence Sarvam had not finalized yet — used to be
 * hung up on mid-question: 7 of the 33 calls logged to 2026-09-18 threw away
 * the lead's next utterance as they dropped, including a 30t/month
 * distributor asking what else we stock.
 *
 * Only ever cancels a wrap-up *this server* started. `end_call` sets
 * endingCall without a wrapUpTimer, so a farewell the model chose still ends
 * the call.
 */
function cancelWrapUp(session: CallSession, callId: string) {
  if (!session.wrapUpTimer || session.finalized) return;
  clearTimeout(session.wrapUpTimer);
  session.wrapUpTimer = null;
  session.endingCall = false;
  console.log(`[call ${callId}] wrap-up cancelled — the lead is still on the line`);
  // wrapUpCall cleared every call timer on its way out; the hard cap has to
  // come back or this call now has no ceiling at all.
  const remaining = session.maxCallDeadline - Date.now();
  session.maxCallTimer = setTimeout(
    () => wrapUpCall(session, callId, "max-duration"),
    Math.max(0, remaining),
  );
  armSilenceTimer(session, callId);
}

/** Restarted on every sign of life from either side. */
function armSilenceTimer(session: CallSession, callId: string) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  if (session.endingCall || session.finalized) return;
  // The clock has to run from when the caller stops *hearing* us, not from
  // when the model stopped generating. speakWithCheckpoint hands Plivo a
  // checkpoint at speak() time, before that utterance's audio exists, so
  // Plivo acks it the instant its queue drains — routinely with a whole
  // answer still to synthesize. Arming a flat 15s there hung up on three of
  // the four calls made on 2026-09-18, each one mid-sentence.
  const audibleUntil = Math.max(session.audioPlayingUntil, session.speechPendingUntil);
  const audibleFor = Math.max(0, audibleUntil - Date.now());
  session.silenceTimer = setTimeout(() => {
    // Audio keeps arriving after the timer is armed — that is the whole
    // failure above — so the deadline is re-checked on expiry rather than
    // trusted from arming time.
    if (isSpeaking(session)) {
      armSilenceTimer(session, callId);
      return;
    }
    wrapUpCall(session, callId, "silence-timeout");
  }, audibleFor + SILENCE_HANGUP_MS);
}

function clearCallTimers(session: CallSession) {
  for (const t of [
    session.silenceTimer,
    session.maxCallTimer,
    session.fillerTimer,
    session.holdTimer,
    session.coalesceTimer,
    // Safe for wrapUpCall to clear: it arms its own hangup *after* this runs.
    session.wrapUpTimer,
    session.languageSwitchTimer,
  ]) {
    if (t) clearTimeout(t);
  }
  session.silenceTimer = null;
  session.maxCallTimer = null;
  session.wrapUpTimer = null;
  session.fillerTimer = null;
  session.holdTimer = null;
  session.coalesceTimer = null;
  session.languageSwitchTimer = null;
}

function pushToAssist(session: CallSession, message: unknown) {
  if (session.assistSocket && session.assistSocket.readyState === WebSocket.OPEN) {
    session.assistSocket.send(JSON.stringify(message));
  }
}

/**
 * Records the outcome the model was supposed to record itself.
 *
 * `end_call` is the only thing that writes an outcome, and it fires only if
 * the model chooses to call it — unreliable on both providers, and a lead who
 * hangs up mid-sentence never gives it the chance. The server-side wrap-up
 * guards (silence, 5-minute cap) hang the call up but wrote nothing either.
 * The result: a two-minute qualification call with a full transcript and
 * summary, no outcome, and no task telling a rep to follow it up — 9 of 20
 * real AI conversations as of 2026-09-11.
 *
 * Only ever fills a blank. Anything `end_call` already recorded wins.
 */
async function recordOutcomeIfMissing(callId: string, session: CallSession, transcript: string) {
  if (session.mode !== "AI_AUTONOMOUS" || !session.leadId) return;
  // Nobody said anything — a wrap-up task for a silent connect is noise, and
  // the retry is the dialer's job, not a rep's.
  if (!transcript) return;

  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { outcome: true },
    });
    if (!call || call.outcome) return;

    const outcome = session.transferred ? "TRANSFERRED_TO_HUMAN" : "CONNECTED";
    await recordCallOutcome(prisma, {
      callId,
      leadId: session.leadId,
      outcome,
      createFollowUp: !session.transferred,
      auto: true,
    });
    console.log(`[call ${callId}] outcome auto-recorded as ${outcome} (end_call never ran)`);
  } catch (err) {
    console.error(`[call ${callId}] auto-outcome failed`, err);
  }
}

/** Emits the pending turn's telemetry line, once its audio timings have had a
 * chance to be filled in. Safe to call repeatedly. */
function flushTurnLog(session: CallSession) {
  if (!session.currentTurn) return;
  console.log(formatTurnLog(session.currentTurn));
  session.currentTurn = null;
}

/** Gathered once, then used twice: the log line and the stored `aiMetrics`. */
function callMetrics(callId: string, session: CallSession): CallMetricsSnapshot {
  const { gaps, longGaps } = session.frameStats;
  return {
    callId,
    durationSec: Math.round((Date.now() - session.callStartedAt) / 1000),
    turns: session.turnCount,
    interrupts: session.interruptionCount,
    bargeAborts: session.bargeAbortCount,
    stalls: session.stallCount,
    aiTalkSec: Math.round(session.ttsBytesSent / 32_000),
    leadTalkSec: TWO_STAGE_BARGE_IN ? Math.round(session.leadSpeechMs / 1000) : null,
    ttftP50: percentile(session.ttftSamples, 0.5),
    ttftP90: percentile(session.ttftSamples, 0.9),
    totalP50: percentile(session.totalSamples, 0.5),
    totalP90: percentile(session.totalSamples, 0.9),
    frameGapP50: percentile(gaps, 0.5),
    frameGapP90: percentile(gaps, 0.9),
    frameGapMax: gaps.length ? Math.max(...gaps) : -1,
    longGaps,
    clearAckP50: percentile(session.clearAckSamples, 0.5),
  };
}

async function finalizeSession(callId: string, session: CallSession) {
  if (session.finalized) return;
  session.finalized = true;
  clearCallTimers(session);
  // The last turn of the call has no successor to flush it.
  flushTurnLog(session);

  session.sttSession?.close();
  session.ttsSession?.close();
  const fullTranscript = session.transcriptSegments.join(" ").trim();
  const agentVersion = session.mode === "AI_AUTONOMOUS" ? "phase2-autonomous-v1" : "phase1-call-assist-v1";

  // Summarizing is a network call to a third-party LLM; the transcript is
  // already in hand. Sharing one try block meant a summarizer timeout took
  // the transcript down with it — and this is its only copy, since the
  // session is dropped at the end of this function. A failed summary now
  // costs the summary and nothing else.
  // Run together: both are independent reads of the same finished transcript,
  // and the call is already over so nothing is waiting on them but this write.
  let summary: CallSummary | null = null;
  let facts: CallFacts | null = null;
  const [summaryResult, factsResult] = await Promise.allSettled([
    summarizeCall(fullTranscript),
    extractCallFacts(fullTranscript),
  ]);
  if (summaryResult.status === "fulfilled") summary = summaryResult.value;
  else console.error(`[call ${callId}] summarize failed — saving transcript without it`, summaryResult.reason);
  if (factsResult.status === "fulfilled") facts = factsResult.value;
  else console.error(`[call ${callId}] fact extraction failed — saving transcript without it`, factsResult.reason);

  const metrics = callMetrics(callId, session);

  try {
    await prisma.call.update({
      where: { id: callId },
      data: {
        transcript: session.transcriptSegments,
        aiAgentVersion: agentVersion,
        // Piggybacks on the write that already happens here — no extra query,
        // and nothing on the audio path.
        aiMetrics: metrics as unknown as object,
        ...(facts ? { aiStructured: facts as unknown as object } : {}),
        ...(summary
          ? {
              aiSummary: summary.summary,
              aiSentiment: summary.sentiment,
              aiIntentTags: summary.intentTags,
            }
          : {}),
      },
    });
    pushToAssist(session, {
      type: "call-ended",
      summary: summary?.summary ?? "",
      sentiment: summary?.sentiment ?? null,
    });
    console.log(
      `[call ${callId}] finalized (${session.mode}): ${summary ? summary.summary.slice(0, 80) : "(summary unavailable)"}`,
    );
  } catch (err) {
    console.error(`[call ${callId}] finalize failed`, err);
  }

  await recordOutcomeIfMissing(callId, session, fullTranscript);

  // One line per call, carrying the audio-transport health that decides
  // whether the Cloudflare Tunnel in front of this process is the real
  // bottleneck: if frameGapP90 climbs past ~200ms, or longGaps is routinely
  // non-zero, the transport is the problem rather than the pipeline.
  console.log(formatCallLog(metrics));

  sessions.delete(callId);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    prisma.$queryRaw`SELECT 1`
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", db: "connected" }));
      })
      .catch((err: unknown) => {
        console.error("[health] db check failed", err);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", db: "unreachable" }));
      });
    return;
  }
  res.writeHead(404);
  res.end();
});

// perMessageDeflate does synchronous zlib work on the main thread per
// message; with one call already streaming ~43 audio frames/sec, that's
// enough main-thread work to risk delaying a second, simultaneous call's
// WS upgrade past Plivo's own connect timeout (a real candidate for the
// intermittent "Plivo's <Stream> never reaches this process" failures —
// see the AI Voice Agent investigation plan). 16kHz linear PCM barely
// compresses anyway, so there's no real loss turning it off.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

httpServer.on(
  "upgrade",
  (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/plivo-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => handlePlivoStream(ws, url));
      return;
    }

    const assistMatch = url.pathname.match(/^\/assist\/([^/]+)$/);
    if (assistMatch) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        handleAssistConnection(ws, assistMatch[1], url),
      );
      return;
    }

    socket.destroy();
  },
);

/** Sends a playAudio message for one TTS chunk — field shapes confirmed
 * against Plivo's own Audio Streaming docs (fetched directly, not assumed):
 * contentType without the rate suffix, sampleRate as a separate field. */
function sendPlayAudio(ws: WebSocket, chunk: Buffer) {
  ws.send(
    JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-l16", sampleRate: 16000, payload: chunk.toString("base64") },
    }),
  );
}

/**
 * Every byte of synthesized audio passes through here, which is what makes a
 * barge-in able to stop mid-sentence.
 *
 * Before this existed, `cancelTurn` stopped the model queueing *more*
 * sentences but the sentence already handed to TTS kept streaming, and its
 * chunks were forwarded unconditionally — so after `clearAudio` the tail of
 * the cancelled line played anyway and the AI carried on over the lead.
 *
 * Deliberately has no logging: this runs dozens of times per turn.
 */
/**
 * Whether the caller can currently hear us.
 *
 * Derived from audio we have actually sent plus a short grace for audio still
 * being synthesized — deliberately not from Plivo's `playedStream` ack, which
 * a real call proved can simply never arrive.
 */
function isSpeaking(session: CallSession): boolean {
  return Date.now() < Math.max(session.audioPlayingUntil, session.speechPendingUntil);
}

function routeTtsChunk(session: CallSession, callId: string, chunk: Buffer) {
  const ws = session.plivoWs;
  if (ws?.readyState !== WebSocket.OPEN) return;

  if (session.ttsGate === "holding") {
    session.heldAudio.push(chunk);
    session.heldAudioBytes += chunk.length;
    if (session.heldAudioBytes >= HELD_AUDIO_MAX_BYTES) {
      resumeHeldAudio(session, callId, "buffer-cap");
    }
    return;
  }

  sendPlayAudio(ws, chunk);
  session.ttsBytesSent += chunk.length;
  // Plivo plays what we send in order, so each chunk extends the end of
  // playback by exactly its own duration.
  session.audioPlayingUntil =
    Math.max(Date.now(), session.audioPlayingUntil) + chunk.length / AUDIO_BYTES_PER_MS;
  // Real audio is flowing, so the pre-audio grace has served its purpose.
  session.speechPendingUntil = 0;
  if (session.currentTurn && session.currentTurn.firstPlayAudioAt === null) {
    session.currentTurn.firstPlayAudioAt = Date.now();
  }
}

/** Stage A — speech onset. Holds new audio without destroying anything, so
 * this is free to be wrong: a cough resumes with the line intact. */
function beginHold(session: CallSession, callId: string, event: SttVadEvent) {
  session.vadStartedAt = Date.now();
  // A second VAD hit inside an existing hold must not restart the deadline.
  if (session.ttsGate !== "open") return;
  // Only hold once real audio is already queued at Plivo. Holding the *first*
  // chunk of an utterance leaves Plivo sitting behind a checkpoint we have
  // already sent it with nothing to play through, and it then never acks —
  // which stranded call cmtxegf29 in permanent "still speaking" state and
  // cost it every turn after the greeting.
  if (session.audioPlayingUntil <= Date.now()) return;

  session.ttsGate = "holding";
  session.holdUtteranceIdx = event.utteranceIdx;
  session.holdStartedAt = Date.now();
  if (session.currentTurn && session.currentTurn.bargeStage === "none") {
    session.currentTurn.bargeStage = "A";
  }
  if (session.holdTimer) clearTimeout(session.holdTimer);
  session.holdTimer = setTimeout(
    () => resumeHeldAudio(session, callId, "hold-timeout"),
    BARGE_HOLD_MAX_MS,
  );
  console.log(
    `[call ${callId}] barge stage=A utt=${event.utteranceIdx ?? "?"} conf=${event.confidence ?? "?"}`,
  );
}

/** Stage B — the interruption is real. This is the point of no return: audio
 * the lead is hearing gets destroyed. */
function commitBargeIn(
  session: CallSession,
  callId: string,
  via: "partial" | "final",
  text: string,
) {
  if (session.holdTimer) {
    clearTimeout(session.holdTimer);
    session.holdTimer = null;
  }
  const heldMs = session.holdStartedAt ? Date.now() - session.holdStartedAt : 0;
  const dropped = session.heldAudio.length;
  session.heldAudio = [];
  session.heldAudioBytes = 0;
  session.holdStartedAt = null;

  session.cancelTurn = true;
  session.bargeCommitted = true;
  session.ttsGate = "open";
  session.interruptionCount++;
  // We just told Plivo to drop its queue, so nothing of ours is audible.
  session.audioPlayingUntil = 0;
  session.speechPendingUntil = 0;
  // Sarvam keeps synthesizing the sentence we just abandoned and its frames
  // carry no utterance id, so a time window cannot tell that tail apart from
  // the next reply — on call cmtxep7wb the leftover audio reached the caller
  // 3.7s before the new turn had written a word, and the two played together.
  // Replacing the socket is what actually stops it.
  session.ttsSession?.reset();
  if (session.currentTurn) session.currentTurn.bargeStage = "B";

  if (session.plivoWs?.readyState === WebSocket.OPEN) {
    session.clearSentAt = Date.now();
    session.plivoWs.send(JSON.stringify({ event: "clearAudio" }));
  }
  console.log(
    `[call ${callId}] barge stage=B via=${via} utt=${session.holdUtteranceIdx ?? "?"} held=${heldMs}ms dropped=${dropped}chunks "${text.slice(0, 40)}"`,
  );
  session.holdUtteranceIdx = null;
}

/** Abort — it was noise, or an "achha". Puts the held audio back so the AI
 * finishes its sentence as if nothing happened. */
function resumeHeldAudio(session: CallSession, callId: string, reason: string) {
  if (session.ttsGate !== "holding") return;
  if (session.holdTimer) {
    clearTimeout(session.holdTimer);
    session.holdTimer = null;
  }
  const heldMs = session.holdStartedAt ? Date.now() - session.holdStartedAt : 0;
  const held = session.heldAudio;
  session.heldAudio = [];
  session.heldAudioBytes = 0;
  session.holdStartedAt = null;
  session.holdUtteranceIdx = null;
  session.ttsGate = "open";
  session.bargeAbortCount++;
  if (session.currentTurn && session.currentTurn.bargeStage === "A") {
    session.currentTurn.bargeStage = "abort";
  }

  const ws = session.plivoWs;
  if (ws?.readyState === WebSocket.OPEN) {
    // Synchronous: nothing awaits between chunks, so no newly-arriving chunk
    // can interleave halfway through the replay.
    for (const chunk of held) {
      sendPlayAudio(ws, chunk);
      session.ttsBytesSent += chunk.length;
      // Resumed audio is still audio: it has to extend the playback clock, or
      // the agent would look finished while the caller can still hear it.
      session.audioPlayingUntil =
        Math.max(Date.now(), session.audioPlayingUntil) + chunk.length / AUDIO_BYTES_PER_MS;
    }
  }
  console.log(
    `[call ${callId}] barge stage=abort reason=${reason} held=${heldMs}ms resumed=${held.length}chunks`,
  );
}

/**
 * Plivo <Stream> handler — branches on the Call's callMode, looked up here
 * (Phase 2 addition; Phase 1 didn't need this since it only ever handled
 * AI_ASSISTED). callId travels in the URL query string (set by
 * answer/route.ts and ai-answer/route.ts) rather than Plivo's
 * `extraHeaders`, whose exact delivery mechanics on <Stream> aren't
 * confirmed.
 *
 * Plivo's media-frame JSON shape (start/media/stop events, base64 audio
 * payload under `media.payload`) mirrors the Twilio Media Streams protocol
 * it's modeled after — not yet independently live-tested against a real
 * Plivo call; adjust field names here first if a real call doesn't parse.
 */
async function handlePlivoStream(ws: WebSocket, url: URL) {
  const callId = url.searchParams.get("callId");
  if (!callId) {
    console.error("[plivo-stream] connected with no callId, closing");
    ws.close();
    return;
  }

  let call;
  try {
    call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        callMode: true,
        leadId: true,
        providerCallSid: true,
        // Pulled in the same round trip the stream already makes: the name
        // and qualification facts for the system prompt, and the state for
        // both the TTS voice and the language the agent opens in.
        lead: {
          select: {
            name: true,
            state: true,
            preferredLanguage: true,
            district: true,
            status: true,
            customerType: true,
            interestedProducts: true,
            expectedQuantity: true,
            cropInterest: true,
            remarks: true,
            convertedCustomer: { select: { id: true } },
          },
        },
      },
    });
  } catch (err) {
    console.error(`[plivo-stream] DB lookup failed for callId=${callId}, closing`, err);
    ws.close();
    return;
  }
  if (!call) {
    console.error(`[plivo-stream] no Call row for callId=${callId}, closing`);
    ws.close();
    return;
  }

  console.log(`[plivo-stream] connected for callId=${callId}, mode=${call.callMode}`);

  // Catalogue and recent history, fetched once here rather than through tool
  // round trips mid-conversation. Both are small, both are on the greeting's
  // critical path only once, and a failure must not stop the call — an agent
  // with no catalogue still works, it just has to promise a callback.
  let products: ProductBrief[] = [];
  let priorCalls: PriorCallBrief[] = [];
  if (call.callMode === "AI_AUTONOMOUS" && call.leadId) {
    try {
      const [productRows, callRows] = await Promise.all([
        prisma.product.findMany({
          where: { isActive: true },
          select: {
            name: true,
            category: true,
            unit: true,
            packSize: true,
            mrp: true,
            description: true,
            targetCrops: true,
            problemSolved: true,
            dosage: true,
            applicationMethod: true,
            nutrientContent: true,
            benefits: true,
            availability: true,
          },
          orderBy: { name: "asc" },
          take: 40,
        }),
        prisma.call.findMany({
          where: { leadId: call.leadId, id: { not: callId }, aiSummary: { not: null } },
          select: { calledAt: true, outcome: true, aiSummary: true },
          orderBy: { calledAt: "desc" },
          take: 3,
        }),
      ]);
      products = productRows.map((p) => ({
        ...p,
        mrp: p.mrp == null ? null : Number(p.mrp),
      }));
      priorCalls = callRows.map((c) => ({
        daysAgo: Math.floor((Date.now() - c.calledAt.getTime()) / 86_400_000),
        outcome: c.outcome,
        summary: c.aiSummary,
      }));
      console.log(
        `[call ${callId}] preloaded ${products.length} product(s) and ${priorCalls.length} prior call(s) into the prompt`,
      );
    } catch (err) {
      console.error(`[call ${callId}] catalogue/history preload failed — continuing without`, err);
    }
  }

  // Knowledge-graph facts, resolved once here for the same reason the
  // catalogue above is: a live Cypher lookup mid-call would repeat the exact
  // latency mistake the catalogue preload was built to avoid (all.md
  // Guiding Principle 5). Off by default (KNOWLEDGE_GRAPH_ENABLED); an
  // unreachable/misconfigured Neo4j must never affect call setup — its own
  // try/catch, separate from the catalogue's, so one failing doesn't blank
  // out the other.
  let graphFacts: GraphFactsBrief = EMPTY_GRAPH_FACTS;
  if (call.callMode === "AI_AUTONOMOUS" && call.leadId && isKnowledgeGraphEnabled()) {
    try {
      graphFacts = await resolveGraphFacts({
        district: call.lead?.district ?? null,
        cropInterest: call.lead?.cropInterest ?? null,
      });
      console.log(
        `[call ${callId}] graph facts resolved: ${graphFacts.suitableProducts.length} product(s), ` +
          `district=${graphFacts.district ? "matched" : "no match"}, ${graphFacts.personas.length} persona(s)`,
      );
    } catch (err) {
      console.error(`[call ${callId}] graph facts preload failed — continuing without`, err);
    }
  }

  const session = createSession(
    call.callMode as CallSession["mode"],
    call.leadId,
    call.lead,
    products,
    priorCalls,
    graphFacts,
  );
  session.providerCallSid = call.providerCallSid;
  session.plivoWs = ws;
  sessions.set(callId, session);

  if (call.callMode === "AI_AUTONOMOUS") {
    setupAutonomousStream(session, callId);
  } else {
    setupAssistedStream(session, callId);
  }

  let mediaFrameCount = 0;
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`[plivo-stream ${callId}] non-JSON frame, ${data.toString().length} bytes`);
      return;
    }

    if (msg.event === "media") {
      const media = msg.media as Record<string, unknown> | undefined;
      if (typeof media?.payload === "string") {
        // Plivo can negotiate both tracks even when the XML asked for inbound
        // only — a real `start` event has shown `tracks:["inbound","outbound"]`.
        // Feeding the outbound track to STT means the AI's own voice trips the
        // VAD, so on an autonomous call it would interrupt itself forever.
        if (session.mode === "AI_AUTONOMOUS" && media.track === "outbound") return;
        mediaFrameCount++;
        recordFrame(session.frameStats, Date.now());
        if (mediaFrameCount === 1 || mediaFrameCount % 100 === 0) {
          console.log(
            `[plivo-stream ${callId}] media frame #${mediaFrameCount}, track=${media.track ?? "?"}, payload=${media.payload.length} chars`,
          );
        }
        session.sttSession?.sendAudio(Buffer.from(media.payload, "base64"));
      } else {
        console.log(`[plivo-stream ${callId}] "media" event with no payload: ${JSON.stringify(msg).slice(0, 300)}`);
      }
    } else if (msg.event === "start") {
      // Logs Plivo's actual negotiated media format (codec/sample rate) —
      // confirms or refutes the audio/x-l16;rate=16000 assumption from the
      // <Stream> XML attribute.
      console.log(`[plivo-stream ${callId}] start event: ${JSON.stringify(msg).slice(0, 500)}`);
      if (session.mode === "AI_AUTONOMOUS") triggerGreeting(session, callId);
    } else if (msg.event === "playedStream") {
      // Plivo has finished playing everything up to this checkpoint, which
      // is the only reliable signal that the AI has stopped talking — the
      // barge-in logic depends on it to tell an interruption apart from an
      // answer.
      if (msg.name === "farewell") {
        hangUpAutonomousCall(session, callId, "checkpoint");
      } else {
        // Plivo has drained its queue, so continuing to hold would create
        // real silence rather than merely deferring audio.
        if (session.ttsGate === "holding") resumeHeldAudio(session, callId, "played-through");
        // Corroborates the local clock rather than being trusted alone. Only
        // the newest checkpoint means everything queued has played: a turn
        // that spoke two sentences gets an ack for the first while the second
        // is still audible, and winding the clock back then would declare the
        // agent silent mid-sentence.
        const isNewest = msg.name === `utt-${session.utteranceSeq}`;
        const overshoot = Math.max(0, session.audioPlayingUntil - Date.now());
        // An ack that outran its own audio proves nothing about playback.
        // speakWithCheckpoint sends the checkpoint at speak() time, so when
        // the synthesized audio has not arrived yet Plivo acks an empty queue
        // immediately — and believing it here cleared the speaking clock while
        // a whole answer was still to play, which also made isSpeaking() lie
        // and left beginHold() unable to arm Stage A barge-in.
        const audioStillComing = session.speechPendingUntil > Date.now();
        if (isNewest && !audioStillComing) {
          session.audioPlayingUntil = 0;
          session.speechPendingUntil = 0;
        }
        console.log(
          `[call ${callId}] playedStream ack name=${String(msg.name ?? "-")} newest=${isNewest} premature=${audioStillComing} (local clock ${overshoot}ms ahead)`,
        );
        // Start counting silence from the end of our own speech rather than
        // from whenever the lead last spoke. armSilenceTimer adds whatever is
        // still queued to play, so a premature ack only moves the clock
        // earlier than it should, never past the end of the audio.
        armSilenceTimer(session, callId);
      }
    } else if (msg.event === "clearedAudio") {
      // Plivo's ack for our clearAudio — the only direct evidence that a
      // barge-in actually reached it, and the round trip is a clean read on
      // the audio path's health.
      if (session.clearSentAt) {
        const rtt = Date.now() - session.clearSentAt;
        session.clearAckSamples.push(rtt);
        session.clearSentAt = null;
        console.log(`[call ${callId}] plivo acked clearAudio in ${rtt}ms`);
      }
    } else if (msg.event === "stop") {
      console.log(`[plivo-stream ${callId}] stop event after ${mediaFrameCount} media frames`);
      finalizeSession(callId, session);
    } else {
      console.log(`[plivo-stream ${callId}] unhandled event: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  });

  ws.on("close", () => {
    console.log(`[plivo-stream] closed for callId=${callId}`);
    finalizeSession(callId, session);
  });
  ws.on("error", (err) => console.error(`[call ${callId}] plivo-stream error`, err));
}

/** Phase 1 AI_ASSISTED: listen-only STT -> occasional Claude/OpenAI suggestion. */
function setupAssistedStream(session: CallSession, callId: string) {
  try {
    session.sttSession = createSarvamSttSession({
      onTranscript: ({ text, isFinal }) => {
        if (!isFinal) {
          pushToAssist(session, { type: "transcript", text, final: false });
          return;
        }

        session.transcriptSegments.push(text);
        pushToAssist(session, { type: "transcript", text, final: true });

        const now = Date.now();
        if (session.suggestionInFlight || now - session.lastSuggestionAt < SUGGESTION_MIN_INTERVAL_MS) {
          return;
        }
        session.suggestionInFlight = true;
        session.lastSuggestionAt = now;
        maybeGenerateSuggestion(session.transcriptSegments.join(" "))
          .then((suggestion) => {
            if (suggestion) pushToAssist(session, { type: "suggestion", text: suggestion });
          })
          .catch((err) => console.error(`[call ${callId}] suggestion failed`, err))
          .finally(() => {
            session.suggestionInFlight = false;
          });
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-stt error`, err),
    });
  } catch (err) {
    // Missing SARVAM_API_KEY or similar config error — must not crash the
    // whole process (every other in-progress call shares it). Fail just
    // this one AI_ASSISTED session; the human call itself is unaffected
    // since <Stream> is unidirectional and sits alongside <Dial>, not
    // inside it.
    console.error(`[call ${callId}] failed to start STT session, closing stream only`, err);
    session.plivoWs?.close();
  }
}

/**
 * Switches the voice to the language the lead is actually speaking.
 *
 * Deliberately does NOT write Lead.preferredLanguage any more. It used to,
 * off a single /text-lid call on the first utterance over 8 characters, and
 * both writes it ever made were wrong: a West Bengal farmer was stored as
 * Telugu from the mis-heard "Ice cream" (STT confidence 0.12), another as
 * English from the fragment "is available." Because preferredLanguage
 * outranks Lead.state in resolveTtsLanguage, every later call to them opened
 * in the wrong language — and the column is rep-set now, so nothing here may
 * overwrite a human's choice.
 *
 * The old one-shot `languageDetected` flag was also set *before* awaiting
 * detectLanguage(), which returns null under the length floor. Calls open
 * with "Hello", so the flag was burned before it could ever succeed: on most
 * calls detection never ran at all, and a lead who said outright that they
 * were more comfortable in Bengali still got English on the next call.
 *
 * Fire-and-forget: this must never delay or break the conversation.
 */
async function trackSpokenLanguage(
  session: CallSession,
  callId: string,
  text: string,
  sttConfidence: number | null,
) {
  if (session.languageSwitched) return;

  try {
    const detected = await detectLanguage(text, sttConfidence);
    // A detection matching what we already speak is confirmation, not news.
    if (!detected || detected === session.languageCode) return;

    // Corroboration. One utterance is exactly what produced "Ice cream" ->
    // Telugu, so a switch needs the same answer twice.
    const seen = (session.languageVotes.get(detected) ?? 0) + 1;
    session.languageVotes.set(detected, seen);
    if (seen < LANGUAGE_SWITCH_VOTES) {
      console.log(`[call ${callId}] heard ${detected} (${seen}/${LANGUAGE_SWITCH_VOTES}) — not switching yet`);
      return;
    }

    switchVoiceLanguage(session, callId, detected);
  } catch (err) {
    console.error(`[call ${callId}] language detection failed`, err);
  }
}

/**
 * Applies a voice switch, waiting for a gap if the agent is mid-turn.
 *
 * setLanguage() rebuilds the TTS socket and drops whatever is in flight with
 * it, so landing this mid-sentence would cut the caller off. The model needs
 * no prompt update: buildSystemPrompt already tells it to match whatever
 * language the lead replies in, and it does — it is only the voice that
 * could not follow.
 */
function switchVoiceLanguage(session: CallSession, callId: string, detected: SarvamTtsLanguage) {
  if (session.languageSwitched || session.endingCall || session.finalized) return;

  if (session.agentTurnInFlight || isSpeaking(session)) {
    // Re-check on a short timer rather than queueing a callback: the turn may
    // yet be cancelled by a barge-in, and re-reading the state is cheaper
    // than unwinding a stale one.
    if (session.languageSwitchTimer) clearTimeout(session.languageSwitchTimer);
    session.languageSwitchTimer = setTimeout(
      () => switchVoiceLanguage(session, callId, detected),
      LANGUAGE_SWITCH_RETRY_MS,
    );
    return;
  }

  session.languageSwitched = true;
  const previous = session.languageCode;
  session.languageCode = detected;
  // fillerWord() and closingLine() both read session.languageCode, so the
  // server's own spoken lines follow the switch with no extra wiring.
  session.ttsSession?.setLanguage(detected);
  console.log(`[call ${callId}] voice switched ${previous} -> ${detected} (lead is speaking it)`);
}

/** Phase 2 AI_AUTONOMOUS: STT -> OpenAI tool-calling agent -> TTS playback. */
function setupAutonomousStream(session: CallSession, callId: string) {
  if (!session.leadId) {
    console.error(`[call ${callId}] AI_AUTONOMOUS session with no leadId, closing`);
    session.plivoWs?.close();
    return;
  }

  const languageCode = session.languageCode;
  console.log(
    `[call ${callId}] TTS language=${languageCode} (source=${session.languageSource}, lead state=${session.leadState ?? "unknown"})`,
  );

  // Guards against a call that never ends on its own.
  armSilenceTimer(session, callId);
  session.maxCallDeadline = Date.now() + MAX_CALL_MS;
  session.maxCallTimer = setTimeout(() => wrapUpCall(session, callId, "max-duration"), MAX_CALL_MS);

  try {
    session.ttsSession = createSarvamTtsSession({
      languageCode,
      onAudioChunk: (chunk) => {
        if (session.currentTurn && session.currentTurn.firstTtsChunkAt === null) {
          session.currentTurn.firstTtsChunkAt = Date.now();
        }
        routeTtsChunk(session, callId, chunk);
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-tts error`, err),
    });

    session.sttSession = createSarvamSttSession({
      onVadStart: (event) => {
        // Speech onset is the earliest proof the line is alive. Sarvam needs
        // 300ms of trailing silence before it emits a final, and only a final
        // used to restart the silence clock — so a lead part-way through an
        // answer was invisible to the guard and got hung up on mid-sentence.
        armSilenceTimer(session, callId);
        // Stage A. Skipped when the kill switch is set, which restores exactly
        // the previous final-transcript-only barge-in behaviour.
        if (TWO_STAGE_BARGE_IN) beginHold(session, callId, event);
      },
      onVadEnd: TWO_STAGE_BARGE_IN
        ? () => {
            // Deliberately does NOT resume: Sarvam delivers the substantive
            // partial and the final *after* speech_end, so resuming here would
            // undo the hold moments before it was going to pay off. The single
            // hold deadline is the only abort trigger.
            if (session.vadStartedAt) {
              session.leadSpeechMs += Date.now() - session.vadStartedAt;
              session.vadStartedAt = null;
            }
          }
        : undefined,
      onTranscript: ({ text, isFinal, utteranceIdx, language, languageConfidence }) => {
        if (language) session.lastLanguage = language;

        if (!isFinal) {
          // Stage B: commit only once a partial proves this is real speech,
          // and only for the utterance that opened the hold.
          if (
            session.ttsGate === "holding" &&
            (session.holdUtteranceIdx === null || utteranceIdx === session.holdUtteranceIdx) &&
            classifyInterrupt(text) === "substantive"
          ) {
            commitBargeIn(session, callId, "partial", text);
          }
          // A backchannel or too-short partial keeps holding rather than
          // aborting — a partial can still grow into a real interruption.
          return;
        }

        // A short "haan"/"hello" while the AI is mid-sentence is the lead
        // acknowledging, not interrupting — answering it would cut the AI
        // off and restart the pitch. Let the sentence finish.
        // Any speech at all counts as the call being alive, backchannel or
        // not — someone saying "haan" is not a dead line.
        armSilenceTimer(session, callId);

        const speaking = isSpeaking(session);
        if (speaking && isBackchannel(text)) {
          // Stage A may have held audio on the way to this "achha" — give it
          // back so the sentence the lead was agreeing with still finishes.
          if (session.ttsGate === "holding") resumeHeldAudio(session, callId, "backchannel-final");
          console.log(`[call ${callId}] ignoring backchannel while speaking: "${text}"`);
          return;
        }

        session.transcriptSegments.push(`Lead: ${text}`);
        void trackSpokenLanguage(session, callId, text, languageConfidence);

        // Stage B may already have committed on the partial; either way the
        // model has to be told it was cut off.
        const interrupted = speaking || session.bargeCommitted;
        session.bargeCommitted = false;
        if (speaking) {
          // Still talking, so Stage B never fired — this is the old
          // final-transcript path, which is also the degraded path whenever
          // VAD is unavailable.
          commitBargeIn(session, callId, "final", text);
        }

        dispatchOrCoalesce(session, callId, text, interrupted);
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-stt error`, err),
    });
  } catch (err) {
    console.error(`[call ${callId}] failed to start STT/TTS session, ending call`, err);
    session.plivoWs?.close();
  }
}

/** (Re)arms the timer that flushes whatever is sitting in session.coalesceText,
 * reading the fields at fire time rather than closing over them, since
 * nothing else touches them between now and then in this single-threaded
 * event loop. */
function scheduleCoalesceFlush(session: CallSession, callId: string) {
  if (session.coalesceTimer) clearTimeout(session.coalesceTimer);
  session.coalesceTimer = setTimeout(() => {
    session.coalesceTimer = null;
    const text = session.coalesceText;
    const interrupted = session.coalesceInterrupted;
    const spokeAt = session.coalesceSpokeAt ?? Date.now();
    session.coalesceText = null;
    session.coalesceSpokeAt = null;
    session.coalesceInterrupted = false;
    if (text) void runNextAgentTurn(session, callId, text, interrupted, spokeAt);
  }, FRAGMENT_COALESCE_MS);
}

/** Entry point for every STT final. See FRAGMENT_COALESCE_MS: a lone fragment
 * gets held briefly instead of becoming its own turn, so a second fragment
 * arriving right after it merges into one answer instead of triggering a
 * confused "sorry, repeat that" reply to the first half alone. */
function dispatchOrCoalesce(session: CallSession, callId: string, text: string, interrupted: boolean) {
  const spokeAt = Date.now();

  if (session.coalesceText !== null) {
    session.coalesceText = `${session.coalesceText} ${text}`;
    session.coalesceInterrupted = session.coalesceInterrupted || interrupted;
    console.log(`[call ${callId}] coalescing fragment onto held utterance: "${text}"`);
    scheduleCoalesceFlush(session, callId);
    return;
  }

  if (!session.agentTurnInFlight && looksLikeFragment(text)) {
    session.coalesceText = text;
    session.coalesceSpokeAt = spokeAt;
    session.coalesceInterrupted = interrupted;
    console.log(`[call ${callId}] holding lone fragment for ${FRAGMENT_COALESCE_MS}ms: "${text}"`);
    scheduleCoalesceFlush(session, callId);
    return;
  }

  void runNextAgentTurn(session, callId, text, interrupted, spokeAt);
}

function triggerGreeting(session: CallSession, callId: string) {
  if (session.agentHistory.length > 0) return; // already greeted
  void runNextAgentTurn(
    session,
    callId,
    "(The call has just connected. Greet the lead by name and briefly explain why you're calling.)",
  );
}

async function runNextAgentTurn(
  session: CallSession,
  callId: string,
  userUtterance: string,
  interrupted = false,
  /** When the lead actually stopped speaking. Latency is measured from here,
   * not from when this function got its turn, so a queued utterance reports
   * the wait the caller really experienced. */
  spokeAt = Date.now(),
) {
  // The lead answered during an automatic goodbye — call it off and take the
  // turn rather than hanging up on them. A model-chosen end_call sets
  // endingCall with no wrapUpTimer, so that farewell still stands.
  if (session.endingCall) cancelWrapUp(session, callId);
  if (session.endingCall || !session.leadId) {
    console.log(`[call ${callId}] dropped turn (ending=${session.endingCall}): "${userUtterance.slice(0, 80)}"`);
    return;
  }
  if (session.agentTurnInFlight) {
    // Queue rather than discard. A reply takes a second or two to generate,
    // and anything the lead said in that window used to vanish silently —
    // three utterances were lost on one call, including the lead's closing
    // request, after which nobody answered and the silence timer hung up on
    // them. Only the most recent is kept; older ones are stale by the time
    // the current turn finishes.
    session.pendingUtterance = userUtterance;
    session.pendingUtteranceAt = spokeAt;
    console.log(`[call ${callId}] queued while busy: "${userUtterance.slice(0, 80)}"`);
    return;
  }
  session.agentTurnInFlight = true;
  // Fresh turn: whatever cancelled the previous one no longer applies.
  session.cancelTurn = false;
  console.log(`[call ${callId}] agent turn starting for: "${userUtterance.slice(0, 120)}"`);

  // Flush the previous turn now that its audio has had time to land.
  flushTurnLog(session);

  session.turnCount++;
  const trigger: TurnTrigger =
    session.agentHistory.length === 0 ? "greeting" : spokeAt < Date.now() - 50 ? "queued" : "final";
  const metrics = startTurn(callId, session.turnCount, trigger, spokeAt, Math.max(0, Date.now() - spokeAt));
  metrics.interrupted = interrupted;
  metrics.leadChars = userUtterance.length;
  metrics.lang = session.lastLanguage;
  session.currentTurn = metrics;

  try {
    if (session.agentHistory.length === 0) {
      // Lead facts and language both come from the Call lookup
      // handlePlivoStream already did — no extra round trip, and no
      // get_lead_context hop, on the greeting's critical path.
      session.agentHistory.push({
        role: "system",
        content: buildSystemPrompt(
          { name: session.leadName ?? "the lead", ...session.leadBrief },
          languageName(session.languageCode),
          { products: session.products, priorCalls: session.priorCalls, graphFacts: session.graphFacts },
        ),
      });
    }

    const toolCtx = {
      prisma,
      leadId: session.leadId,
      customerId: session.customerId,
      callId,
      providerCallSid: session.providerCallSid,
      originUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    };

    // The model only ever sees that it was cut off — it can't know how much
    // of its last line actually reached the lead.
    const prompt = interrupted
      ? `(You were interrupted mid-sentence — the lead may not have heard the end of your last line. Do not re-introduce yourself.) ${userUtterance}`
      : userUtterance;

    let spokenAnything = false;

    // The model takes ~1.4s to its first token. Rather than leave the lead
    // listening to nothing, say a one-word acknowledgement if the reply
    // hasn't started by then — but only if it's actually slow, so a fast
    // turn doesn't get a pointless "ji" bolted onto the front. Skipped for
    // the greeting, where there is nothing to acknowledge yet.
    const isGreeting = session.agentHistory.length <= 1;
    if (!isGreeting) {
      session.fillerTimer = setTimeout(() => {
        if (spokenAnything || session.cancelTurn || session.endingCall) return;
        session.utteranceSeq += 1;
        session.fillerSeq += 1;
        metrics.spokeFiller = true;
        const filler = fillerWord(session.languageCode, session.fillerSeq, session.lastFiller);
        session.lastFiller = filler;
        speakWithCheckpoint(session, filler);
      }, FILLER_DELAY_MS);
    }

    const result = await runAgentTurn(
      session.agentHistory,
      prompt,
      toolCtx,
      (sentence) => {
        // Streamed: speak each sentence the moment it's complete instead of
        // waiting for the whole reply, which is what removes ~1-2s of dead
        // air per turn.
        if (session.fillerTimer) {
          clearTimeout(session.fillerTimer);
          session.fillerTimer = null;
        }
        // The filler and the model's own opening reaction don't know about
        // each other, so the lead used to hear the acknowledgement twice:
        // "হ্যাঁ..." then "হ্যাঁ দাদা, ...". 44 turns in the logs did this.
        // Only the turn's first sentence can collide, and only if a filler
        // actually played.
        const spoken =
          !spokenAnything && metrics.spokeFiller ? stripLeadingAcknowledgement(sentence) : sentence;
        session.utteranceSeq += 1;
        spokenAnything = true;
        if (metrics.firstSentenceAt === null) metrics.firstSentenceAt = Date.now();
        console.log(`[call ${callId}] speaking sentence: "${spoken.slice(0, 120)}"`);
        speakWithCheckpoint(session, spoken);
      },
      () => session.cancelTurn,
      session.languageCode,
    );
    session.agentHistory = result.history;
    metrics.llmRequestAt = result.timings.requestStartedAt;
    metrics.firstTokenAt = result.timings.firstTokenAt;
    metrics.hops = result.timings.hops;
    metrics.tools = result.timings.tools;
    metrics.replyChars = result.reply.length;
    console.log(
      `[call ${callId}] agent reply complete: "${result.reply.slice(0, 200)}" (controlSignal=${result.controlSignal ?? "none"}, cancelled=${session.cancelTurn})`,
    );
    if (result.reply) {
      session.transcriptSegments.push(`AI: ${result.reply}`);
    }
    if (!spokenAnything && result.reply) {
      // Tool-only hops stream no prose; make sure the final text is voiced.
      // Nothing streamed, so this is the turn's first sentence and carries the
      // same doubled-acknowledgement risk as the streamed path above.
      session.utteranceSeq += 1;
      speakWithCheckpoint(
        session,
        metrics.spokeFiller ? stripLeadingAcknowledgement(result.reply) : result.reply,
      );
    } else if (!result.reply) {
      console.log(`[call ${callId}] agent produced no reply text — nothing to speak`);
    }
    // Sarvam buffers text across messages and decides when to synthesize;
    // without this the last utterance of the turn waits on the next turn's
    // text or an internal timeout.
    session.ttsSession?.flush();

    if (result.controlSignal === "end_call") {
      session.endingCall = true;
      if (session.plivoWs?.readyState === WebSocket.OPEN) {
        session.plivoWs.send(JSON.stringify({ event: "checkpoint", name: "farewell" }));
      }
      // Fallback in case the checkpoint/playedStream round trip doesn't
      // fire as expected — see HANGUP_FALLBACK_TIMEOUT_MS.
      setTimeout(() => hangUpAutonomousCall(session, callId, "timeout-fallback"), HANGUP_FALLBACK_TIMEOUT_MS);
    } else if (result.controlSignal === "transfer_to_human") {
      // The tool itself already triggered the Plivo REST transfer; Plivo
      // will tear this stream down as the call flow moves to
      // transfer/route.ts. All that's left is to remember it happened, so
      // the wrap-up guard in finalizeSession doesn't misread the teardown
      // as an ordinary end-of-call.
      session.transferred = true;
      console.log(`[call ${callId}] transfer_to_human signaled`);
    }
  } catch (err) {
    // Say something. Both bugs that produced "no AI spoke" (an invalid enum
    // reaching Prisma, then an unsupported reasoning_effort value) landed
    // here and were logged — but to the person on the phone they were
    // indistinguishable from a dead line, so they kept saying "hello" into
    // silence until they hung up. A holding line keeps the call human and
    // makes the failure obvious in the recording, not just in the log.
    console.error(`[call ${callId}] agent turn failed`, err);
    metrics.stalled = true;
    session.stallCount++;
    // Routed through speakWithCheckpoint rather than straight at the TTS
    // socket, so a barge-in's discard window can't swallow the one line whose
    // whole job is to prove the call is still alive.
    session.utteranceSeq += 1;
    // Was a hardcoded Hindi sentence, spoken verbatim on every call in every
    // language — a West Bengal lead mid-Bengali-conversation heard "Sorry, ek
    // minute. Main check kar raha hoon."
    speakWithCheckpoint(session, holdingLine(session.languageCode));
    session.ttsSession?.flush();
  } finally {
    session.agentTurnInFlight = false;
    if (session.fillerTimer) {
      clearTimeout(session.fillerTimer);
      session.fillerTimer = null;
    }
    // The AI just finished producing a turn; restart the silence clock so a
    // lead who never replies still gets a clean wrap-up.
    armSilenceTimer(session, callId);

    // Answer anything the lead said while that turn was generating.
    const queued = session.pendingUtterance;
    const queuedAt = session.pendingUtteranceAt;
    session.pendingUtterance = null;
    session.pendingUtteranceAt = null;

    metrics.endedAt = Date.now();
    if (metrics.firstTokenAt !== null) {
      session.ttftSamples.push(metrics.firstTokenAt - metrics.startedAt);
    }
    session.totalSamples.push(metrics.endedAt - metrics.startedAt);
    // Deliberately NOT logged here. This runs the moment the model stops
    // generating, which is before its audio has been synthesized and played —
    // logging now reported `tts=-1 play=-1` on turns that audibly spoke. The
    // line is flushed when the next turn starts, or at finalize.

    if (queued && !session.endingCall) {
      console.log(`[call ${callId}] answering queued utterance: "${queued.slice(0, 60)}"`);
      void runNextAgentTurn(session, callId, queued, false, queuedAt ?? Date.now());
    }
  }
}

function hangUpAutonomousCall(session: CallSession, callId: string, reason: string) {
  if (!session.providerCallSid || session.finalized) return;
  console.log(`[call ${callId}] hanging up (${reason})`);
  plivoClient.calls.hangup(session.providerCallSid).catch((err) => {
    console.error(`[call ${callId}] hangup failed`, err);
  });
}

/**
 * Browser-facing live-assist WS. Validates the signed token from
 * `getAssistToken` (this process can't read Better Auth session cookies) —
 * see `src/lib/voice-agent-token.ts`.
 */
function handleAssistConnection(ws: WebSocket, callId: string, url: URL) {
  const token = url.searchParams.get("token");
  if (!token || !verifyAssistToken(token, callId)) {
    console.warn(`[assist] rejected connection for callId=${callId}: invalid/missing token`);
    ws.close(4401, "unauthorized");
    return;
  }

  console.log(`[assist] connected for callId=${callId}`);
  const session = getOrCreateAssistSession(callId);
  session.assistSocket = ws;

  // Replay what's already been transcribed, for a panel that connects mid-call.
  for (const text of session.transcriptSegments) {
    ws.send(JSON.stringify({ type: "transcript", text, final: true }));
  }

  ws.on("close", () => {
    console.log(`[assist] closed for callId=${callId}`);
    if (session.assistSocket === ws) session.assistSocket = null;
  });
  ws.on("error", (err) => console.error(`[assist ${callId}] error`, err));
}

httpServer.listen(PORT, () => {
  console.log(`voice-agent listening on :${PORT} (health, /plivo-stream, /assist/{callId})`);
  // Warms the Neo4j connection now and keeps it warm on an interval, so a
  // call's graph lookup never spends its own 1500ms budget on warm-up. A
  // boot-only warm-up was tried first and proved insufficient: the latency
  // returns with idleness, not just process age. No-op when
  // KNOWLEDGE_GRAPH_ENABLED is off, and never throws.
  startKeepAlive();
});

// This process holds every concurrent call's session state — one call's bug
// must not take the others down with it. Log and keep running rather than
// let Node's default "crash on uncaught exception" behavior apply.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

process.on("SIGTERM", () => {
  console.log("voice-agent shutting down");
  httpServer.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
});
