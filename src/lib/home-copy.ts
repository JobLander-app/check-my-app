// Every sentence on the home page, in one pure module (CHE-421).
//
// Owner, 2026-10-06: the page used to be a form with a slogan and eight lines
// of small grey caveats — it explained our mechanics and asked the visitor to
// try before it said anything about them. It now says what the visitor is
// afraid of and what they get. Nothing here describes how we check — the
// verdict is the product and our machinery is invisible (CLAUDE.md §1).
//
// Positioning (owner, 2026-10-06, second pass — the first spoke Shopify:
// «херня, а не сообщения… почему выскакивает store? shopify apps ещё не
// готовы»): CheckMyApp is the QA a small team shipping a web app does not
// have. It uses the app the way a new user would — once, after a release,
// every day — and says what's broken, where, and how to know it's fixed, with
// no tests to write. The pains are the research's (Notion «Shopify app devs —
// исследование рынка», 2026-10-01) with the Shopify-only ones taken out: the
// biggest pain there, App Review, needs a check inside a store's admin, which
// the product does not do for customers yet. Until it does, no word of that
// world is on this page (scripts/verify-home-copy.ts refuses them).
//
// Pure on purpose: no React, no imports with side effects, so
// scripts/verify-home-copy.ts can run every string through the leak gates in
// src/lib/verdict-language.ts, and scripts/verify-public-copy.ts reads it as a
// customer-facing source. A sentence that is not in this file is not on the
// page.

export type HeroVariant = { key: "new-user" | "no-qa" | "before-users"; pain: string; headline: string; line: string };

// Three first screens for the owner to compare (A/B is the mental model).
// Each opens on one of the pains below — `pain` names which — and all three
// say the same promise in the line under it.
export const HERO_VARIANTS: readonly HeroVariant[] = [
  {
    key: "new-user",
    pain: "It works for me",
    headline: "Your app works for you. Does it work for a new user?",
    line:
      "CheckMyApp uses your app the way someone who just found it would, and tells you what's broken, where, and how to know it's fixed. No tests to write.",
  },
  {
    key: "no-qa",
    pain: "No QA, no time for tests",
    headline: "The QA your team doesn't have.",
    line:
      "Paste a link. CheckMyApp uses your app like a real user and tells you what's broken, where, and how to know it's fixed — no test scripts, no setup.",
  },
  {
    key: "before-users",
    pain: "A user told us first",
    headline: "Find what's broken before your users do.",
    line:
      "CheckMyApp uses your app like a real user — after a release, or every day — and tells you what broke, where, and how to know it's fixed. Nothing to write or maintain.",
  },
];

// The one the page shows. Switched here and nowhere else once the owner has
// compared the three on the preview.
export const HERO: HeroVariant = HERO_VARIANTS[0];

// One sentence by the button: the three things a visitor asks after deciding
// to paste a link, not a wall under it. The counter is appended by the form
// when it knows today's number.
export const FORM_NOTE = "Free first run, no signup · anonymous checks are public";

export type Pain = { fear: string; check: string; get: string };

export const PAINS_LABEL = "Where it helps";

// The four pains, each in the words people use for it: what they say → what
// the check does → what they get. No feature list. From the research, with
// what is Shopify's alone taken out (see the header):
//   1. "works on my dev store, 404 for the reviewer" (~12 threads) and "the
//      reviewer is a first user who sees an empty store" (~10) → it works for
//      me, not for a newcomer;
//   2. "platform changes silently break apps; merchants notified me" (5+) →
//      a user told us first;
//   3. "automated tests don't work: flaky, sessions, headed mode" (~20) and
//      "QA intern" → no QA, no time for tests;
//   4. "vibe-coded, scared to ship" (the MCP path) → shipping with an agent.
export const PAINS: readonly Pain[] = [
  {
    fear: "“It works for me.”",
    check:
      "You're signed in, your data is there, you know where to click. A new user has none of that. The check opens your app with just its link — and a test login for the signed-in part — and goes where a newcomer would.",
    get: "The empty screen, the 404 and the button that does nothing, found before a new user finds them.",
  },
  {
    fear: "“A user told us it was broken.”",
    check:
      "Every day, and after a release if you connect your CI or your coding agent, your app is checked again. When a page stops answering or something you didn't touch breaks, the finding arrives the same day.",
    get: "You hear it from the check, not from a user.",
  },
  {
    fear: "“We don't have QA, and no time to write tests.”",
    check:
      "There is nothing to write or keep alive. You paste a link; what comes back is a verdict in plain words — what's broken, where, why it matters, and how to know it's fixed.",
    get: "A second pair of eyes on every release, without a test suite that breaks the week you need it.",
  },
  {
    fear: "“I build with a coding agent and ship every day.”",
    check:
      "Connect the agent once. Ask it to check after it ships, and the findings come back into the same chat — what broke, where, how to know it's fixed.",
    get: "Ship, check, fix in one loop, without opening a dashboard.",
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
  // "check #312 · Oct 3 · $0.80" — the page fills the number, the day and the price.
  check: (n: number) => `check #${n}`,
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
    PAINS_LABEL,
    ...PAINS.flatMap((p) => [p.fear, p.check, p.get]),
    PROOF.bottomLine,
    PROOF.finding.title,
    PROOF.finding.where,
    PROOF.finding.happened,
    PROOF.finding.matters,
    ...Object.values(PROOF_COPY).map((v) => (typeof v === "function" ? v(312) : v)),
    WAYS_IN.agent,
    WAYS_IN.agentLink,
    `${WAYS_IN.signInLink} ${WAYS_IN.signInRest(3)}`,
  ];
}
