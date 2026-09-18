/**
 * Resolves a lead's district/crop into knowledge-graph facts, once, before a
 * call starts — never a live lookup mid-conversation (all.md's Guiding
 * Principle 5: the product catalogue preload exists for exactly the same
 * latency reason). See voice-agent/lib/neo4j.ts for the client this sits on.
 *
 * Explicitly out of scope for this phase: competitor/COMPETES_WITH data
 * (dropped in Phase 3 sub-planning — which competitor to address is only
 * known once the lead names one mid-call, which conflicts with the
 * resolve-before-call rule) and TARGETS_SEGMENT (no verified mapping yet
 * from Lead.customerType's fixed enum to the graph's independently-populated
 * CustomerSegment node ids — see all.md Phase 3).
 */
import { runReadQuery, getCached, setCached } from "./neo4j.js";

/** Flat, prompt-ready shape — mirrors pipeline/openai-agent.ts's
 * ProductBrief/LeadBrief convention of plain objects with no graph-driver
 * types leaking out. */
export type GraphFactsBrief = {
  /** Crop-attributed: a lead's cropInterest is free text that routinely
   * names several crops ("Paddy, Wheat, Tomato"), so a bare product list
   * with no crop against it would tell the agent which products to mention
   * but not which crop each one is actually for. */
  suitableProducts: { crop: string; product: string; stage: string | null }[];
  cropDeficiencies: { crop: string; deficiency: string; treatedBy: string[] }[];
  district: {
    name: string;
    soilTypes: string[];
    deficiencies: { name: string; severity: string | null }[];
    zone: string | null;
    cropsGrownHere: string[];
  } | null;
  personas: { name: string; kind: string; preferredProducts: string[] }[];
};

export const EMPTY_GRAPH_FACTS: GraphFactsBrief = {
  suitableProducts: [],
  cropDeficiencies: [],
  district: null,
  personas: [],
};

export type GraphFactsInput = {
  district?: string | null;
  cropInterest?: string | null;
};

/** Best-effort free-text -> graph-node-id heuristic: Lead.district and
 * Lead.cropInterest are unconstrained free text (src/lib/validations/lead.ts
 * has no enum/allowlist for either), while graph nodes use fixed `id` slugs
 * populated independently by urvar-knowledge-graph's own ETL. A miss here is
 * expected and acceptable — this is a nice-to-have enrichment, not a
 * critical path, so no fuzzy-distance matching, just a slug guess plus a
 * case-insensitive name fallback, both in one query. */
function toSlugGuess(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function matchDistrict(raw: string | null | undefined): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const guess = toSlugGuess(raw);
  const rows = await runReadQuery<{ id: string }>(
    `MATCH (d:District) WHERE d.id = $guess OR toLower(d.name) = toLower($raw) RETURN d.id AS id LIMIT 1`,
    { guess, raw },
  );
  return rows[0]?.id ?? null;
}

/** How many matched crops to actually enrich on. A lead naming eight crops
 * would otherwise push eight products-and-deficiencies blocks into a prompt
 * that deliberately stays tight (all.md Guiding Principle 5), and the agent
 * only ever discusses one or two crops in a call anyway. First-mentioned
 * wins, on the assumption that people list their main crop first. */
const MAX_CROPS = 3;

/** Lead.cropInterest is free text and in practice names several crops at
 * once ("Paddy, Wheat, Tomato, Brinjal") — found live, where the whole
 * string was slugged to `paddy-wheat-tomato-brinjal` and matched nothing,
 * silently costing every such lead its crop enrichment. Split first, then
 * apply the same slug-guess/name-match per token. Still no fuzzy matching. */
function tokenizeCrops(raw: string): { guess: string; raw: string }[] {
  return raw
    .split(/[,;/&\n]+|\band\b|\bo\b/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => ({ guess: toSlugGuess(t), raw: t.toLowerCase() }))
    .filter((t) => t.guess.length > 0);
}

async function matchCrops(raw: string | null | undefined): Promise<{ id: string; name: string }[]> {
  if (!raw || !raw.trim()) return [];
  const tokens = tokenizeCrops(raw);
  if (tokens.length === 0) return [];

  // One query for every token rather than one query per token: a lead with
  // six crops would otherwise be six round trips against the 1.5s budget.
  // min(i) both dedupes and preserves the order they were listed in.
  const rows = await runReadQuery<{ id: string; name: string }>(
    `UNWIND range(0, size($tokens) - 1) AS i
     WITH i, $tokens[i] AS token
     MATCH (c:Crop)
     WHERE c.id = token.guess OR toLower(c.name) = token.raw
     RETURN c.id AS id, c.name AS name, min(i) AS ord
     ORDER BY ord`,
    { tokens },
  );
  return rows.slice(0, MAX_CROPS).map((r) => ({ id: r.id, name: r.name }));
}

async function fetchSuitableProducts(cropIds: string[]): Promise<GraphFactsBrief["suitableProducts"]> {
  if (cropIds.length === 0) return [];
  return runReadQuery<{ crop: string; product: string; stage: string | null }>(
    `MATCH (p:Product)-[sf:SUITABLE_FOR]->(c:Crop)
     WHERE c.id IN $cropIds
     RETURN c.name AS crop, p.name AS product, sf.stage AS stage
     ORDER BY crop, sf.stage`,
    { cropIds },
  );
}

async function fetchCropDeficiencies(cropIds: string[]): Promise<GraphFactsBrief["cropDeficiencies"]> {
  if (cropIds.length === 0) return [];
  return runReadQuery<{ crop: string; deficiency: string; treatedBy: string[] }>(
    `MATCH (c:Crop)-[:SUSCEPTIBLE_TO]->(def:Deficiency)
     WHERE c.id IN $cropIds
     OPTIONAL MATCH (p:Product)-[:TREATS_DEFICIENCY]->(def)
     RETURN c.name AS crop, def.name AS deficiency, collect(DISTINCT p.name) AS treatedBy
     ORDER BY crop, deficiency`,
    { cropIds },
  );
}

async function fetchDistrictContext(districtId: string): Promise<GraphFactsBrief["district"]> {
  const rows = await runReadQuery<{
    name: string;
    soilTypes: string[];
    deficiencies: { name: string; severity: string | null }[];
    zone: string | null;
    cropsGrownHere: string[];
  }>(
    `MATCH (d:District {id: $districtId})
     OPTIONAL MATCH (d)-[:HAS_SOIL_TYPE]->(soil:SoilType)
     OPTIONAL MATCH (d)-[hd:HAS_DEFICIENCY]->(def:Deficiency)
     OPTIONAL MATCH (d)-[:IN_ZONE]->(zone:AgroClimaticZone)
     OPTIONAL MATCH (crop:Crop)-[:GROWN_IN]->(d)
     RETURN d.name AS name,
            collect(DISTINCT soil.name) AS soilTypes,
            collect(DISTINCT {name: def.name, severity: hd.severity}) AS deficiencies,
            head(collect(DISTINCT zone.name)) AS zone,
            collect(DISTINCT crop.name) AS cropsGrownHere`,
    { districtId },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    soilTypes: (row.soilTypes ?? []).filter(Boolean),
    // OPTIONAL MATCH with no deficiency still yields one row shaped
    // {name: null, severity: null} via collect() — drop it.
    deficiencies: (row.deficiencies ?? []).filter((d) => d?.name),
    zone: row.zone ?? null,
    cropsGrownHere: (row.cropsGrownHere ?? []).filter(Boolean),
  };
}

async function fetchPersonas(
  cropIds: string[],
  districtId: string | null,
): Promise<GraphFactsBrief["personas"]> {
  if (cropIds.length === 0 && !districtId) return [];
  // `c.id IN []` is simply false, so an empty cropIds needs no extra guard.
  return runReadQuery<{ name: string; kind: string; preferredProducts: string[] }>(
    `MATCH (persona:FarmerPersona)
     WHERE EXISTS { MATCH (persona)-[:FOCUSES_ON]->(c:Crop) WHERE c.id IN $cropIds }
        OR ($districtId IS NOT NULL AND EXISTS { MATCH (persona)-[:ACTIVE_IN]->(d:District) WHERE d.id = $districtId })
     OPTIONAL MATCH (persona)-[:PREFERS]->(prod:Product)
     RETURN persona.name AS name, persona.kind AS kind, collect(DISTINCT prod.name) AS preferredProducts
     LIMIT 5`,
    { cropIds, districtId },
  );
}

export async function resolveGraphFacts(lead: GraphFactsInput): Promise<GraphFactsBrief> {
  const [districtId, crops] = await Promise.all([
    matchDistrict(lead.district),
    matchCrops(lead.cropInterest),
  ]);
  if (!districtId && crops.length === 0) return EMPTY_GRAPH_FACTS;

  const cropIds = crops.map((c) => c.id);
  // cropIds is already deduped, first-mention-ordered and capped, so the
  // same lead always produces the same key.
  const cacheKey = `${districtId ?? "-"}::${cropIds.join(",") || "-"}`;
  const cached = getCached<GraphFactsBrief>(cacheKey);
  if (cached) return cached;

  const [suitableProducts, cropDeficiencies, district, personas] = await Promise.all([
    fetchSuitableProducts(cropIds),
    fetchCropDeficiencies(cropIds),
    districtId ? fetchDistrictContext(districtId) : Promise.resolve(null),
    fetchPersonas(cropIds, districtId),
  ]);

  const facts: GraphFactsBrief = { suitableProducts, cropDeficiencies, district, personas };
  setCached(cacheKey, facts);
  return facts;
}
