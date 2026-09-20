/**
 * Phase 2 AI_AUTONOMOUS conversation agent — tool-calling LLM driving the
 * actual sales-qualification dialogue (not Phase 1's passive suggestion-only
 * assist). Which model answers is decided by llm-provider.ts, so this file
 * holds the conversation logic and none of the provider differences.
 */
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { CRM_TOOLS, executeCrmTool, type ToolContext } from "../tools/crm-tools.js";
import { completionBody, getProvider, type LlmProvider } from "./llm-provider.js";
import { CUSTOMER_TYPE_LABELS } from "../../src/lib/constants/labels.js";
import { EMPTY_GRAPH_FACTS, type GraphFactsBrief } from "../lib/graph-facts.js";
import { toNativeScript } from "./script-guard.js";
import { fallbackLine, type SarvamTtsLanguage } from "./tts-language.js";

const MAX_TOOL_HOPS = 4;

/** Lead facts pre-loaded into the prompt so the agent doesn't have to spend
 * a tool round trip (~1-2s of dead air) fetching what we already know. */
export type LeadBrief = {
  name: string;
  state?: string | null;
  district?: string | null;
  status?: string | null;
  customerType?: string | null;
  interestedProducts?: string | null;
  expectedQuantity?: string | null;
  cropInterest?: string | null;
  remarks?: string | null;
};

function leadFacts(lead: LeadBrief): string {
  const rows: [string, string | null | undefined][] = [
    ["Name", lead.name],
    ["Location", [lead.district, lead.state].filter(Boolean).join(", ") || null],
    ["Lead status", lead.status],
    ["Segment", lead.customerType ? (CUSTOMER_TYPE_LABELS[lead.customerType] ?? lead.customerType) : lead.customerType],
    ["Interested products", lead.interestedProducts],
    ["Expected quantity", lead.expectedQuantity],
    ["Crop interest", lead.cropInterest],
    ["Notes from the team", lead.remarks],
  ];
  return rows
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

/** One catalogue row, pre-loaded into the prompt. */
export type ProductBrief = {
  name: string;
  category: string;
  unit: string;
  packSize: string | null;
  /** Null means no usable price is on file — say it will be confirmed. */
  mrp: number | null;
  description: string | null;
  /** Agronomy detail, entered by Urvar's own team. Any of these being null is
   * normal, and is why the prompt insists on offering to confirm rather than
   * filling the gap. */
  targetCrops?: string | null;
  problemSolved?: string | null;
  dosage?: string | null;
  applicationMethod?: string | null;
  nutrientContent?: string | null;
  benefits?: string | null;
  availability?: string | null;
};

/** What happened last time we called this lead. */
export type PriorCallBrief = {
  daysAgo: number;
  outcome: string | null;
  summary: string | null;
};

/**
 * Decides whether a product name coming out of the knowledge graph is one the
 * CRM actually sells.
 *
 * The two catalogues were authored separately and neither spells a product the
 * same way, so an exact compare is useless: the graph says "PROM — Phosphate
 * Rich Organic Manure" where the CRM says "Phosphate Rich Organic Manure", and
 * "Humic Acid — Liquid Bio-Stimulant" where the CRM says "Liquid Humic Acid".
 * The rule that works on the real data is containment by word: a graph name
 * counts as stocked when every word of some CRM product's name appears in it.
 *
 * Checked against all eight graph products: it matches the four the CRM
 * stocks and rejects the four it does not (PROM Humic Enriched, PROM Humic
 * Based Flowering Booster, Zinc EDTA 12%, Boron EDTA). The two-word floor
 * stops a hypothetical one-word CRM name from matching everything.
 */
function productWords(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function makeStockedTest(products: ProductBrief[]): (graphName: string) => boolean {
  const catalogue = products.map((p) => productWords(p.name)).filter((w) => w.length >= 2);
  return (graphName: string) => {
    const words = new Set(productWords(graphName));
    return catalogue.some((entry) => entry.every((w) => words.has(w)));
  };
}

function catalogueFacts(products: ProductBrief[]): string {
  if (products.length === 0) {
    return "The catalogue is empty right now. Do not name or price any product. If they ask, say you will confirm the details and have someone send them.";
  }
  return products
    .map((p) => {
      const pack = [p.packSize, p.unit].filter(Boolean).join(" ");
      const price = p.mrp != null && p.mrp > 0 ? `${p.mrp} rupees` : "price not set, must be confirmed";
      // Only what is actually filled in reaches the model. An absent dosage is
      // a dosage it cannot state, which is the entire point.
      const detail = [
        p.description,
        p.targetCrops ? `for ${p.targetCrops}` : null,
        p.problemSolved ? `helps with ${p.problemSolved}` : null,
        p.dosage ? `dosage ${p.dosage}` : null,
        p.applicationMethod ? `apply by ${p.applicationMethod}` : null,
        p.nutrientContent ? `contains ${p.nutrientContent}` : null,
        p.benefits ? `benefits ${p.benefits}` : null,
        p.availability ? `availability ${p.availability}` : null,
      ]
        .filter(Boolean)
        .join(". ");
      return `- ${p.name}${pack ? ` (${pack})` : ""}: ${price}${detail ? `. ${detail}` : ""}`;
    })
    .join("\n");
}

function historyFacts(priorCalls: PriorCallBrief[]): string {
  if (priorCalls.length === 0) return "";
  const lines = priorCalls
    .map((c) => {
      const when = c.daysAgo <= 0 ? "today" : c.daysAgo === 1 ? "yesterday" : `${c.daysAgo} days ago`;
      return `- ${when}${c.outcome ? ` (${c.outcome.replaceAll("_", " ").toLowerCase()})` : ""}: ${c.summary ?? "no summary"}`;
    })
    .join("\n");
  return `
Previous calls with this person — do NOT ask again what these already answer:
${lines}
`;
}

/**
 * Formats knowledge-graph facts (crop agronomy, district context, similar
 * farmers) into a labeled prompt block, mirroring historyFacts' "empty
 * string when there's nothing to say" convention — an unmatched
 * district/crop, or the flag being off, adds nothing to the prompt.
 *
 * The graph mixes Urvar-curated (high confidence) and third-party
 * "ChatGPT-assisted" (lower confidence) facts as-is (see all.md Risks), so
 * the model is told explicitly not to state this more confidently than the
 * catalogue above, and never to volunteer it unprompted.
 */
function graphFacts(facts: GraphFactsBrief, stocked: (name: string) => boolean): string {
  const lines: string[] = [];

  // The graph is loaded by a separate ETL and has no isActive concept and no
  // join back to the CRM — it knows eight products where the CRM sells four.
  // Rendering a graph name we do not stock would contradict the "this is the
  // whole catalogue, nothing else exists" line two blocks above, and the
  // prompt now tells the agent to offer a range rather than one product, so
  // it is far likelier to read one of these out.
  // Grouped per crop, not flattened: a lead who grows paddy and tomato needs
  // the agent to know which product goes with which, not one merged list.
  const productsByCrop = new Map<string, string[]>();
  for (const p of facts.suitableProducts) {
    if (!stocked(p.product)) continue;
    const entry = p.stage ? `${p.product} (${p.stage} stage)` : p.product;
    productsByCrop.set(p.crop, [...(productsByCrop.get(p.crop) ?? []), entry]);
  }
  for (const [crop, products] of productsByCrop) {
    lines.push(`Products suited to ${crop}: ${products.join(", ")}`);
  }

  const deficienciesByCrop = new Map<string, string[]>();
  for (const d of facts.cropDeficiencies) {
    const treatedBy = d.treatedBy.filter(stocked);
    const entry = `${d.deficiency}${treatedBy.length ? ` (treated by ${treatedBy.join(", ")})` : ""}`;
    deficienciesByCrop.set(d.crop, [...(deficienciesByCrop.get(d.crop) ?? []), entry]);
  }
  for (const [crop, deficiencies] of deficienciesByCrop) {
    lines.push(`${crop} is commonly susceptible to: ${deficiencies.join("; ")}`);
  }
  if (facts.district) {
    const d = facts.district;
    const bits = [
      d.soilTypes.length ? `soil type ${d.soilTypes.join("/")}` : null,
      d.deficiencies.length ? `known deficiencies ${d.deficiencies.map((x) => x.name).join(", ")}` : null,
      d.zone ? `agro-climatic zone ${d.zone}` : null,
    ].filter(Boolean);
    if (bits.length) lines.push(`${d.name} district context: ${bits.join("; ")}.`);
  }
  if (facts.personas.length > 0) {
    const prefs = facts.personas
      .map((p) => p.preferredProducts.filter(stocked).join(", "))
      .filter(Boolean);
    if (prefs.length) lines.push("Similar farmers in this crop/area typically prefer: " + prefs.join("; "));
  }

  if (lines.length === 0) return "";
  return `
Background knowledge (use only if it naturally fits the conversation — never volunteer it unprompted, and never state it with more confidence than the catalogue facts above):
${lines.map((l) => `- ${l}`).join("\n")}
`;
}

export function buildSystemPrompt(
  lead: LeadBrief,
  language: string,
  context: {
    products?: ProductBrief[];
    priorCalls?: PriorCallBrief[];
    graphFacts?: GraphFactsBrief;
  } = {},
): string {
  const products = context.products ?? [];
  const priorCalls = context.priorCalls ?? [];
  const graph = context.graphFacts ?? EMPTY_GRAPH_FACTS;
  // Phase 5 of the sales-funnel automation roadmap: dark by default. When
  // off (the common case today), leave the existing "you cannot send a
  // quotation yourself" wording untouched below.
  const autoQuoteEnabled = process.env.AI_AUTO_QUOTE_ENABLED === "true";
  // Phase 6: dark by default, same reasoning as autoQuoteEnabled — leave the
  // prompt silent about account balances entirely when off, rather than
  // describing a tool the model has no schema for.
  const financialDisclosureEnabled = process.env.AI_FINANCIAL_DISCLOSURE_ENABLED === "true";
  // Only an Indic language has a script to insist on, and the rule has to be
  // absent (not merely inapplicable) on an English call: interpolated, it read
  // "Write Indian English in its own native script ... Bengali in Bengali
  // script", and eval:agent caught the model answering four English scenarios
  // in Bengali because of it.
  const scriptRule = /english/i.test(language)
    ? "- Write in plain Latin script, the way Indian business English is written."
    : `- Write ${language} in its own script, never in Latin transliteration: the speech engine pronounces the letters you actually write, so a ${language} sentence spelled in Latin comes out mispronounced and robotic. English words people genuinely say out loud, like delivery, rate, quantity and vermicompost, may stay in Latin inside a native-script sentence.`;

  return `You are a sales executive at Urvar Natural, an organic-fertilizer company in India, calling a lead. This is a real, live phone call — the person can hear you speak. You are not a bot reading a script; you are a knowledgeable person having a short, useful conversation.

What we already know about this lead:
${leadFacts(lead)}
${historyFacts(priorCalls)}
Products you may discuss (this is the whole catalogue — nothing else exists):
${catalogueFacts(products)}
${graphFacts(graph, makeStockedTest(products))}
HOW YOU SPEAK — this matters more than anything else below:
- Be brief. A question of yours should be 5-15 words, and open each turn with a short sentence.
- Ask exactly ONE question per turn. Never stack two questions together.
- React to what they just said in two or three words before you ask anything.
- Don't pad, and don't raise topics nobody asked about. But DO answer properly when asked something directly — brevity must never make you unhelpful.
- Let them talk more than you do. Silence after your question is fine.

IF THEY ASK WHO YOU ARE, or to introduce yourself, or where you are calling from — answer it properly before anything else: your name is not needed, but say you are calling from Urvar Natural, that Urvar makes organic fertilisers, bio-fertilisers and soil-health products for farmers, distributors, dealers, retailers and FPOs across India, naming two or three of the actual products from the list above rather than only the first one, and why you are calling them. Say it like someone who knows the business, not a slogan, and stay within your normal turn length even here. Only then continue. Never answer this with a bare company name and an immediate counter-question, and never ignore it to stay on your own agenda. If they ask twice, they did not hear you: say it again more slowly and more fully, and do not ask anything else that turn.

HOW THE CALL SHOULD GO — follow this order, but if they jump ahead, or give a clear buying signal (see the transfer rule below), act on that instead of asking the next scripted question:
1. Greet them, say you are calling from Urvar Natural about organic fertilisers and soil-health products, ask if now is a good time.
2. If they are busy but have not named a time, ask when would suit them better and wait — never end the call in the same turn you ask, because "I am busy" is a reason to book a time, not to hang up on someone. The moment they DO name a time, call schedule_follow_up.
3. Unless they already gave a buying signal (a trade buyer asking for a price list counts — transfer instead, do not ask this), ask a qualifying question that fits their Segment (shown above), one fact per turn: Farmer — what they grow and how much land; Retailer or Agri Input Shop — what they currently stock and roughly how much they sell in a month; Dealer or Distributor — what volume they currently handle and which brands they carry; FPO / Cooperative or NGO — how many member or beneficiary farmers they represent and the land or demand across them; Government — the tender or scheme quantity and specification; Corporate Farm or Plantation — how much land they manage and what they grow. If Segment is missing, ask what kind of buyer they are before choosing a question.
4. Find out what they use now, how much they need, and when.
5. Only then suggest products — two or three from the list above that fit their crop, problem and Segment, in one short turn, not the same one every time and never a recital of the whole list. If they ask what else you have, name the remaining ones briefly and ask which to go into. Never name anything that is not on that list.
6. Handle an objection without arguing and without offering a discount: for price, ask what they are comparing against; if they have never used it, suggest a small trial; if they use another brand, ask how it has worked; if they want it later, ask roughly when; if they doubt it works, say what it does but never promise a yield figure. For dealer margin, delivery or credit terms, say our team will confirm and book a callback.
7. Agree a next step before ending: a callback, or a person to call them.${autoQuoteEnabled ? " If they are an existing customer asking to reorder a standard product and quantity, call create_quotation — if it refuses, fall back to the next sentence." : ""} If they have already told you a quantity and roughly when they need it${autoQuoteEnabled ? " and create_quotation was not used or was refused" : ""}, tell them our sales team will prepare a formal quotation and follow up with them, then call schedule_follow_up — never say you are sending or preparing the quotation yourself${autoQuoteEnabled ? " unless create_quotation actually confirmed it" : ""}, because that is not something you can${autoQuoteEnabled ? " otherwise" : ""} do. This does not delay ending the call: a clear closing cue from the lead always ends the call, whether or not timing was pinned down.

Rules:
- Your words are read aloud by a speech engine, so write how people talk, not how they write. Never use dashes, brackets, bullet points, quotes, emoji, or abbreviations like "etc." — a dash becomes an abrupt break when spoken. Write numbers and units the way you would say them.
- Sound warm and human: react to what they just said in two or three words before moving on, and vary your wording rather than opening every turn the same way.
- Start the call in ${language}, because that is this lead's regional language. If they reply in a different language, switch immediately and match them from then on, including Hindi/English/Bengali code-switching.
${scriptRule}
- The lead's details AND the full catalogue above are already loaded — do NOT call get_lead_context or get_product_info for anything already listed there. Answer price and pack-size questions straight from the list, because a tool call is a second of silence on a live phone call. Only use get_product_info if they ask about something not on the list at all. Use check_quotation_status when they ask about a quotation.${autoQuoteEnabled ? " Use create_quotation only for a simple standard reorder from an existing customer — never state a price yourself, only what its response confirms." : ""}${financialDisclosureEnabled ? " If they ask about their balance, dues, an overdue amount, or their account, call get_account_status — never state a figure from memory or guess one, only what its response actually returns. If it reports no linked account, say you cannot pull that up on this call and offer a callback or transfer, never a number." : ""}
- You may be interrupted mid-sentence. If you are told you were cut off, do NOT restart your pitch — answer what they just said and carry on from where you were. (Asking who you are is the exception above: always answer that.)
- Don't repeat a question you have already asked. If the lead only says "hello" or "bataiye", assume they simply did not catch the last line: rephrase it once, more briefly, rather than starting over.
- Speech-to-text sometimes splits one answer into several short fragments (e.g. "we" then, a moment later, "Harmicompost"). If what you were just told looks like an incomplete sentence fragment rather than a real non-answer — a trailing word, a lone noun, something that reads like it was cut off — do NOT treat it as a failure to hear and do NOT re-ask your last question verbatim. Instead, briefly invite them to continue with a short "yes, go on" in the language you are speaking, so the rest of their answer can land, and only ask the full question again if the next thing they say still doesn't answer it.
- NEVER read internal system data aloud. Do not mention databases, systems, fields, MRP codes, or say things like "the system shows". Where the list above says a price must be confirmed, simply say our team will confirm the exact rate and offer to have it shared — never quote or imply a number you were not given.
- Transfer to a person ONLY on a clear buying signal: they say they want to place an order, they name a quantity they intend to buy now, they ask about becoming a dealer, they ask for a price list or rate card as a trade buyer (retailer, dealer, distributor, agri input shop), or they ask to speak to someone. Then call transfer_to_human and stop selling. Simply asking the price as an end consumer is NOT a buying signal — answer it and carry on qualifying.
- Never say you are connecting them until the transfer has actually been made. Say something neutral like "let me get our sales person for you" and call the tool. If transfer_to_human returns an error, do not mention transferring at all: call schedule_follow_up and say our executive will call them back shortly.
- If the caller asks not to be called again, call mark_do_not_call. Only on an explicit request. Someone who is annoyed, abrupt, or says they are not interested has NOT asked to be removed — apologise, ask if a better time would suit, and leave them on the list.
- If they want a callback at a specific time, call schedule_follow_up.
- End the call only when the lead has nothing further — they have said goodbye or thanks, confirmed they are done, or clearly said they are not interested. When that happens, say a brief goodbye and call end_call in the same turn. Never just stop responding.
- NEVER end the call in the same turn the lead states a requirement, quantity, crop or delivery need. That is a buying signal, not a goodbye. Confirm what you heard, answer anything they asked, and ask whether they need anything else first.
- Never invent product details, prices, or availability you weren't given by a tool.${financialDisclosureEnabled ? " Never invent or estimate a balance, credit limit, or overdue amount either — only get_account_status's actual response." : ""}`;
}

/** Timings this module owns, handed back to the caller rather than logged
 * here — server.ts holds the callId and the rest of the turn's clock, and
 * this module has no business knowing about either. */
export type AgentTurnTimings = {
  requestStartedAt: number;
  firstTokenAt: number | null;
  hops: number;
  tools: string[];
};

export type AgentTurnResult = {
  reply: string;
  history: ChatCompletionMessageParam[];
  controlSignal?: "end_call" | "transfer_to_human";
  timings: AgentTurnTimings;
};

/**
 * Wraps the completion call so a model that rejects our latency tuning
 * degrades to a slower answer instead of no answer at all.
 *
 * MODEL is env-configurable and models disagree about which
 * `reasoning_effort` values they accept — "minimal" is in the SDK's type
 * union but this model only takes 'none'/'low'/'medium'/'high'/'xhigh'.
 * When that mismatch happened live, every turn 400'd and the caller just
 * heard silence for the whole call, so a future model swap must not be able
 * to mute the agent the same way.
 */
/** Always called with `stream: true`; the SDK's overloads can't see that
 * through a dynamically-built body, so the stream type is asserted once
 * here rather than at each call site. */
type CompletionStream = AsyncIterable<ChatCompletionChunk>;

/**
 * How long to wait for a live-call completion before giving up.
 *
 * The SDK default is 10 minutes with retries, which on a phone call is
 * indistinguishable from a dead line — and the provider does stall: a
 * six-scenario eval run on 2026-09-11 lost two of them to
 * "Request timed out waiting for response headers". Measured median time to
 * first token is ~430ms, so 6s is many times the normal case while still
 * failing fast enough for the caller to hear the holding line instead of
 * silence. One retry, not the SDK's default two, for the same reason.
 */
const LLM_REQUEST_TIMEOUT_MS = Number(process.env.VOICE_AGENT_LLM_TIMEOUT_MS) || 6000;

async function createCompletion(provider: LlmProvider, body: Record<string, unknown>): Promise<CompletionStream> {
  const requestOptions = { timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 1 };
  try {
    return (await provider.client.chat.completions.create(
      body as never,
      requestOptions,
    )) as unknown as CompletionStream;
  } catch (err) {
    if (
      !(err instanceof OpenAI.APIError) ||
      err.status !== 400 ||
      (err.param !== "reasoning_effort" && err.param !== "verbosity")
    ) {
      throw err;
    }

    console.error(
      `[llm] ${provider.name}/${provider.model} rejected ${err.param} — retrying without latency tuning. Fix the value in llm-provider.ts; calls are slower until then.`,
    );
    const retryBody = { ...body };
    delete retryBody.reasoning_effort;
    delete retryBody.verbosity;
    return (await provider.client.chat.completions.create(
      retryBody as never,
      requestOptions,
    )) as unknown as CompletionStream;
  }
}

/**
 * Splits off every complete sentence in `buf`, returning the unterminated
 * remainder to keep buffering. Handles the Devanagari danda alongside
 * western punctuation, and deliberately does NOT split a full stop sitting
 * between two digits — "1.5 ton" must not become "1." + "5 ton", which TTS
 * would read aloud as "one point" … "five ton".
 */
/**
 * Splits off complete sentences, returning the unterminated remainder to
 * keep buffering.
 *
 * Deliberately sentence-only. An earlier version also broke at commas to
 * start speaking sooner, which shipped and made the agent sound robotic:
 * every clause was synthesized as its own utterance with its own
 * sentence-final intonation, so a greeting came out as three clipped
 * fragments. Perceived latency is covered by the filler word instead — see
 * FILLER_DELAY_MS in server.ts.
 */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "।" && ch !== "\n") continue;
    // "1.5 ton" must not become "1." + "5 ton" — TTS reads that aloud wrong.
    if (/\d/.test(buf[i - 1] ?? "") && /\d/.test(buf[i + 1] ?? "")) continue;
    const sentence = buf.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }
  return { sentences, rest: buf.slice(start) };
}

/** A one-word sentence like "ভালো।" voiced on its own sounds clipped, so
 * hold short pieces and let them ride along with the next one. */
const MIN_SPEAK_CHARS = 24;

/**
 * Whether this sentence is a question, and so must be spoken on its own.
 *
 * Bengali and Devanagari both use "?" for questions — the danda "।" ends a
 * statement — so the one mark covers every language this agent speaks.
 */
function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence);
}

type StreamedTurn = {
  content: string;
  /** Resolves to this turn's text with any romanized sentence put back into
   * the call's script, or null when nothing drifted.
   *
   * The caller does not wait for it: the audio has already gone out. It patches
   * the assistant message in the history once it lands, which is what actually
   * matters — drift is self-sustaining, and a romanized assistant turn sitting
   * in the history is what keeps the next turn romanized. Never rejects. */
  scriptFix: Promise<string | null>;
  toolCalls: { id: string; name: string; arguments: string }[];
  /** When the model produced anything at all — prose or the first fragment of
   * a tool call. A price question returns a tool call with almost no prose, so
   * counting only content would report those turns as never having started. */
  firstTokenAt: number | null;
};

/**
 * Consumes one streamed completion, emitting each finished sentence through
 * `onSentence` as soon as it lands rather than waiting for the whole reply.
 * That is the entire point of streaming here: TTS can start on sentence one
 * while the model is still writing sentence two, which is what turns a
 * ~1-2s silence into ~0.3-0.5s.
 *
 * Tool-call deltas arrive split across chunks and keyed by `index`, so they
 * have to be reassembled (id and name usually arrive once, `arguments` in
 * fragments) before the caller can dispatch them.
 */
async function consumeStream(
  stream: Awaited<ReturnType<typeof createCompletion>>,
  onSentence: ((sentence: string) => void) | undefined,
  isCancelled: () => boolean,
  /** The call's voice language, so a sentence the model wrote in Latin can be
   * put back into that language's script before it is spoken. Null for
   * callers with no voice (the eval harness), which skips the guard. */
  language: SarvamTtsLanguage | null = null,
): Promise<StreamedTurn> {
  let content = "";
  let unspoken = "";
  /** A completed sentence too short to voice on its own yet. */
  let held = "";
  let firstTokenAt: number | null = null;
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  // Speak first, correct afterwards. The script guard's network hop measured
  // 524-875ms per sentence against the live endpoint, with a cold-connection
  // outlier over 1500ms — far too much to put in front of every sentence of a
  // turn. So the sentence goes out as the model wrote it, and the conversion
  // runs alongside it: by the time the lead has listened and replied, the
  // corrected text is in the history and the next turn is written in the right
  // script. Drift is self-sustaining rather than random, so that is where
  // nearly all of the value is, and it costs the caller nothing.
  //
  // Emission is funnelled through here so the guard cannot be bypassed by one
  // of the three call sites below. toNativeScript() makes no network call at
  // all unless the sentence actually looks like drift.
  const scriptFixes: Promise<{ before: string; after: string }>[] = [];
  const emit = onSentence
    ? (sentence: string) => {
        onSentence(sentence);
        if (language) {
          scriptFixes.push(
            toNativeScript(sentence, language).then((after) => ({ before: sentence, after })),
          );
        }
      }
    : undefined;

  for await (const chunk of stream) {
    if (isCancelled()) break;
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (firstTokenAt === null && (delta.content || delta.tool_calls?.length)) {
      firstTokenAt = Date.now();
    }

    if (delta.content) {
      content += delta.content;
      unspoken += delta.content;
      // Only flush on a boundary — speaking half a clause would sound worse
      // than the latency it saves.
      if (emit) {
        const { sentences, rest } = takeSentences(unspoken);
        unspoken = rest;
        for (const sentence of sentences) {
          if (isCancelled()) break;
          // A question has to reach TTS as its own utterance. Sarvam gives an
          // utterance a single contour, so a question with a statement glued
          // in front of it is read with statement intonation and simply does
          // not sound like a question. Measured on rendered samples: the same
          // clause rises +3.2 to +5.6 semitones alone and falls -3.9 to -5.1
          // behind a lead-in, and the wording made no difference — swapping
          // the two questions swapped the result with them. 94 of the 243
          // questions in the call logs were arriving glued, which is exactly
          // the "sometimes it doesn't sound like a question" heard on calls.
          //
          // The cost is that `held` can now be voiced alone below
          // MIN_SPEAK_CHARS. That is the lesser evil: a short acknowledgement
          // on its own is what fillerWord() already says every turn, whereas
          // a flattened question misleads the person on the phone.
          if (isQuestion(sentence)) {
            if (held) emit(held);
            held = "";
            emit(sentence);
            continue;
          }
          // Merge short pieces so each spoken utterance is a natural unit.
          held = held ? `${held} ${sentence}` : sentence;
          if (held.length >= MIN_SPEAK_CHARS) {
            emit(held);
            held = "";
          }
        }
      }
    }

    for (const tc of delta.tool_calls ?? []) {
      const slot = byIndex.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      byIndex.set(tc.index, slot);
    }
  }

  // Anything held back for being short, plus any text that never got a
  // closing punctuation mark, still has to be said.
  const tail = [held, unspoken.trim()].filter(Boolean).join(" ").trim();
  if (emit && tail && !isCancelled()) emit(tail);

  return {
    content,
    scriptFix: scriptFixes.length
      ? Promise.all(scriptFixes).then((parts) =>
          parts.some((p) => p.after !== p.before) ? parts.map((p) => p.after).join(" ") : null,
        )
      : Promise.resolve(null),
    toolCalls: [...byIndex.values()].filter((t) => t.name),
    firstTokenAt,
  };
}

export async function runAgentTurn(
  history: ChatCompletionMessageParam[],
  userUtterance: string,
  toolCtx: ToolContext,
  /** Called with each finished sentence as it streams, so speech can start
   * before generation ends. Omit for non-spoken callers. */
  onSentence?: (sentence: string) => void,
  /** Lets a barge-in abandon the rest of an in-flight reply. */
  isCancelled: () => boolean = () => false,
  /** The call's voice language, passed through to the script guard so a
   * romanized reply is put back into that language's script before it is
   * spoken. Null for callers with no voice, e.g. scripts/eval-agent.ts. */
  language: SarvamTtsLanguage | null = null,
): Promise<AgentTurnResult> {
  const messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userUtterance },
  ];

  let controlSignal: AgentTurnResult["controlSignal"];
  // Resolved once per turn rather than per hop — the client is cached, but
  // this also keeps a mid-turn env change from splitting one reply across
  // two providers.
  const provider = getProvider();
  const timings: AgentTurnTimings = {
    requestStartedAt: Date.now(),
    firstTokenAt: null,
    hops: 0,
    tools: [],
  };

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    timings.hops = hop + 1;
    // Reasoning depth and the token-limit field name both differ per
    // provider and are supplied by completionBody — this is a live phone
    // call, so every second of hidden reasoning before the first token is
    // dead air the caller hears as the AI going silent.
    const stream = await createCompletion(
      provider,
      completionBody(provider, { messages, tools: CRM_TOOLS, stream: true }, 200),
    );

    const { content, scriptFix, toolCalls, firstTokenAt } = await consumeStream(
      stream,
      onSentence,
      isCancelled,
      language,
    );
    // Only the first hop's first token is the caller's perceived latency;
    // later hops are already behind spoken audio or a filler word.
    if (timings.firstTokenAt === null) timings.firstTokenAt = firstTokenAt;

    if (isCancelled()) {
      // Barge-in: the caller is already talking over this reply, so record
      // what was generated and let the next turn take over.
      return { reply: content.trim(), history: messages, controlSignal, timings };
    }

    const assistantMessage: ChatCompletionAssistantMessageParam =
      toolCalls.length > 0
        ? {
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : { role: "assistant", content };
    messages.push(assistantMessage);

    // Patch the history in place once the script guard catches up. Deliberately
    // not awaited: the audio for this turn has already gone out, and blocking
    // here would delay the TTS flush that server.ts does right after this call
    // returns — i.e. it would put the latency back, just in a different place.
    // The lead has to listen and reply before the next turn reads this, which
    // is several seconds, so the correction is in place long before it counts.
    void scriptFix.then((fixed) => {
      if (fixed) assistantMessage.content = fixed;
    });

    if (toolCalls.length === 0) {
      // No tool calls — this was the model's spoken reply, already streamed
      // out sentence by sentence above.
      return { reply: content.trim(), history: messages, controlSignal, timings };
    }

    for (const call of toolCalls) {
      timings.tools.push(call.name);
      const result = await executeCrmTool(call.name, call.arguments, toolCtx);
      if (result.controlSignal) controlSignal = result.controlSignal;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.output),
      });
    }

    // end_call/transfer_to_human: let the model produce one more turn (e.g.
    // its farewell line) before the loop's caller acts on the signal, but
    // don't keep looping indefinitely once a control signal has fired.
    if (controlSignal) {
      // `tools` must be sent even though the farewell needs none: `messages`
      // now contains tool_calls and tool results, and Sarvam rejects that
      // history outright ("Tool messages found but no tools provided") while
      // OpenAI tolerates it. Omitting it 400'd every goodbye on the first
      // Sarvam call — end_call had already recorded the outcome, so the call
      // simply went silent until the timeout hung up on the lead.
      const closingStream = await createCompletion(
        provider,
        completionBody(provider, { messages, tools: CRM_TOOLS, stream: true }, 100),
      );
      const closing = await consumeStream(closingStream, onSentence, isCancelled, language);
      const closingText = closing.content.trim();
      if (closingText) messages.push({ role: "assistant", content: closingText });
      return { reply: closingText, history: messages, controlSignal, timings };
    }
  }

  return {
    // server.ts speaks this when the turn produced no prose of its own, so it
    // has to be in the call's language — it was a hardcoded English sentence,
    // read aloud mid-way through a Bengali conversation.
    reply: fallbackLine(language ?? "en-IN"),
    history: messages,
    controlSignal: "end_call",
    timings,
  };
}
