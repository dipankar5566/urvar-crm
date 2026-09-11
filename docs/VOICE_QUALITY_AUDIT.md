# Voice Quality Audit

Audited 2026-09-11 against 38 stored calls (18 with transcripts, 103 AI turns,
111 lead turns) and live probes of Plivo, Sarvam STT/TTS and both LLM
providers. Scores are 1–10.

Reproduce the conversation numbers with `npm run voice:stats`, and the latency
numbers with `npm run voice:latency` once calls have run against the current
build.

## The measured baseline

| Measurement | Baseline (2026-09-11) | Target |
|---|---|---|
| AI turn length — mean / median / p90 / max | **19.4 / 19 / 27 / 40 words** | 5–15 |
| AI turns over 15 words | **70%** | under 35% |
| Turns stacking 2+ questions | **16 of 103** | ~0 |
| AI : lead word ratio | **3.22 : 1** | ≤ 1.5 : 1 |
| Lead turn length, median | 3 words | higher |
| Duplicate AI lines in a call | 0 | 0 |
| Markdown or emoji reaching TTS | 0 | 0 |
| Turns needing a filler word (model slower than 400 ms) | **31 of 92 (34%)** | lower |
| Barge-ins detected in 92 turns | 9 | — |
| Production latency data | **none existed** | measured |

## Scorecard

### Voice naturalness — 6/10
- **Problem.** Acceptable but unrated on a long call. `pace` and `temperature`
  are unset, one speaker ("shubh") has ever been used, and no native speaker
  has scored a 2–5 minute conversation.
- **Root cause.** Voice choice was made from short samples, not realistic calls.
- **Fix.** Extend `npm run tts:samples` to 2–5 minute scripts across three
  speakers and three languages; have a native Bengali and a native Hindi
  speaker rate them.
- **Expected gain.** Moderate, and unknowable until someone listens.
- **Difficulty.** Low to build, but it needs human ears — I cannot score it.

### Pronunciation — 5/10
- **Problem.** No lexicon for the business vocabulary (কৃষি, বিঘা,
  ভার্মিকম্পোস্ট, হিউমিক অ্যাসিড, PROM).
- **Root cause.** **`bulbul:v3` has no SSML and no phoneme control.** A hard
  vendor limit, not an oversight.
- **Fix.** `pipeline/voice-output.ts` carries a `PRONUNCIATION_LEXICON` that
  respells words orthographically. It ships **empty on purpose**: a respelling
  invented without hearing the mistake is as likely to break a word as fix one.
- **Expected gain.** Small but real, once entries are added from recordings.
- **Difficulty.** Low per entry; needs a listener.

### Bengali quality — 6/10
- **Problem.** Reads as natural West Bengal Bengali with sensible code-mixing,
  but nothing steers it away from Bangladeshi or literary register, and no
  native speaker has assessed it.
- **Fix.** Register guidance now lives in `VOICE_PERSONA.md`; add explicit
  counter-examples to the prompt if a review finds drift.
- **Difficulty.** Low.

### Hindi quality — 5/10 · English quality — 5/10
- **Problem.** No production evidence at all. All 18 transcripts are
  Bengali-dominant.
- **Fix.** The eval now runs 6 Hindi and 5 English scenarios, which is a floor,
  not proof. Real calls are needed.
- **Difficulty.** Low; a coverage gap rather than a defect.

### Latency — was unmeasurable, now instrumented
- **Problem.** No instrumentation existed in production. The only number in the
  repo came from the offline eval.
- **Root cause.** Never built.
- **Fix.** `pipeline/turn-metrics.ts` emits a `[turn]` line per turn and a
  `[call-metrics]` line per call; `npm run voice:latency` summarises them.
- **Measured budget.** ~1.5–1.8 s per normal turn; ~2.5–3 s for a price turn
  before the catalogue preload. See `VOICE_ARCHITECTURE.md`.
- **Expected gain.** ~0.9–1.2 s per turn after the short-first-sentence rule
  and the catalogue preload. **Sub-800 ms is not reachable** while media
  terminates on this box behind Cloudflare.

### Turn-taking — 4/10
- **Problem.** The agent did 76% of the talking (3.22:1); leads answered in a
  median of 3 words.
- **Root cause.** No length discipline and no one-question rule in the prompt.
- **Fix.** 5–15 word turns, first sentence under 8 words, exactly one question,
  acknowledge before asking, never volunteer what was not asked.
- **Expected gain.** Large — and it is simultaneously the biggest latency win,
  because nothing is spoken until the first sentence is complete.
- **Difficulty.** Low. Verify with `npm run voice:stats`, not by reading the prompt.

### Barge-in — 3/10 → fixed
- **Problem.** The interrupt could not fire until Sarvam emitted a *final*
  transcript, which needs 300 ms of silence after the lead stops. Speak for two
  seconds and the AI talked over you for 2.3 s.
- **Root cause.** `vad.speech_start` was received and explicitly discarded.
- **Fix.** Two-stage barge-in: hold audio on speech onset, commit on the first
  substantive partial, resume intact if it was noise or a backchannel.
- **Expected gain.** Large. This is the defect most responsible for "it sounds
  like a bot".
- **Difficulty.** Medium, and done. Revert with `VOICE_AGENT_BARGE_IN=final-only`.

### Interruption handling — 5/10 → improved
- **Problem.** Detection was the weak half; recovery was already good.
- **Defect found while fixing it.** After `clearAudio`, audio for the cancelled
  sentence kept streaming, so the AI resumed talking over the lead. All
  playback now passes through one gate with a discard window.
- **Difficulty.** Medium, and done.

### Context retention — 5/10 → improved
- **Problem.** Strong within a call, nothing across calls. Previous summaries
  and outcomes were stored and never used, so the agent re-asked answered
  questions.
- **Fix.** The last three calls' outcome and summary are preloaded, and each
  call now stores structured facts (`Call.aiStructured`) rather than prose alone.
- **Difficulty.** Low; it reuses a query that already ran.

### Sales conversation — 4/10 → improved
- **Problem.** No discovery structure. One 40-word turn opened by announcing
  the lead had no quotation on file — information nobody asked for.
- **Fix.** The prompt is built around greeting → permission → discovery →
  qualification → recommendation → objection → next step. See
  `VOICE_CONVERSATION_DESIGN.md`.
- **Difficulty.** Low to write; it needs real calls to judge.

### Objection handling — 2/10 → improved
- **Problem.** Entirely absent from prompt and code.
- **Fix.** Seven common objections with a response shape for each, and a rule
  never to counter with a discount.
- **Difficulty.** Low.

### Product accuracy — 2/10 → unblocked, not yet solved
- **Problem.** The live catalogue is **one row**: Enriched Vermicompost, 25 kg,
  MRP 0, description null. `Product` had no dosage, crop-suitability or
  nutrient column at all, and `get_product_info` matched names in English only,
  so "কেঁচো সার" found nothing.
- **Root cause.** A data gap, not a code gap. The guardrails correctly stopped
  the agent inventing anything — there was simply nothing to say.
- **Fix.** Eight nullable agronomy columns, an admin section to fill them,
  Bengali/Hindi synonyms in the lookup, and a "not in the catalogue" signal
  distinct from "price unset".
- **Still open.** **The data itself.** Nothing agronomic was authored by me. A
  blank field makes the agent offer to confirm and call back, which is correct
  but is not a substitute for a real catalogue. **This remains the hardest
  limit on sales quality.**
- **Difficulty.** Code done; the data needs Urvar's agronomist.

### CRM integration — 7/10
- **Problem.** Already solid. Tools, outcome, follow-up and activity writes all
  work.
- **Fix applied anyway.** An outcome and follow-up are now recorded when the
  model never calls `end_call` — which was 9 of 20 real conversations,
  including a 122-second call where the lead confirmed interest and no rep was
  ever tasked to follow up.

### Error recovery — 6/10 → improved
- **Problem.** The holding line, TTS reconnect and wrap-up guards were good, but
  the agent completion had **no timeout**, inheriting the SDK's 10-minute
  default. A stalled provider is indistinguishable from a dead line.
- **Fix.** A 6 s timeout with one retry; stalls are counted in telemetry.
- **Also fixed.** A summariser failure used to discard the transcript with it —
  the only copy.

### Overall experience — 4/10 at audit
The pipeline was sound and the conversation was not. The three things that most
made it feel like a machine — being unable to interrupt it, being talked at in
19-word paragraphs, and it having nothing concrete to say about the product —
are addressed in code, prompt and data model respectively, with only the data
itself still requiring work outside the codebase.

## Known remaining issues

- **Eval, gpt-5.4:** called `mark_do_not_call` on a merely annoyed customer. A
  prompt guard was added; re-test to confirm.
- **Eval, sarvam-105b:** still misses `end_call` on a clear closing cue. The
  server-side wrap-up and the outcome guard cover the consequences, so it
  degrades gracefully.
- **Mid-call language switching.** The prompt tells the model to switch
  language; the TTS voice is fixed at connect, so a Hindi reply gets Hindi text
  in a Bengali voice. **Deliberately unresolved pending a listening test** —
  see `VOICE_TEST_PLAN.md`.
- **Lead speech in logs.** Existing lines (`[sarvam-stt] FINAL: "…"`,
  `barge stage=B … "…"`) write customer speech into `logs/` on the production
  box. The new telemetry deliberately logs only counts and a language code;
  whether to redact what is already there is an open decision.
- **No answering-machine detection.** Voicemail burns a full AI call and leaves
  a junk CRM row.
