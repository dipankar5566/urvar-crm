# Voice Conversation Design

The shape of a call: how it should progress, what to do when it doesn't, and
when to stop selling and fetch a human.

## Why there is no state machine

The brief asked for an explicit conversation state machine. There isn't one,
deliberately.

A hard finite-state machine wrapped around an LLM breaks on a live call the
moment the customer jumps ahead — and they routinely do. A farmer who answers
"আমার ২০ বিঘা আলু, দাম কত?" has just skipped discovery, qualification and
recommendation in one breath. An FSM either refuses to follow (and sounds deaf)
or needs a transition for every pair of states (and stops being a machine worth
having).

What §23 actually wants — the agent knowing where it is and not jumping about
randomly — is delivered by giving the model the sequence as an ordered list
plus one instruction: *follow them if they jump ahead*. That sequence is in the
system prompt.

If this proves insufficient once real calls are measured, the next step is a
phase field on the session injected as a single line ("you are in discovery;
you still need crop and acreage"), recorded per turn in telemetry so we can see
where calls stall. That is a small change and can be added on evidence. It has
not been added on speculation.

## The sequence

**1 · Greeting.** Who you are, where you're calling from, and is now a good
time. First sentence under 8 words.

> "নমস্কার, Urvar থেকে বলছি। এখন কথা বলা যাবে?"

**2 · Permission.** If they're busy, get a time and let them go. Do not push
past a "no" here — it is the cheapest callback you will ever book.

> "ঠিক আছে। কখন ফোন করলে সুবিধা হবে?"

**3 · Discovery.** One fact per turn: what they grow, how much land, what they
use now. Acknowledge each answer before asking the next.

**4 · Qualification.** Quantity, timeline, current supplier, who decides.

**5 · Recommendation.** Only once the need is known, and only a product from
the preloaded catalogue. If the relevant field is blank, say you'll confirm —
do not fill the gap.

**6 · Objection handling.** See below. Never counter with a discount.

**7 · Next step.** Never end without one: a callback, a quotation, or a person
who will call. `end_call` records the outcome; if the model forgets, the server
records `CONNECTED` and raises a follow-up anyway.

## What the lead already told us

The last three calls' outcome and summary are preloaded into the prompt,
alongside the lead's stored facts, and the agent is explicitly told not to
re-ask anything they already answer. Nothing is more obviously a machine than
asking a man his acreage for the third time.

Each call also writes structured facts to `Call.aiStructured` — crop, acreage,
quantity, objections, purchase intent, next action — so the next call works
from conclusions rather than prose.

## Objection handling

The principle: an objection is a question about value, not a signal to
discount. Ask before you answer.

| Objection | Response shape |
|---|---|
| দাম বেশি / too expensive | Ask what they're comparing it against, then compare on real figures. Never open with a discount. |
| আগে ব্যবহার করিনি / never used it | Suggest a small trial quantity. Only offer a trial if the business actually supports one. |
| অন্য কোম্পানির product ব্যবহার করি | Ask which one, and how it has worked for them. Their answer is the qualification. |
| পরে নেব / I'll take it later | Ask roughly when suits them, then book it. "Later" without a date is a lost lead. |
| কাজ করবে তো? / will it work | Describe what it does. **Never promise a yield number.** |
| Dealer margin | Say the team will confirm, and book a callback. Margins are not the AI's to quote. |
| Delivery / credit terms | The same — confirm and hand over. |

## Handing over to a person

**Triggers.** They want to place an order, they name a quantity they intend to
buy now, they ask about dealership, or they ask to speak to someone.

**Explicitly not a trigger:** asking the price. A price question is a question.
Transferring on it would burn a rep on every enquiry — there is an eval
scenario guarding this, because the model got it wrong once already.

**What happens.** `transfer_to_human` dials the lead's assigned rep on their
SIP endpoint with a 30-second timeout. If nobody answers, the route apologises,
creates a HIGH-priority follow-up due within the hour, and marks the call
`TRANSFERRED_TO_HUMAN`.

**The rule that matters.** The agent must not say it is connecting anyone until
the transfer has actually been made. On 2026-09-10 it told a lead "connecting
you to our representative now, stay on the line" and nothing happened; the
capability was withdrawn for a day as a result. Say something neutral, call the
tool, and let the outcome speak.

`AI_TRANSFER_ENABLED=false` withdraws the capability again without a deploy;
the model is told to fall back to booking a callback.

## Ending the call

End when the lead has nothing further — they've said goodbye, confirmed they're
done, or clearly said they're not interested.

**Never end on the same turn the lead states a requirement, quantity, crop or
delivery need.** That is a buying signal, not a goodbye.

Three server-side guards run regardless of what the model does: 15 seconds of
silence wraps up, five minutes is a hard cap, and any call ending without an
outcome gets `CONNECTED` plus a follow-up task. They exist because `end_call`
compliance is unreliable on both providers — 9 of 20 real conversations ended
without one.

## Not interested is not do-not-call

`mark_do_not_call` is for an explicit request only. Someone abrupt, annoyed or
merely uninterested stays on the list — apologise, offer a better time, move
on. gpt-5.4 got this wrong in evaluation, which is why the prompt now says so
in as many words and a scenario guards it.
