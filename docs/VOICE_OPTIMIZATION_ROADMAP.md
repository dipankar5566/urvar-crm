# Voice Optimization Roadmap

Priorities from the 2026-09-11 audit. P0 and P1 shipped on 2026-09-12; what
remains is listed with the evidence that would close it, so nothing here needs
re-arguing from scratch.

Ordering is by customer-experience impact, then sales impact, then latency,
then reliability, then effort.

## Shipped — P0

| # | Item | Evidence it worked |
|---|---|---|
| P0-1 | Per-turn and per-call telemetry | `npm run voice:latency` returns data |
| P0-2 | Two-stage barge-in on speech onset | `stage=B via=partial` outnumbers `via=final` |
| P0-3 | Voice output filter, turn-length and one-question rules | `npm run voice:stats` |
| P0-4 | 6 s LLM timeout, stalls counted | `stalled=1` rate in `[turn]` lines |
| P0-5 | Catalogue miss distinguished from price-unset; Bengali/Hindi synonyms | eval scenarios |
| P0-6 | Transcript survives a summariser failure; outcome recorded when `end_call` never fires | no call without an outcome |
| P0-7 | Catalogue preloaded — no tool hop for price | `tools=-` on price turns |
| P0-8 | `SARVAM_STT_SILENCE_MS` made tunable | — |
| P0-9 | Audio-transport jitter instrumented | `frameGapP90`, `longGaps` |

Three defects were found while building these, and fixed: audio for a cancelled
sentence kept playing after `clearAudio`; the agent's own voice was being fed
to its speech recogniser; and the holding line bypassed the audio gate.

## Shipped — P1

Sales-flow prompt, objection library, cross-call context, structured call
memory (`Call.aiStructured`), product agronomy columns with an admin UI,
`transfer_to_human` re-enabled with logging and a kill switch, and the eval
harness extended to 21 scenarios across three languages.

## Do next

### 1 · Fill in the product catalogue — *blocks everything commercial*
**Why first.** The live catalogue is one row with no price. The agent can now
carry a proper sales conversation and has almost nothing to say. This caps
sales quality harder than voice, latency or prompt ever will.
**Who.** Urvar's agronomist, through `/products` → Agronomy details. Nothing
here can be generated: a wrong dosage is a ruined crop.
**Done when.** Every active product has at least targetCrops, dosage,
applicationMethod and a real MRP.

### 2 · Capture a real-call baseline, then compare
**Why.** Every P0 claim above is verified in code and in the eval, not yet on
the phone. Ten to twenty real calls give the numbers.
**Done when.** `voice:latency` and `voice:stats` both show post-change figures
beside the 2026-09-11 baseline.

### 3 · The barge-in listening test
Interrupt at 20%, 50%, 80%; confirm "achha" does *not* truncate. See
`VOICE_TEST_PLAN.md`. **Do this before trusting the release on live leads.**

### 4 · Settle the language-switch question
One deliberate switch call, listened to, then either fix the prompt or
reconnect the TTS socket. Deliberately left open rather than guessed.

### 5 · Decide on the audio transport
After roughly a week of calls, read `frameGapP90` and `longGaps`. Past ~200 ms
p90, or gaps over 500 ms on more than ~5% of calls, split
`voice.urvarindia.com` onto its own cloudflared service — cheap, and it mirrors
the pattern already on this box. Only then consider a VM near Plivo's India
region, which is a far larger change because Postgres lives here.

### 6 · Voice selection study
Extend `tts:samples` to a 2–5 minute script across 3 speakers × 3 languages,
and have native speakers rate it. A voice that charms for ten seconds can grate
over four minutes.

### 7 · Fill the test matrix
21 scenarios today against a target of 20+ *per language*. The structure
supports it; the ranked gaps are in `VOICE_TEST_PLAN.md`.

## Deferred, with reasons

**A/B testing framework — not yet.** 38 calls exist in total. Splitting that
across arms would produce confident-looking noise rather than a result.
Revisit at sustained weekly volume; until then, telemetry plus the eval suite
is the feedback loop. When it becomes worth building, the metrics to compare
are already collected: call duration, interruption rate, handoff rate, outcome,
and hang-ups inside the first 30 seconds.

**Answering-machine detection.** Voicemail currently burns a full AI call and
leaves a junk CRM row. Plivo supports it on `calls.create`; cheap to add,
moderate payoff, no urgency at current volume.

**Ring timeout.** None is set on `calls.create` today.

**Recording playback on the call detail page.** Present on the list page,
missing on the detail page.

**Conversation phase tracking.** The sales sequence is in the prompt, but the
session does not track which phase a call is in. Add it only if real calls show
the agent skipping steps — and record the phase per turn in telemetry so it can
be seen rather than guessed. Reasoning in `VOICE_CONVERSATION_DESIGN.md`.

**Redacting lead speech from logs.** `[sarvam-stt] FINAL: "…"` and the barge-in
lines write customer speech into `logs/` on the production box. The new
telemetry deliberately logs only counts and a language code. Whether to redact
what is already there is a privacy decision, not an engineering one.

## Things not worth trying again

- **Flushing TTS earlier.** Measured: no difference (222/220/244 ms without an
  immediate flush, 228/238 ms with). Sarvam synthesises on a complete sentence.
- **Clause-level TTS chunking.** Shipped once; every fragment got sentence-final
  intonation, and that is what "robotic" meant.
- **Blaming the network to Sarvam.** 48–50 ms, stable, no jitter.
- **Switching provider for speed.** sarvam-105b is already 2–3× faster to first
  token than gpt-5.4. Reliability, not speed, is the open question there.
