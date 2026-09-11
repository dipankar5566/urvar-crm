# Product Catalogue

What the `Product` model can hold, how much of it is actually filled in, and
how the AI voice agent uses it. Written 2026-09-12 alongside the voice-agent
quality audit (`docs/VOICE_QUALITY_AUDIT.md`) — the empty catalogue was the
single largest cap on sales quality found in that audit, larger than the
voice or the prompt.

## Current state, as of this writing

```
Product rows: 1
  URNP0108  Enriched Vermicompost  mrp=0  agronomy fields filled=0/8
```

One product, no usable price, no agronomy detail. **This has not changed
since the audit.** Nothing below fixes that — it only makes the data fixable
without a code change.

## The commercial fields (existed before this session)

| Field | Type | Notes |
|---|---|---|
| `sku` | `String` unique | |
| `name` | `String` | |
| `category` | `ProductCategory` enum | `VERMICOMPOST, PROM, HUMIC_ACID, ORGANIC_FERTILIZER, MICRONUTRIENT, SOIL_CONDITIONER, BIO_FERTILIZER, CROP_NUTRITION` |
| `hsnCode` | `String?` | |
| `description` | `String?` | free text, never populated by the original seed |
| `unit` | `String` | e.g. `kg` |
| `packSize` | `String?` | e.g. `25` |
| `mrp` | `Decimal` | **required**, but `0` is a valid stored value and means "no real price" — see below |
| `dealerPrice` / `distributorPrice` | `Decimal?` | |
| `gstPercent` | `Decimal` | default `5` |
| `isActive` | `Boolean` | inactive products are invisible to the AI's catalogue query |

## The agronomy fields (added 2026-09-12)

Eight nullable `String?` columns, added in migration
`20260911214105_voice_agent_product_agronomy_and_call_telemetry`:

| Field | What goes here | Placeholder shown in the admin form |
|---|---|---|
| `targetCrops` | Which crops it's for | "Paddy, potato, vegetables" |
| `problemSolved` | The agronomic problem it addresses | "Low soil fertility, poor root development" |
| `dosage` | Application rate | "e.g. 2 bags per bigha — leave blank unless confirmed" |
| `applicationMethod` | How to apply it | "Broadcast before sowing, mix into topsoil" |
| `nutrientContent` | Composition | "e.g. N 1.2%, P 0.8%, K 1.0%" |
| `benefits` | What it does | "What it does — never a promised yield figure" |
| `objectionNotes` | Rep-facing talking points for pushback | "What to say when a customer pushes back on this product" |
| `availability` | Stock / delivery | "In stock, 3-4 days for delivery" |

**Every one of these is nullable by design, and nothing in this repo has ever
written a value into any of them.** That is deliberate, not an oversight: a
wrong dosage told to a farmer over the phone is not a cosmetic bug, it's a
ruined crop. No model — not the voice agent, not me writing this doc — is
permitted to invent agronomic content. This data can only come from Urvar's
own agronomist.

## Where to fill it in

`/products` → pencil icon on a product row → **Agronomy details** section, at
the bottom of the edit dialog (`src/app/(dashboard)/products/product-form-dialog.tsx`).
Plain multi-line text fields, no fixed format — write them the way a rep would
say them on the phone, not as a data sheet. Leave anything unconfirmed blank.

RBAC: writable by whoever already has `products` write access (see
`PERMISSIONS` in `src/lib/permissions.ts`) — there's no separate role gate on
the agronomy fields.

## How the AI actually uses this data

**1 — The whole active catalogue is preloaded into the system prompt at call
start**, not fetched mid-conversation. `handlePlivoStream` in
`voice-agent/server.ts` queries up to 40 active products (name, category,
unit, pack size, MRP, description, and all eight agronomy fields) and hands
them to `buildSystemPrompt` (`voice-agent/pipeline/openai-agent.ts`) as
`ProductBrief[]`.

This matters for latency, not just correctness: measured live, a price
question used to cost a full tool round trip and returned a tool call
carrying **one character of prose** — the caller heard silence through a DB
hop and a second generation. See `docs/VOICE_ARCHITECTURE.md` for the numbers.

**2 — Only filled fields reach the model.** `catalogueFacts()` in
`openai-agent.ts` builds one line per product, appending each agronomy field
only if it's non-null:

```
- Enriched Vermicompost (25 kg): price not set, must be confirmed.
    for Paddy, potato, vegetables. helps with Low soil fertility, poor root development.
    dosage 2 bags per bigha. apply by Broadcast before sowing, mix into topsoil...
```

An empty catalogue renders as an explicit instruction: *"The catalogue is
empty right now. Do not name or price any product."* An unset `mrp` (stored
as `0`) renders as `price not set, must be confirmed` rather than a literal
`0` — a real bug found and fixed during the audit: the agent once told a
customer "the system shows MRP 0" for this exact product.

**3 — `get_product_info` is now a fallback, not the primary path.** The
system prompt tells the model to answer from the preloaded list and only call
the tool for something not on it at all. The tool itself
(`voice-agent/tools/crm-tools.ts`) also got two fixes this session:

- It now distinguishes **"not in the catalogue"** from **"found, but price
  unset"** — previously both returned an empty-ish result and the model had to
  guess which one it was looking at.
- It matches Bengali and Hindi synonyms (`PRODUCT_SYNONYMS` in
  `crm-tools.ts`) against the English-only `name` column — a farmer asking for
  "কেঁচো সার" or "जैविक खाद" now resolves to `vermicompost`/`organic`
  correctly. This list is translations only, never claims about a product, so
  it's safe to extend without agronomic review.

## What "done" looks like

Every active product has at minimum:

- a real `mrp` (not `0`)
- `targetCrops`
- `dosage`
- `applicationMethod`

`benefits`, `nutrientContent`, `objectionNotes` and `availability` improve the
conversation further but aren't blocking. `problemSolved` is useful for the
agent's discovery-phase framing (see `docs/VOICE_CONVERSATION_DESIGN.md`) but
optional.

Until then, the honest behaviour is the agent offering to confirm and call
back — which is what it does today, correctly, on a catalogue that currently
has nothing to offer.
