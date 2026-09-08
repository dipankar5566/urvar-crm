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
import { maybeGenerateSuggestion, summarizeCall } from "./pipeline/openai-assist.js";
import { buildSystemPrompt, runAgentTurn } from "./pipeline/openai-agent.js";

const SUGGESTION_MIN_INTERVAL_MS = 8000;
// Safety-net if Plivo's checkpoint/playedStream mechanism (used to hang up
// only once the AI's farewell has actually finished playing) doesn't fire
// as expected — never leave a call open indefinitely after end_call.
const HANGUP_FALLBACK_TIMEOUT_MS = 8000;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PORT = Number(process.env.VOICE_AGENT_PORT ?? 3010);

type CallSession = {
  mode: "AI_ASSISTED" | "AI_AUTONOMOUS";
  leadId: string | null;
  providerCallSid: string | null;
  transcriptSegments: string[];
  assistSocket: WebSocket | null;
  sttSession: SarvamSttSession | null;
  ttsSession: SarvamTtsSession | null;
  plivoWs: WebSocket | null;
  agentHistory: ChatCompletionMessageParam[];
  agentTurnInFlight: boolean;
  endingCall: boolean;
  lastSuggestionAt: number;
  suggestionInFlight: boolean;
  finalized: boolean;
};

const sessions = new Map<string, CallSession>();

function createSession(mode: CallSession["mode"], leadId: string | null): CallSession {
  return {
    mode,
    leadId,
    providerCallSid: null,
    transcriptSegments: [],
    assistSocket: null,
    sttSession: null,
    ttsSession: null,
    plivoWs: null,
    agentHistory: [],
    agentTurnInFlight: false,
    endingCall: false,
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

function pushToAssist(session: CallSession, message: unknown) {
  if (session.assistSocket && session.assistSocket.readyState === WebSocket.OPEN) {
    session.assistSocket.send(JSON.stringify(message));
  }
}

async function finalizeSession(callId: string, session: CallSession) {
  if (session.finalized) return;
  session.finalized = true;

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

const wss = new WebSocketServer({ noServer: true });

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
      select: { callMode: true, leadId: true, providerCallSid: true },
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
  const session = createSession(call.callMode as CallSession["mode"], call.leadId);
  session.providerCallSid = call.providerCallSid;
  session.plivoWs = ws;
  sessions.set(callId, session);

  if (call.callMode === "AI_AUTONOMOUS") {
    setupAutonomousStream(session, callId);
  } else {
    setupAssistedStream(session, callId);
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "media" && typeof msg.media?.payload === "string") {
        session.sttSession?.sendAudio(Buffer.from(msg.media.payload, "base64"));
      } else if (msg.event === "start" && session.mode === "AI_AUTONOMOUS") {
        triggerGreeting(session, callId);
      } else if (msg.event === "playedStream" && msg.name === "farewell") {
        hangUpAutonomousCall(session, callId, "checkpoint");
      } else if (msg.event === "stop") {
        finalizeSession(callId, session);
      }
    } catch {
      console.log(`[plivo-stream] non-JSON frame, ${data.toString().length} bytes`);
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

/** Phase 2 AI_AUTONOMOUS: STT -> OpenAI tool-calling agent -> TTS playback. */
function setupAutonomousStream(session: CallSession, callId: string) {
  if (!session.leadId) {
    console.error(`[call ${callId}] AI_AUTONOMOUS session with no leadId, closing`);
    session.plivoWs?.close();
    return;
  }

  try {
    session.ttsSession = createSarvamTtsSession({
      onAudioChunk: (chunk) => {
        if (session.plivoWs?.readyState === WebSocket.OPEN) sendPlayAudio(session.plivoWs, chunk);
      },
      onError: (err) => console.error(`[call ${callId}] sarvam-tts error`, err),
    });

    session.sttSession = createSarvamSttSession({
      onTranscript: ({ text, isFinal }) => {
        if (!isFinal) return;
        session.transcriptSegments.push(`Lead: ${text}`);
        void runNextAgentTurn(session, callId, text);
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

async function runNextAgentTurn(session: CallSession, callId: string, userUtterance: string) {
  if (session.agentTurnInFlight || session.endingCall || !session.leadId) return;
  session.agentTurnInFlight = true;

  // Interrupt any audio still playing from a previous turn — a minimal
  // barge-in safeguard, not full real-time interruption detection.
  if (session.plivoWs?.readyState === WebSocket.OPEN) {
    session.plivoWs.send(JSON.stringify({ event: "clearAudio" }));
  }

  try {
    if (session.agentHistory.length === 0) {
      const lead = await prisma.lead.findUnique({ where: { id: session.leadId }, select: { name: true } });
      session.agentHistory.push({ role: "system", content: buildSystemPrompt(lead?.name ?? "the lead") });
    }

    const toolCtx = {
      prisma,
      leadId: session.leadId,
      callId,
      providerCallSid: session.providerCallSid,
      originUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    };

    const result = await runAgentTurn(session.agentHistory, userUtterance, toolCtx);
    session.agentHistory = result.history;
    if (result.reply) {
      session.transcriptSegments.push(`AI: ${result.reply}`);
      session.ttsSession?.speak(result.reply);
    }

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
    console.error(`[call ${callId}] agent turn failed`, err);
  } finally {
    session.agentTurnInFlight = false;
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
