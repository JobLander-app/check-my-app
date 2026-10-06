// Every sentence on the home page, in one pure module (CHE-421).
//
// Owner, 2026-10-06: the page used to be a form with a slogan and eight lines
// of small grey caveats — it explained our mechanics and asked the visitor to
// try before it said anything about them. It now says what the visitor is
// afraid of and what they get, in the words the audience uses about itself
// (Notion «Shopify app devs — исследование рынка», 2026-10-01: app review,
// rejected, works on my dev store, fresh dev store, 404s, silently break,
// merchants notified me). Nothing here describes how we check — the verdict
// is the product and our machinery is invisible (CLAUDE.md §1).
//
// Pure on purpose: no React, no imports with side effects, so
// scripts/verify-home-copy.ts can run every string through the leak gates in
// src/lib/verdict-language.ts, and scripts/verify-public-copy.ts reads it as a
// customer-facing source. A sentence that is not in this file is not on the
// page.

export type HeroVariant = { key: "reviewer" | "hear-first" | "not-you"; headline: string; line: string };

// Three first screens for the owner to compare (A/B is the mental model). One
// phrase runs through all three — "someone who isn't you" — because every pain
// in the research is that one: the reviewer, the merchant, the first visitor.
export const HERO_VARIANTS: readonly HeroVariant[] = [
  {
    key: "reviewer",
    headline: "The reviewer opens your app on a fresh store. Does it work?",
    line:
      "Before you submit, someone who isn't you walks your app the way the reviewer will — and tells you what breaks, where, and how to know it's fixed.",
  },
  {
    key: "hear-first",
    headline: "Will you hear it broke before your customers do?",
    line:
      "Every day, someone who isn't you opens your app and tries to use it. If something stopped working overnight, you get the finding that morning — what, where, how to know it's gone.",
  },
  {
    key: "not-you",
    headline: "Does your app still work for someone who isn't you?",
    line:
      "Paste a link. Someone who isn't you opens it, signs in, clicks through — and you get a verdict: what's broken, where, and how to know it's fixed.",
  },
];

// The one the page shows. Switched here and nowhere else once the owner has
// compared the three on the preview.
export const HERO: HeroVariant = HERO_VARIANTS[2];

// One sentence by the button: the three things a visitor asks after deciding
// to paste a link, not a wall under it. The counter is appended by the form
// when it knows today's number.
export const FORM_NOTE = "Free first run, no signup · anonymous checks are public";

export type Pain = { fear: string; check: string; get: string };

// The four pains, by thread count in the research, each in the audience's own
// words: the fear → what the check does → what you get. No feature list.
export const PAINS: readonly Pain[] = [
  {
    fear: "“Works on my dev store. 404 for the reviewer.”",
    check:
      "Before you submit, a first-time user opens your app with nothing but the link and the test login you would give the reviewer, and follows your testing instructions to the letter.",
    get: "The 404 and the empty screen, found before the reviewer finds them — and no second round at the back of the queue.",
  },
  {
    fear: "“Will I hear about it before my merchants do?”",
    check:
      "Every day, the same walk through your app. When something you did not touch stops working — a platform change, a dependency, a quiet deploy — you get the finding that morning.",
    get: "The “merchants notified me” message never arrives, because you already knew.",
  },
  {
    fear: "“I'm not fighting captchas and 2FA myself.”",
    check:
      "You paste a link and, if you want the signed-in parts covered, a test login. What comes back is the verdict: broken or not, what, where, how to know it's gone.",
    get: "No scripts to write, no sessions to keep alive, no flaky setup that breaks the week you need it.",
  },
  {
    fear: "“I vibe-coded it. Can I ship it without the fear?”",
    check:
      "Your coding agent connects to the check and runs it on every release. The verdict comes back into the same chat, with the fix for you to decide.",
    get: "Ship, check, fix — without opening a dashboard, and without wondering what the first user will see.",
  },
];

// A real check, copied from the verdict it links to and trimmed only by whole
// sentences. Our own product (joblander.app), so nobody else's finding is on
// our home page. The verdict is the product: the page shows one.
export const PROOF = {
  app: "joblander.app",
  runNumber: 312,
  verdict: "needs_attention",
  priceUsd: 0.8,
  checkedOn: "2026-10-03",
  publicId: "cmusv2ctt0003sa0nrln3804k",
  bottomLine:
    "Your paid checkout is the problem: clicking the advertised “$10 / 100 minutes” pack opens a live Stripe page that defaults to SGD 13.31 with a 4% conversion fee and renders entirely in German during an English session — so buyers either overpay or abandon. Sign-in, the dashboard, practice, settings and all nine localized sites otherwise loaded cleanly.",
  finding: {
    severity: "high",
    title: "Checkout defaults to SGD + 4% fee and German locale during an English session",
    where: "Stripe Checkout opened from the “100 minutes $10” pack on /dashboard",
    happened:
      "The live Stripe Checkout showed the pack at “SGD 13.31” with the note “1 USD = 1.3310 SGD (includes 4% conversion fee)” instead of the advertised $10, and the entire page was in German (back link /de/dashboard, terms /de/purchase-terms, German legal copy) even though the whole session was the English site.",
    matters:
      "A buyer who trusts your “$10” pricing is quietly charged ~33% more unless they spot and flip the currency toggle, and seeing a German page mid-English-flow erodes trust at the exact moment of payment.",
  },
} as const;

// Labels around the proof card.
export const PROOF_COPY = {
  label: "What a verdict looks like",
  intro: "A real check of a real app — ours.",
  open: "Open the verdict →",
  where: "Where",
  happened: "What happened",
  matters: "Why it matters",
} as const;

// The ways in, after the visitor has decided. Dollar figures are filled in by
// the page from PLAN_LIMITS so the number is never typed twice.
export const WAYS_IN = {
  agent: "Prefer your coding agent?",
  agentLink: "Connect it →",
  // Rendered as "<link>Sign in</link> to keep …" — the link is the verb.
  signInLink: "Sign in",
  signInRest: (creditUsd: number) => `to keep your checks unlisted and get $${creditUsd} of free checks.`,
} as const;

// Every customer-visible sentence in this module, flat, for the guard.
export function allHomeSentences(): string[] {
  return [
    ...HERO_VARIANTS.flatMap((v) => [v.headline, v.line]),
    FORM_NOTE,
    ...PAINS.flatMap((p) => [p.fear, p.check, p.get]),
    PROOF.bottomLine,
    PROOF.finding.title,
    PROOF.finding.where,
    PROOF.finding.happened,
    PROOF.finding.matters,
    ...Object.values(PROOF_COPY),
    WAYS_IN.agent,
    WAYS_IN.agentLink,
    `${WAYS_IN.signInLink} ${WAYS_IN.signInRest(3)}`,
  ];
}
