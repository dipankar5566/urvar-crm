# Voice Test Plan

What is tested automatically, what can only be tested by listening, and what is
still untested and known to be so.

## The three checks, and what each is for

```bash
npm run eval:agent     # does the agent decide correctly? 21 scenarios, 3 languages
npm run voice:stats    # does it talk like a person? measured from real transcripts
npm run voice:latency  # is it fast enough? measured from real calls
```

None of them replaces putting a phone to your ear. They exist so that the
things which *can* be measured are not argued about.

## 1 · Scripted scenarios — `npm run eval:agent`

Replays multi-turn conversations through the real system prompt and the real
tool schemas. **Tool execution is stubbed**, so it can never touch a live lead.
Both providers run the same scripts, because a pass rate means nothing without
the incumbent's number beside it.

Current coverage: **21 scenarios — 10 Bengali, 6 Hindi, 5 English.**

Baseline as of 2026-09-12, after the prompt rework:

| Provider | Checks | Stalls | Median TTFT |
|---|---|---|---|
| gpt-5.4 | 70/71 | 0 | 1801 ms |
| sarvam-105b-conversations | 70/71 | 0 | 941 ms |

The two remaining misses are recorded rather than tuned away: gpt-5.4 called
`mark_do_not_call` on a merely annoyed customer (a prompt guard has since been
added — re-run to confirm), and sarvam still skips `end_call` on a clear
closing cue, which the server-side wrap-up covers.

### What the scenarios cover

| Category | BN | HI | EN |
|---|---|---|---|
| Cooperative buyer, full qualification | ✓ | ✓ | |
| Price question, product in the catalogue | ✓ | ✓ | |
| Price question with no price on file | ✓ | | |
| Price question is *not* a buying signal | ✓ | ✓ | |
| Wants to order now / dealership / price list | ✓ | ✓ | ✓ |
| Asks to speak to a person | ✓ | | |
| Explicit do-not-call | ✓ | ✓ | |
| Not interested, but no opt-out | ✓ | | |
| Angry customer (must not blacklist) | ✓ | | |
| Impatient customer | | ✓ | |
| Confused customer | | | ✓ |
| Backchannel repetition trap | ✓ | | |
| Price objection | ✓ | | |
| Product objection, no yield promises | | | ✓ |
| Callback request | | ✓ | |
| Unrelated / off-catalogue question | | | ✓ |
| Switches language mid-call | | | ✓ |

### Gaps, stated plainly

The brief asked for 20+ scenarios **per language**; this is 21 in total. The
structure now supports the rest — each scenario carries its own `language` and
the prompt is built per language — so adding them is data entry rather than
engineering. The highest-value missing cases, in order:

1. Silent customer (answers, then says nothing) — needs a turn shape the
   harness doesn't model, since silence is the *absence* of a transcript.
2. Customer speaks very fast, or with background noise — **cannot be tested
   here at all.** This harness replays text; audio quality is an STT property.
   Test it on real calls.
3. Angry and impatient variants in Hindi and English.
4. Wrong-product assumption ("I want urea") in all three languages.
5. Topic changes mid-qualification.

### Adding a scenario

Append to `SCENARIOS` in `voice-agent/scripts/eval-agent.ts` with a `language`
and one or more turns. Each turn may assert:

- `mustCall` — the tool expected on this turn
- `mustNotCall` — tools that would be wrong here
- `mustNotSay` — a regex the spoken reply must not match

Write the `why` for a reader who wasn't there. Every assertion in that file
exists because something went wrong on a real call or in a real eval run.

`EVAL_REPORT=report.json npm run eval:agent` writes a machine-readable report,
and the run exits non-zero on any failed check so it can gate a deploy.
Provider stalls are counted separately and do **not** fail the run — a timeout
means the provider was unreachable, not that the agent misbehaved.

## 2 · How it talks — `npm run voice:stats`

Reads stored transcripts and reports turn length, question stacking, repetition
and the talk ratio. Run it before and after any prompt change; "it sounds
better" is not evidence.

Baseline, 2026-09-11, across 18 calls and 103 AI turns:

| Metric | Baseline | Target |
|---|---|---|
| AI turn median | 19 words | ≤ 15 |
| Turns over 15 words | 70% | under 35% |
| Turns with 2+ questions | 16 | ~0 |
| AI : lead word ratio | 3.22 : 1 | ≤ 1.5 : 1 |

Narrow to calls since a change: `npm run voice:stats -- 2026-09-12`.

## 3 · Latency — `npm run voice:latency`

Summarises the `[turn]` and `[call-metrics]` log lines into p50/p90 per stage,
plus barge-in outcomes and audio-transport health. Report medians and p90,
never best cases.

Targets: normal turn ~0.9–1.2 s, price turn ~1.3 s. Sub-800 ms is not
achievable while media terminates on this box behind Cloudflare — see
`VOICE_ARCHITECTURE.md`.

## 4 · Manual tests that nothing automated can replace

### Barge-in — do this before trusting the release

Call a team phone and interrupt the AI at roughly **20%, 50% and 80%** through
one of its sentences. From the recording, confirm it stops within a fraction of
a second and answers what you actually said, rather than finishing its line.

Then confirm the opposite: say "আচ্ছা" while it is mid-sentence and confirm it
**does not** stop. A false barge-in that truncates the agent is the failure
this design is most at risk of, and it is why the abort path exists.

Read the verdict off the logs:

```bash
grep -c 'stage=B via=partial' logs/voice-agent-out*.log   # beat the final transcript — the win
grep -c 'stage=B via=final'   logs/voice-agent-out*.log   # fell back to the old behaviour
grep -c 'stage=abort'         logs/voice-agent-out*.log   # false alarms, resumed intact
```

If `stage=abort` dominates, VAD is over-triggering — most likely speakerphone
echo. The fix is a guard against opening a hold just after our own audio
started, not a threshold tweak.

### The language-switch call — currently an open question

Make one deliberate call where the lead answers in a different language from
the one the call opened in. **Listen to the recording.** The prompt tells the
model to switch; the TTS voice is fixed for the whole call, so Hindi text will
be read by a Bengali voice.

Then decide, on what you heard:

- If it sounds acceptable → fix the prompt so the agent stays in the opening
  language and only borrows vocabulary, which is how most Indian reps talk.
- If it sounds wrong → rebuild the TTS socket with the new language once a
  switch is confirmed over two or more utterances, accepting a short gap.

Do not change code before that recording exists.

### Voice selection

`npm run tts:samples` renders the same line across speakers, pace and
preprocessing settings into `storage/voice-samples/`. To choose a voice
properly, extend it to a realistic 2–5 minute script and have a native Bengali
and a native Hindi speaker rate warmth, authority, pacing and fatigue. A voice
that charms in a ten-second clip can grate over four minutes — which is the
whole reason for the long script.

## 5 · Known untested

- Hindi and English on real calls. All 18 stored transcripts are
  Bengali-dominant.
- Behaviour in genuine field noise — tractors, wind, a second person talking.
- Any product conversation with real agronomy data, because there isn't any yet.
- Sarvam's rate limits at higher call volume; the account is still on a free
  trial.
