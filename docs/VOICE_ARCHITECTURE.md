# Voice Architecture

How an AI call actually works at Urvar, what it costs in latency, and where the
real constraints are. Every number here was measured against the live services
on 2026-09-11, not read off a datasheet.

## Current architecture

```
CRM (Next.js, :3002, PM2 "urvar-crm", crm.urvarindia.com)
│
├─ initiateAiCall            src/app/(dashboard)/calls/ai-voice-actions.ts
│     creates the Call row (callMode: AI_AUTONOMOUS), then
│     plivoClient.calls.create(from, to, answer_url)
│
└─ Plivo POSTs /api/voice/plivo/ai-answer?callId=…
      returns XML: <Speak> consent → <Record recordSession> → <Stream bidirectional>
                                                                    │
                                                                    ▼
Voice agent (:3010, PM2 "urvar-voice-agent", tsx voice-agent/server.ts)
│
├─ Plivo media frames  ──────────────────►  Sarvam STT  (saaras:v3-realtime)
│    linear16 16 kHz, 20 ms                 language_code=auto, mode=codemix
│    inbound track only                     stream_type=fast
│                                           silence_duration_ms=300
│                                              │
│                                    vad.speech_start ──► two-stage barge-in
│                                    transcript.partial ─► commit / abort
│                                    transcript.final  ──► run a turn
│                                              │
├─ runAgentTurn  ──────────────────────────────┘        pipeline/openai-agent.ts
│    provider chosen by llm-provider.ts (sarvam-105b-conversations live,
│    gpt-5.4 alternate), streamed, 7 CRM tools, 4 tool hops max, 200 tokens
│    catalogue + lead facts + recent call history preloaded into the prompt
│              │
│      takeSentences() → MIN_SPEAK_CHARS=24 → toSpeakableText()
│              ▼
├─ Sarvam TTS (bulbul:v3, speaker "shubh", linear16 16 kHz, preprocessing on,
│    one fixed language per call)
│              │
└─ routeTtsChunk() ──► playAudio ──► Plivo ──► the caller
     the audio gate: open / holding / discarding
```

Supporting paths:

| Route | Purpose |
|---|---|
| `api/voice/plivo/ai-answer` | answer webhook for autonomous calls; returns the XML above |
| `api/voice/plivo/answer` | browser-SDK path for human and AI-assisted calls |
| `api/voice/plivo/status` | hangup and dial-status callbacks |
| `api/voice/plivo/recording` | recording completion; downloads to local disk |
| `api/voice/plivo/transfer` | live handoff to a rep's SIP endpoint, 30 s timeout |
| `/assist/{callId}` WS | live transcript and suggestions for the rep's browser panel |

## The latency budget

Per turn, from the moment the lead stops speaking to the moment they hear a reply:

| Stage | Measured | Whose cost |
|---|---|---|
| STT endpointing (`silence_duration_ms`) | **300 ms** every turn | our config |
| Lead audio, Plivo → Cloudflare → box | ~70–150 ms one way | network |
| LLM time to first token | **393–472 ms** (sarvam-105b, live, real prompt and tools) | provider |
| First token → first *speakable* sentence | **+400–590 ms** | **our chunking rule** |
| TTS text → first audio byte | **~230 ms** | provider |
| AI audio, box → Cloudflare → Plivo | ~70–150 ms one way | network |
| **Normal turn** | **≈ 1.5–1.8 s** | |
| **Price turn, before the catalogue preload** | **≈ 2.5–3 s** | |

## Where the real constraints are

**1. Our own sentence rule, ~470 ms.** Nothing is spoken until a complete
sentence of at least 24 characters exists. The model is not slow — we wait for
it to finish a long sentence. The fix is to make it write shorter first
sentences, which is the same change that fixes 19-word turns. Do **not**
re-introduce clause splitting: that was tried, and every fragment got its own
sentence-final intonation, which is what "robotic" meant.

**2. Tool hops on the critical path.** Measured: asking "দাম কত পড়বে?" returned
a tool call carrying one character of prose, so the caller heard silence
through a DB round trip and a second generation. The catalogue now sits in the
prompt, so price and pack size cost nothing. Keep it that way as the catalogue
grows; beyond roughly 40 products, preload a category rather than the lot.

**3. The audio path runs through a Cloudflare Tunnel.** `voice.urvarindia.com`
is an ingress on the same tunnel that serves the CRM website, so every media
frame in both directions crosses Cloudflare's edge and this machine's uplink.
A warm hairpin probe measured 143–167 ms round trip with repeated spikes to
974 ms, 1.7 s, 2.3 s and 6.4 s. Cloudflare Tunnel is an HTTP product with no
real-time QoS, and it is the jitter rather than the mean that makes playback
choppy.

Those were HTTP probes, not real Plivo traffic, so the agent now measures the
real thing per call: `frameGapP50/P90/Max`, `longGaps` (inbound gaps over
500 ms) and `clearAckP50`. **Decision rule:** if p90 inter-arrival jitter goes
past ~200 ms, or gaps over 500 ms appear on more than ~5% of calls, the
transport is the problem. Try a dedicated cloudflared service for
`voice.urvarindia.com` first — cheap, and it mirrors the per-app pattern
already on this box — before considering moving the agent to a VM near Plivo's
India region, which is a far larger change because Postgres lives here.

## What is *not* a constraint

- **The Sarvam network leg.** 48–50 ms ping, stable, ~52 ms warm TTFB, no
  jitter. Provider latency is genuine model time, not the network.
- **TTS buffering.** First audio is ~230 ms, and an immediate `flush` after the
  text makes no measurable difference (222/220/244 ms without, 228/238 ms
  with). Sarvam synthesises as soon as it has a complete sentence. Recorded as
  a dead end so it is not tried again.
- **Provider choice, on speed.** sarvam-105b reaches first token roughly 2–3×
  faster than gpt-5.4 in every measurement taken. The open question about it is
  reliability, not latency.

## Hard limits worth knowing before promising anything

- **`bulbul:v3` has no SSML and no phoneme control**, and no pitch or loudness.
  A "pronunciation dictionary" can only ever be orthographic respelling of the
  text we send — see `pipeline/voice-output.ts`.
- **No per-utterance pause control.** Pacing comes from `pace` plus punctuation.
- **Sub-800 ms end to end is not reachable** while media terminates on this box
  behind Cloudflare. A realistic target after the fixes above is ~0.9–1.2 s for
  a normal turn.

## Reading the telemetry

```bash
npm run voice:latency                    # p50/p90 per stage, barge-in outcomes, transport health
npm run voice:stats                      # how the agent talks, from stored transcripts
npm run voice:stats -- 2026-09-12        # narrowed to calls since a date
grep -c 'stage=B via=partial' logs/voice-agent-out*.log   # barge-ins that beat the final transcript
grep -c 'stage=B via=final'   logs/voice-agent-out*.log   # barge-ins that fell back to the old path
grep -c 'stage=abort'         logs/voice-agent-out*.log   # false alarms, resumed intact
```

## Deploying a change

```bash
npm run lint && npx tsc --noEmit && npm run eval:agent
pm2 restart urvar-voice-agent     # drops any call in progress — do it when the line is quiet
```

The Next.js app only needs rebuilding for CRM-side changes
(`npm run build && pm2 restart urvar-crm`). Schema changes follow the manual
migration rule in `CLAUDE.md`: this database is production.
