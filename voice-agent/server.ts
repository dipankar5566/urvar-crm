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
import { createSarvamSttSession, type SarvamSttSession } from "./pipeline/sarvam-stt.js";
import { createSarvamTtsSession, type SarvamTtsSession } from "./pipeline/sarvam-tts.js";
import {
  resolveTtsLanguage,
  languageName,
  fillerWord,
  closingLine,
  type SarvamTtsLanguage,
} from "./pipeline/tts-language.js";
import { isBackchannel } from "./pipeline/backchannel.js";
import { detectLanguage } from "./pipeline/detect-language.js";
import { maybeGenerateSuggestion, summarizeCall } from "./pipeline/openai-assist.js";
import { buildSystemPrompt, runAgentTurn, type LeadBrief } from "./pipeline/openai-agent.js";

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
 * one-word acknowledgement so the lead isn't listening to silence. */
const FILLER_DELAY_MS = 400;
/** Time allowed for a closing line to play before the line is dropped. */
const CLOSING_PLAY_MS = 4000;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PORT = Number(process.env.VOICE_AGENT_PORT ?? 3010);

type CallSession = {
  mode: "AI_ASSISTED" | "AI_AUTONOMOUS";
  leadId: string | null;
  // Fetched alongside the Call row in handlePlivoStream so the greeting's
  // critical path doesn't need a second query, and so the TTS voice
  // language can be picked from the lead's state before the socket opens.
  leadName: string | null;
  leadState: string | null;
  /** Qualification facts injected into the system prompt so the agent
   * doesn't burn a get_lead_context round trip on what we already know. */
  leadBrief: Omit<LeadBrief, "name">;
  providerCallSid: string | null;
  transcriptSegments: string[];
  assistSocket: WebSocket | null;
  sttSession: SarvamSttSession | null;
  ttsSession: SarvamTtsSession | null;
  plivoWs: WebSocket | null;
  agentHistory: ChatCompletionMessageParam[];
  agentTurnInFlight: boolean;
  /** True between handing text to TTS and Plivo confirming it finished
   * playing — the difference between "the lead interrupted me" and "the
   * lead is answering me". */
  aiSpeaking: boolean;
  /** Bumped per utterance so each checkpoint ack maps to its own utterance
   * and a stale ack can't clear a newer one. */
  utteranceSeq: number;
  /** Set when a real barge-in happens, so the in-flight streamed reply stops
   * queueing further sentences. */
  cancelTurn: boolean;
  /** Something the lead said while a reply was still generating, held so it
   * gets answered instead of dropped. */
  pendingUtterance: string | null;
  /** Language detection runs once per call, not per utterance. */
  languageDetected: boolean;
  endingCall: boolean;
  /** Voice language for this call, reused by the server's own spoken lines
   * (filler, closing) so they match what the agent is speaking. */
  languageCode: SarvamTtsLanguage;
  silenceTimer: NodeJS.Timeout | null;
  maxCallTimer: NodeJS.Timeout | null;
  fillerTimer: NodeJS.Timeout | null;
  lastSuggestionAt: number;
  suggestionInFlight: boolean;
  finalized: boolean;
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
};

function createSession(
  mode: CallSession["mode"],
  leadId: string | null,
  lead?: LeadRow | null,
): CallSession {
  return {
    mode,
    leadId,
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
    providerCallSid: null,
    transcriptSegments: [],
    assistSocket: null,
    sttSession: null,
    ttsSession: null,
    plivoWs: null,
    agentHistory: [],
    agentTurnInFlight: false,
    aiSpeaking: false,
    utteranceSeq: 0,
    cancelTurn: false,
    pendingUtterance: null,
    languageDetected: false,
    endingCall: false,
    // A language this lead was actually heard speaking beats the guess made
    // from their state, which is only a proxy and is wrong for anyone who
    // has moved. Falls back to the state map on a first call.
    languageCode: resolveTtsLanguage(lead?.state ?? null, lead?.preferredLanguage ?? null),
    silenceTimer: null,
    maxCallTimer: null,
    fillerTimer: null,
    lastSuggestionAt: 0,
    suggestionInFlight: false,
    finalized: false,
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
  session.aiSpeaking = true;
  session.ttsSession.speak(text);
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
  setTimeout(() => hangUpAutonomousCall(session, callId, reason), CLOSING_PLAY_MS);
}

/** Restarted on every sign of life from either side. */
function armSilenceTimer(session: CallSession, callId: string) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  if (session.endingCall || session.finalized) return;
  session.silenceTimer = setTimeout(
    () => wrapUpCall(session, callId, "silence-timeout"),
    SILENCE_HANGUP_MS,
  );
}

function clearCallTimers(session: CallSession) {
  for (const t of [session.silenceTimer, session.maxCallTimer, session.fillerTimer]) {
    if (t) clearTimeout(t);
  }
  session.silenceTimer = null;
  session.maxCallTimer = null;
  session.fillerTimer = null;
}

function pushToAssist(session: CallSession, message: unknown) {
  if (session.assistSocket && session.assistSocket.readyState === WebSocket.OPEN) {
    session.assistSocket.send(JSON.stringify(message));
  }
}

async function finalizeSession(callId: string, session: CallSession) {
  if (session.finalized) return;
  session.finalized = true;
  clearCallTimers(session);

  session.sttSession?.close();
  session.ttsSession?.close();
  const fullTranscript = session.transcriptSegments.join(" ").trim();
  const agentVersion = session.mode === "AI_AUTONOMOUS" ? "phase2-autonomous-v1" : "phase1-call-assist-v1";

  try {
    const { summary, sentiment, intentTags } = await summarizeCall(fullTranscript);
    await prisma.call.update({
      where: { id: callId },
      data: {
        transcript: session.transcriptSegments,
        aiSummary: summary,
        aiSentiment: sentiment,
        aiIntentTags: intentTags,
        aiAgentVersion: agentVersion,
      },
    });
    pushToAssist(session, { type: "call-ended", summary, sentiment });
    console.log(`[call ${callId}] finalized (${session.mode}): ${summary.slice(0, 80)}`);
  } catch (err) {
    console.error(`[call ${callId}] finalize failed`, err);
  }

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
  const session = createSession(call.callMode as CallSession["mode"], call.leadId, call.lead);
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
        mediaFrameCount++;
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
        session.aiSpeaking = false;
        // The AI just stopped talking — start counting silence from here,
        // not from whenever the lead last spoke.
        armSilenceTimer(session, callId);
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
 * Detects the language the lead is speaking and stores it on the Lead, so
 * the next call to them opens in it rather than in the guess derived from
 * their state. Runs once per call, on the first utterance long enough to
 * carry a signal, and is fire-and-forget: this is an optimisation for the
 * next conversation, so it must never delay or break this one.
 */
async function rememberSpokenLanguage(session: CallSession, callId: string, text: string) {
  if (session.languageDetected || !session.leadId) return;
  session.languageDetected = true; // set before awaiting, so concurrent finals don't race

  try {
    const detected = await detectLanguage(text);
    if (!detected || detected === session.languageCode) return;
    await prisma.lead.update({ where: { id: session.leadId }, data: { preferredLanguage: detected } });
    console.log(
      `[call ${callId}] lead speaks ${detected}, not ${session.languageCode} (from state) — saved for next call`,
    );
  } catch (err) {
    console.error(`[call ${callId}] language detection failed`, err);
  }
}

/** Phase 2 AI_AUTONOMOUS: STT -> OpenAI tool-calling agent -> TTS playback. */
function setupAutonomousStream(session: CallSession, callId: string) {
  if (!session.leadId) {
    console.error(`[call ${callId}] AI_AUTONOMOUS session with no leadId, closing`);
    session.plivoWs?.close();
    return;
  }

  const languageCode = session.languageCode;
  console.log(`[call ${callId}] TTS language=${languageCode} (lead state=${session.leadState ?? "unknown"})`);

  // Guards against a call that never ends on its own.
  armSilenceTimer(session, callId);
  session.maxCallTimer = setTimeout(() => wrapUpCall(session, callId, "max-duration"), MAX_CALL_MS);

  try {
    session.ttsSession = createSarvamTtsSession({
      languageCode,
      onAudioChunk: (chunk) => {
        if (session.plivoWs?.readyState === WebSocket.OPEN) sendPlayAudio(session.plivoWs, chunk);
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-tts error`, err),
    });

    session.sttSession = createSarvamSttSession({
      onTranscript: ({ text, isFinal }) => {
        if (!isFinal) return;

        // A short "haan"/"hello" while the AI is mid-sentence is the lead
        // acknowledging, not interrupting — answering it would cut the AI
        // off and restart the pitch. Let the sentence finish.
        // Any speech at all counts as the call being alive, backchannel or
        // not — someone saying "haan" is not a dead line.
        armSilenceTimer(session, callId);

        if (session.aiSpeaking && isBackchannel(text)) {
          console.log(`[call ${callId}] ignoring backchannel while speaking: "${text}"`);
          return;
        }

        session.transcriptSegments.push(`Lead: ${text}`);
        void rememberSpokenLanguage(session, callId, text);

        const interrupted = session.aiSpeaking;
        if (interrupted) {
          // A genuine barge-in: stop the current reply, drop whatever Plivo
          // still has buffered, and tell the model it was cut off so it
          // resumes instead of starting its introduction again.
          console.log(`[call ${callId}] barge-in on: "${text.slice(0, 60)}"`);
          session.cancelTurn = true;
          session.aiSpeaking = false;
          if (session.plivoWs?.readyState === WebSocket.OPEN) {
            session.plivoWs.send(JSON.stringify({ event: "clearAudio" }));
          }
        }

        void runNextAgentTurn(session, callId, text, interrupted);
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-stt error`, err),
    });
  } catch (err) {
    console.error(`[call ${callId}] failed to start STT/TTS session, ending call`, err);
    session.plivoWs?.close();
  }
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
) {
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
    console.log(`[call ${callId}] queued while busy: "${userUtterance.slice(0, 80)}"`);
    return;
  }
  session.agentTurnInFlight = true;
  // Fresh turn: whatever cancelled the previous one no longer applies.
  session.cancelTurn = false;
  console.log(`[call ${callId}] agent turn starting for: "${userUtterance.slice(0, 120)}"`);

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
        ),
      });
    }

    const toolCtx = {
      prisma,
      leadId: session.leadId,
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
        speakWithCheckpoint(session, fillerWord(session.languageCode, session.utteranceSeq));
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
        session.utteranceSeq += 1;
        spokenAnything = true;
        console.log(`[call ${callId}] speaking sentence: "${sentence.slice(0, 120)}"`);
        speakWithCheckpoint(session, sentence);
      },
      () => session.cancelTurn,
    );
    session.agentHistory = result.history;
    console.log(
      `[call ${callId}] agent reply complete: "${result.reply.slice(0, 200)}" (controlSignal=${result.controlSignal ?? "none"}, cancelled=${session.cancelTurn})`,
    );
    if (result.reply) {
      session.transcriptSegments.push(`AI: ${result.reply}`);
    }
    if (!spokenAnything && result.reply) {
      // Tool-only hops stream no prose; make sure the final text is voiced.
      session.utteranceSeq += 1;
      speakWithCheckpoint(session, result.reply);
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
      // transfer/route.ts. Nothing further to do here.
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
    session.ttsSession?.speak("Sorry, ek minute. Main check kar raha hoon.");
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
    session.pendingUtterance = null;
    if (queued && !session.endingCall) {
      console.log(`[call ${callId}] answering queued utterance: "${queued.slice(0, 60)}"`);
      void runNextAgentTurn(session, callId, queued);
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
