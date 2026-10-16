// What a journey costs the person who walks it (CHE-235).
//
// Two numbers per journey, both stated from the USER's side and nobody else's:
//
//   price      — how many actions the person performs to get the thing done.
//   conversion — of 100 people who start it, how many finish.
//
// They are opinionated on purpose. A journey that takes eleven actions is worse
// than one that takes four, whatever the code looks like, and saying so is the
// product: "this is expensive for your user" is a sentence only an outside
// observer can say, and we are the outside observer.
//
// The guide below is the whole contract. It is the same text as
// .claude/skills/journey-metrics/SKILL.md (scripts/verify-journey-metrics.ts
// fails if they drift), so the rules a coding agent reads and the rules our own
// model is handed are one document, not two that agree for a while.
//
// This module is pure: the guide, the shapes, and the rules that police what
// comes back. Nothing here reads the database or calls a model.

/** A journey's two numbers as one value, plus the sentence that justifies them. */
export interface JourneyMetric {
  /** Actions the user performs. 0 means "nothing to do" and is almost always wrong. */
  price: number;
  /** Of 100 people who start, how many finish. 0-100. */
  conversion: number;
  /** Why it is what it is, or what changed since the last check. One sentence. */
  note: string;
}

/**
 * What the model may not exceed, so one bad answer cannot poison a chart.
 *
 * `maxPrice` is the last resort, for a journey we have never walked. It is not
 * the working bound — see `priceCeiling` — because a constant this far from any
 * real value cannot catch a wrong one. Set at 200, it let a live verdict page
 * say "100 actions to finish" about a three-click flow for two days (CHE-282),
 * while passing every check, because a guard wide enough never to fire is
 * indistinguishable from no guard at all.
 */
export const METRIC_BOUNDS = { maxPrice: 200, maxConversion: 100 } as const;

/**
 * How many of a user's actions one recorded step may plausibly hold.
 *
 * A step can carry several — filling three fields is three actions in one step
 * — so this is deliberately generous. Chosen from production rather than taste:
 * across every priced journey, price divided by steps-per-walk ran from 0.13 to
 * 1.7, and the one absurd value sat at 20. Four leaves every real number a wide
 * margin and still refuses the absurd one by a factor of five.
 */
export const ACTIONS_PER_STEP = 4;

/** Below this many steps of history, the ceiling stops shrinking: a journey
 *  walked once, briefly, is not evidence that it is cheap. */
export const MIN_PRICE_CEILING = 12;

/**
 * The most a journey can plausibly cost, given what its walks recorded.
 *
 * The point is that the number becomes answerable to something observed. `price`
 * is a model judgement — the prompt asks for a user's actions on the shortest
 * path, explicitly excluding our own detours — so nothing in it is counted, and
 * until now nothing could contradict it. A journey whose walks record five steps
 * does not cost a hundred user actions, and that is checkable without knowing
 * anything about the product.
 *
 * `steps` is null for a journey we have never walked: there is nothing to be
 * answerable to yet, and the blunt constant stands for one run.
 */
export function priceCeiling(steps: number | null): number {
  if (steps === null || steps <= 0) return METRIC_BOUNDS.maxPrice;
  return Math.max(MIN_PRICE_CEILING, Math.ceil(steps * ACTIONS_PER_STEP));
}

/** A note shorter than this says nothing; the value it defends is not accepted. */
export const MIN_NOTE_CHARS = 12;

/**
 * The cheapest a journey can be. A journey is something a person DOES, so it
 * costs at least the one action that starts it; a price of zero is not a cheap
 * journey, it is a model that did not answer.
 *
 * This is not a guess about phrasing. Run #192 (checkmyapp.dev, 2026-09-14,
 * the first production run after the metric shipped) priced all four of its
 * journeys at 0 actions and 0% conversion, each with a note explaining that the
 * number was "not tracked — no event labels in UI": the discovery model read
 * "price" and "conversion" as analytics it was being asked to look up, and
 * having found no funnel events, reported their absence as the measurement.
 * Stored, that reads as "every journey in this app is free and nobody
 * completes it" — a sentence about the customer's product that our own model
 * never meant to say, which is rule 8: a claim contaminated by our incapacity
 * is not a finding, it is a ticket on our board.
 */
export const MIN_PRICE = 1;

// ─── The guide ───────────────────────────────────────────────────────────────
// Rendered into the discovery prompt verbatim and published as the skill.

export const JOURNEY_METRICS_GUIDE = `# Pricing a journey

Every journey carries two numbers, and both are stated from the user's side —
not the product's, not the implementation's, and never ours.

- **price** — how many actions the person performs to get the thing done.
- **conversion** — of 100 people who set out to do this, how many finish it.

Both are opinions. That is the point: "signing up costs your user eleven
actions" is a judgement about someone's product that only an outside observer
makes, and it is worth more than another green check mark.

**Neither is analytics.** You are not looking these up, and there is nothing to
look them up in: no funnel events, no dashboard, no labels in the UI. You count
what you watched a person have to do, and you judge how many would finish. So
"not tracked" is never an answer here, and neither is 0 actions — a journey is
something a person does, so it costs at least one. If you genuinely cannot tell,
say so in the note and give your best judgement anyway; a number with a doubt
beside it is useful, a zero is a false statement about someone's product.

## Counting the price

One action is one thing the person does. Count on the shortest path the product
actually offers, not the one it could have offered.

Counts as one action each:

- a click or tap that moves the journey forward — a button, a link, a menu item;
- one field filled, however long the value (an email is one, a 400-word bio is
  one);
- one choice made — a dropdown, a radio, a checkbox the flow requires, a date
  picked;
- a file chosen, an image cropped, a permission granted in a browser dialog;
- a confirmation the product demands ("Are you sure?", a cookie wall that blocks
  the page, a "continue" on an interstitial);
- leaving the product and coming back — opening the email for a code, copying it
  in: **two** (the trip out, the value in).

Does not count:

- scrolling, reading, looking, hovering, waiting;
- anything optional that the goal does not require;
- **anything we did as a checker.** Re-navigating to look again, opening a page
  twice to confirm what we saw, our own detours — those are our actions, not the
  user's, and they never reach this number.

If the journey cannot be finished, count the actions up to the point where it
stops and say so in the note. A broken journey must never look cheap — that is
what conversion is for.

## Judging the conversion

Of 100 people who **set out to do this**, how many finish.

The denominator is intent, not arrival. Someone who lands on the first page of
the flow with no interest in the outcome is not in this hundred. That is NOT the
denominator a funnel in an analytics tool uses — that one counts everyone who
touched the first page — so the two numbers will differ, often by a lot, and the
difference is not a mistake by either of them. Measured side by side on our own
product (CHE-244, 2026-09-18), this estimate stood at 90, 80 and 65 on the three
journeys where both numbers existed, where the counted paths gave 33, 12 and 36
on samples of 3, 25 and 14 people. Do not move this number towards theirs. They
are answers to different questions, and the honest report is both numbers side
by side, each labelled.

Anchors, and pick the nearest:

| conversion | what it looks like |
|-----------|--------------------|
| 95-100 | one obvious action, nothing to type, nothing to wait for |
| 80-94 | short and familiar: sign in, a 2-3 field form, clear errors |
| 60-79 | a real form (5+ fields), or one confusing moment a person recovers from |
| 40-59 | the journey leaves the product (email code, an app to install), or makes the user wait with no explanation |
| 20-39 | a dead end with a workaround only a determined person finds; several confusing steps in a row |
| 1-19 | needs something the user does not have to hand — an API key, an ID from somewhere else, a second device |
| 0 | cannot be finished at all: it is blocked, broken, or the control does nothing |

Two rules that keep this honest:

- **Price and conversion are not the same number twice.** A long flow people
  still complete (checkout at a shop they trust) is expensive and converts well.
  A one-click flow that fails silently is cheap and converts at zero.
- **Judge the product, not your patience.** "I would not bother" is not a
  measurement. Ask what a person who actually wants this outcome would do.

## Changing a number

A journey that already has these numbers arrives with them. You are not
re-deriving them from scratch — you are answering one question: **did this
journey change since then?**

- Nothing changed in the flow → keep both numbers exactly as they are, and say
  so in the note.
- Something changed → move the number and name the change: "a field was added
  to the form" (price 5 → 6), "the confirmation email is no longer required"
  (price 8 → 6, conversion 55 → 80), "the submit button now does nothing"
  (conversion 70 → 0).
- **A number that moves without a named change is a defect.** Nothing accepts a
  new value whose note does not say what changed — the previous number stands.

The first time a journey is seen there is nothing to compare with: assign both
numbers and let the note say what the flow is, in one sentence.

## Worked examples

**"Sign up for an account" — price 6, conversion 65.**
Open the sign-up page (1), fill email (2), fill password (3), confirm password
(4), accept the terms checkbox (5), submit (6). Conversion 65: five fields and a
password rule that is only shown after the first failed submit.

**"Sign up for an account", the next check — price 8, conversion 45.**
Two fields were added (first name, last name) and the account is not usable until
a code from the email is entered — the trip to the mailbox and back is two more
actions. Note: "two fields added and an email code is now required."

**"Read the pricing page" — price 1, conversion 100.**
Click "Pricing" in the navigation. Nothing to fill, nothing to wait for.

**"Practice an interview with the AI coach" — price 4, conversion 0.**
Open Practice (1), choose a role (2), choose a question set (3), press Start (4).
It converts at zero this check: pressing Start leaves the page on a spinner and
no session ever begins. Price stays 4 — the actions the person performs before
it fails are still four, and pretending the journey got cheaper because it broke
would be the wrong number in the wrong direction.

**"Invite a teammate" — price 5, conversion 25.**
Open Settings (1), open Members (2), press Invite (3), type the address (4), send
(5). Conversion 25: the invite form asks for a "workspace role ID" it never
explains and rejects anything else.`;

// ─── Rules the answer has to pass ────────────────────────────────────────────

/** What a model returned for one journey, before anything trusts it. */
export interface RawMetric {
  price?: unknown;
  conversion?: unknown;
  note?: unknown;
  /**
   * True when the numbers come from a script we wrote for a journey, not from
   * a model that watched it. They may only open a journey that has no price —
   * once one is stored, only a walk that names a change may move it.
   */
  seedOnly?: boolean;
}

export interface MetricDecision {
  /** The value to store, or null to store nothing at all. */
  value: JourneyMetric | null;
  /** What happened, for the log. Never customer-facing. */
  reason: string;
  /** True when the previous value was kept instead of the proposed one. */
  kept: boolean;
  /**
   * True when the model returned a number no journey can have, so this run
   * priced nothing. Our defect, not the app's — the caller files it (rule 2).
   */
  unpriced?: boolean;
  /**
   * True when the STORED value fails the same test the proposed one failed, so
   * it must be removed rather than kept. A wrong number that nothing can
   * dislodge outlives every run that refuses to replace it (CHE-282).
   */
  clears?: boolean;
}

/**
 * Decide what to store for one journey, given what the model said and what the
 * catalog already held. The rules are the guide's, enforced rather than asked:
 *
 *   - out-of-range numbers are clamped, not rejected: a model that says 140%
 *     means "everybody", and losing the whole answer over it helps nobody;
 *   - a CHANGED number with no real note is refused, and the previous value
 *     stands — this is the one rule that keeps the metric from drifting a few
 *     points every run and looking like a trend;
 *   - a first value needs a note too, but any real sentence will do: there is
 *     nothing to drift from yet.
 */
export function decideMetric(
  raw: RawMetric | null | undefined,
  previous: JourneyMetric | null,
  /** Steps a typical past walk of this journey recorded. Null = never walked. */
  walkedSteps: number | null = null,
): MetricDecision {
  const ceiling = priceCeiling(walkedSteps);
  const price = clamp(toInt(raw?.price), 0, METRIC_BOUNDS.maxPrice);
  const conversion = clamp(toInt(raw?.conversion), 0, METRIC_BOUNDS.maxConversion);
  const note = typeof raw?.note === "string" ? raw.note.trim() : "";

  if (price === null || conversion === null) {
    return {
      value: previous,
      reason: previous ? "no numbers this run — the stored ones stand" : "no numbers this run",
      kept: Boolean(previous),
    };
  }

  // An impossible price is a non-answer wearing a number. Refused the same way
  // a missing one is: the stored value stands, and nothing is written when
  // there is none — a journey with no price says "we have not priced this yet",
  // which is true, where a stored 0 says something false about their product.
  if (price < MIN_PRICE) {
    return {
      value: previous,
      reason: previous
        ? `refused ${price} actions — a journey costs at least ${MIN_PRICE}; the stored ${previous.price} stands`
        : `refused ${price} actions — a journey costs at least ${MIN_PRICE}`,
      kept: Boolean(previous),
      unpriced: true,
    };
  }

  // A price the walks cannot support (CHE-282). Refused like an impossible one
  // — but the STORED value is checked against the same ceiling, because keeping
  // an unsupportable number is how the live "100 actions to finish" survived
  // every later run: each one refused a new value and left the old one standing.
  if (price > ceiling) {
    const storedAlsoUnsupportable = previous !== null && previous.price > ceiling;
    return {
      value: storedAlsoUnsupportable ? null : previous,
      reason: storedAlsoUnsupportable
        ? `refused ${price} actions — its walks record about ${walkedSteps} steps, so at most ${ceiling}; the stored ${previous.price} fails the same test and is cleared`
        : `refused ${price} actions — its walks record about ${walkedSteps} steps, so at most ${ceiling}`,
      kept: Boolean(previous) && !storedAlsoUnsupportable,
      unpriced: true,
      clears: storedAlsoUnsupportable,
    };
  }

  const changed =
    !previous || previous.price !== price || previous.conversion !== conversion;
  if (changed && note.length < MIN_NOTE_CHARS) {
    if (previous) {
      return {
        value: previous,
        reason: `refused ${previous.price}→${price} / ${previous.conversion}→${conversion}: no change was named`,
        kept: true,
      };
    }
    // Nothing to keep. A first value with no explanation is still the only
    // value we have, and refusing it would leave the journey unpriced forever.
    return {
      value: { price, conversion, note: note || "first measurement" },
      reason: "first value, taken without an explanation",
      kept: false,
    };
  }

  return {
    value: { price, conversion, note: note || previous?.note || "unchanged" },
    reason: changed ? `${describe(previous)}${price}/${conversion}` : "unchanged",
    kept: false,
  };
}

function describe(previous: JourneyMetric | null): string {
  return previous ? `${previous.price}/${previous.conversion} → ` : "first value ";
}

/**
 * The line that tells the model what this journey cost last time. Empty when
 * the journey has no numbers yet — the guide covers that case on its own.
 */
export function metricLine(metric: JourneyMetric | null): string {
  if (!metric) return "not measured yet";
  return `price ${metric.price}, conversion ${metric.conversion}${metric.note ? ` (${metric.note})` : ""}`;
}

function toInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function clamp(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return Math.min(max, Math.max(min, value));
}
