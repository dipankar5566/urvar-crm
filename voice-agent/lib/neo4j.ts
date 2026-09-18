/**
 * Thin Neo4j client for the (already-deployed, separately-managed) knowledge
 * graph — see all.md Phase 3 and urvar-knowledge-graph's own repo. This
 * module owns the driver lifecycle and failure handling; it knows nothing
 * about what a caller actually wants to ask the graph (see graph-facts.ts
 * for that).
 *
 * One long-lived driver for this process's whole lifetime, with a fresh
 * session per query — the opposite of urvar-knowledge-graph's own
 * driver-per-script-invocation pattern, which is right for a one-shot CLI
 * but wrong here: voice-agent/server.ts is a long-running process under pm2,
 * and neo4j-driver's own connection pooling is what a server is supposed to
 * lean on.
 *
 * Every failure mode (flag off, container down, auth failure, timeout, bad
 * Cypher) degrades to an empty result rather than throwing — this must never
 * be the reason a call fails to set up, exactly like the product catalogue
 * preload it sits alongside in server.ts.
 */
import neo4j, { type Driver } from "neo4j-driver";

/** True only when the flag is on AND the connection is actually configured —
 * mirrors src/lib/whatsapp.ts's isWhatsAppEnabled() "flag AND config
 * present" shape exactly. */
export function isKnowledgeGraphEnabled(): boolean {
  return (
    process.env.KNOWLEDGE_GRAPH_ENABLED === "true" &&
    Boolean(process.env.NEO4J_URI) &&
    Boolean(process.env.NEO4J_USERNAME) &&
    Boolean(process.env.NEO4J_PASSWORD)
  );
}

let driver: Driver | null = null;

/** Lazily constructs the singleton driver. Never throws — a construction
 * failure (malformed URI, etc.) just means callers get no facts. */
function getDriver(): Driver | null {
  if (driver) return driver;
  if (!isKnowledgeGraphEnabled()) return null;
  try {
    driver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
      // This process only ever needs a handful of concurrent calls' worth of
      // graph lookups — not a pool sized for a web app's request volume.
      { maxConnectionPoolSize: 5 },
    );
    return driver;
  } catch (err) {
    console.error("[neo4j] driver construction failed", err);
    driver = null;
    return null;
  }
}

/**
 * Runs one read query against one short-lived session. Always resolves —
 * never rejects — returning [] on any failure (disabled, unreachable, auth
 * failure, timeout, bad Cypher). This is the single point where every
 * Neo4j failure mode becomes "no facts" for every caller in graph-facts.ts.
 */
export async function runReadQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  timeoutMs = 1500,
): Promise<T[]> {
  const drv = getDriver();
  if (!drv) return [];

  const session = drv.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await Promise.race([
      session.run(cypher, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("neo4j query timeout")), timeoutMs),
      ),
    ]);
    return result.records.map((r) => r.toObject() as T);
  } catch (err) {
    console.error("[neo4j] query failed, returning no graph facts", err);
    return [];
  } finally {
    await session.close().catch(() => {});
  }
}

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();
/** 15 minutes: long enough that a busy day of calls into the same
 * district/crop combo pays the Cypher cost once, short enough that a same-day
 * re-run of the graph's ETL is picked up without a voice-agent restart. */
const CACHE_TTL_MS = 15 * 60 * 1000;

export function getCached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Not called on every process exit today (pm2 restarts the whole process
 * anyway), but cheap insurance against leaking a connection pool across a
 * hot-reload in dev (`tsx watch`). */
export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close().catch(() => {});
    driver = null;
  }
}
