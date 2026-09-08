/**
 * AI Voice Agent media server — Phase 0 scaffold.
 *
 * Hosts the wss:// endpoints Plivo's <Stream> element and the browser's
 * live-assist panel connect to. This process is a trusted backend peer of
 * the Next.js app (same trust model as the Plivo webhook routes: signature/
 * token validation instead of a user session) — it talks to the same
 * Postgres database directly via the generated Prisma client.
 *
 * Run via `npx tsx voice-agent/server.ts` (see ecosystem.config.js for the
 * PM2 entry) — same tsx-for-standalone-scripts convention as
 * `prisma/clean-demo-data.ts` (`npm run db:clean-demo`).
 *
 * Phase 0 only wires the transport (HTTP health check + two WS paths with a
 * no-op echo/log handler) so the Plivo <Stream> media-frame protocol and the
 * Cloudflare Tunnel route can be spiked and live-tested before Phase 1 adds
 * real Sarvam STT/TTS + Claude reasoning.
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PORT = Number(process.env.VOICE_AGENT_PORT ?? 3010);

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

/**
 * Phase 0: log-only handler — confirms Plivo's <Stream> media-frame protocol
 * (start/media/stop/dtmf JSON events over this WS) round-trips before Phase 1
 * wires in real Sarvam STT/TTS processing.
 */
function handlePlivoStream(ws: WebSocket, url: URL) {
  console.log(`[plivo-stream] connected, query: ${url.search}`);
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[plivo-stream] event: ${msg.event ?? "unknown"}`);
    } catch {
      console.log(`[plivo-stream] non-JSON frame, ${data.toString().length} bytes`);
    }
  });
  ws.on("close", () => console.log("[plivo-stream] closed"));
  ws.on("error", (err) => console.error("[plivo-stream] error", err));
}

/**
 * Phase 0: echo handler for the browser-facing live-assist WS. Phase 1 wires
 * real transcript/suggestion push here, gated by the signed assist token
 * from `getAssistToken` (this process can't read Better Auth session
 * cookies, so it must validate that token independently — see plan's Risks).
 */
function handleAssistConnection(ws: WebSocket, callId: string, url: URL) {
  console.log(`[assist] connected for callId=${callId}, query: ${url.search}`);
  ws.on("message", (data) => {
    ws.send(data.toString());
  });
  ws.on("close", () => console.log(`[assist] closed for callId=${callId}`));
  ws.on("error", (err) => console.error("[assist] error", err));
}

httpServer.listen(PORT, () => {
  console.log(`voice-agent listening on :${PORT} (health, /plivo-stream, /assist/{callId})`);
});

process.on("SIGTERM", () => {
  console.log("voice-agent shutting down");
  httpServer.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
});
