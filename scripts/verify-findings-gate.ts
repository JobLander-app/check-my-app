// CHE-188 verification: a finding that rests only on a skipped step is not
// written. CHE-215 extends it: a finding that says one of OUR interactions
// produced nothing, in a run whose machine trail shows we never drove that
// control, is not written either.
//
// Run #153 (joblander.app) recorded the step "Modify Insight Preferences
// (slider) and Save/Reset" as skipped / our_capability and then wrote the
// finding "Save Changes stays disabled — styling sliders didn't respond" off
// it. The synthesis prompt already forbade that; this script proves the gate
// that now sits between synthesis and persistence does what the prompt only
// asked for.
//
// Run #159 (checkmyapp.dev) is the harder version and gets the whole run as a
// fixture: `fixtures-run-159.json` is its 35 steps and its published finding,
// straight out of production D1. Nothing in that run mentions the accordion or
// a failed fill, and the trail proves it — the two fills it performed were the
// sign-in email box and the URL box.
//
// Pure: no browser, no network, no model, no database. Every case below is the
// exact shape the workflow hands the gate — synthesized findings plus the
// run's journeys with their steps — so what passes here is what runs.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-findings-gate.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXPOSED_NO_EVIDENCE,
  NO_INTERACTION_RECORDED,
  NO_STEP_SUPPORTS,
  claimedHands,
  cutNullEffectClauses,
  cutUndrivenClaims,
  handsInText,
  distinctiveTokens,
  drivenControls,
  gateFindings,
  type GateJourney,
} from "@/agent/findings-gate";
import type { SynthesizedFinding } from "@/agent/synthesis";

const RUN_159: {
  note: string;
  finding: SynthesizedFinding;
  bottomLine: string;
  journeys: Array<GateJourney & { title: string; summary: string }>;
} = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures-run-159.json", import.meta.url)), "utf8"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const titles = (fs: Array<{ title: string }>) => fs.map((f) => f.title).join(" | ") || "(none)";

// ─── Run #153, as recorded ────────────────────────────────────────────────────

const SKIPPED_SLIDER = {
  label: "Modify Insight Preferences (slider) and Save/Reset",
  status: "skipped",
  unverifiedReason: "our_capability",
  observed:
    "The Insight Preferences sliders were not moved; Save Changes stayed disabled and nothing was sent.",
};

const SLIDER_FINDING: SynthesizedFinding = {
  title: "Save Changes stays disabled — styling sliders didn't respond",
  category: "confusing",
  severity: "low",
  detail: {
    where: "/settings — Insight Preferences",
    whatWeTried: ["Tried to move the Insight Preferences sliders to enable Save Changes"],
    whatHappened: "The sliders did not move and Save Changes stayed disabled.",
    whyItMatters: "An owner who cannot change a preference will assume the setting is broken.",
  },
  stepRef: { journeyIndex: 1, stepIndex: 2 },
};

// Two journeys around it so indices are exercised, not just the first slot.
const RUN_153: GateJourney[] = [
  {
    steps: [
      { label: "Open the landing page", status: "ok", unverifiedReason: null, observed: "Landing rendered." },
      { label: "Sign in with the test account", status: "ok", unverifiedReason: null, observed: "Dashboard loaded." },
    ],
  },
  {
    steps: [
      { label: "Open Settings", status: "ok", unverifiedReason: null, observed: "Settings page rendered." },
      {
        label: "Toggle email notifications",
        status: "ok",
        unverifiedReason: null,
        observed: "Toggle flipped and Save Changes enabled.",
      },
      SKIPPED_SLIDER,
    ],
  },
];

function main() {
  // 1 — the #153 shape: stepRef → skipped/our_capability → dropped.
  {
    const r = gateFindings([SLIDER_FINDING], RUN_153);
    check("#153: finding with stepRef to a skipped step is dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "#153: the reason names the skipped step and its unverifiedReason",
      r.dropped[0]?.reason.includes(SKIPPED_SLIDER.label) && r.dropped[0]?.reason.includes("our_capability"),
      r.dropped[0]?.reason,
    );
  }

  // 2 — the same finding, stepRef pointing at a confusing step → kept. The
  // gate is about the step's status, not the finding's wording.
  {
    const journeys: GateJourney[] = [
      RUN_153[0],
      {
        steps: [
          ...RUN_153[1].steps.slice(0, 2),
          { ...SKIPPED_SLIDER, status: "confusing", unverifiedReason: null },
        ],
      },
    ];
    const r = gateFindings([SLIDER_FINDING], journeys);
    check("same finding on a confusing step is kept", r.kept.length === 1 && r.dropped.length === 0);
  }

  // 3 — every unverifiedReason counts; a stepRef to a skipped step is enough.
  for (const reason of ["missing_access", "not_applicable", null]) {
    const journeys: GateJourney[] = [
      RUN_153[0],
      { steps: [...RUN_153[1].steps.slice(0, 2), { ...SKIPPED_SLIDER, unverifiedReason: reason }] },
    ];
    const r = gateFindings([SLIDER_FINDING], journeys);
    check(`stepRef to a skipped step is dropped with unverifiedReason=${reason ?? "null"}`, r.dropped.length === 1);
  }

  // 4 — no stepRef; the words tie the finding to the skipped step and to no
  // walked step → dropped.
  {
    const { stepRef: _ref, ...noRef } = SLIDER_FINDING;
    const r = gateFindings([noRef], RUN_153);
    check("no stepRef, text matches only the skipped step → dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "the reason says it was matched by text",
      r.dropped[0]?.reason.includes("no stepRef") && r.dropped[0]?.reason.includes(SKIPPED_SLIDER.label),
      r.dropped[0]?.reason,
    );
  }

  // 5 — no stepRef; the words also match a broken step → kept. The finding
  // has a step where something was observed, so it is not about the skipped
  // one alone.
  {
    const { stepRef: _ref, ...noRef } = SLIDER_FINDING;
    const journeys: GateJourney[] = [
      ...RUN_153,
      {
        steps: [
          {
            label: "Save Insight Preferences after moving a slider",
            status: "broken",
            unverifiedReason: null,
            observed: "Moving a slider enabled Save Changes; clicking it returned HTTP 500.",
          },
        ],
      },
    ];
    const r = gateFindings([noRef], journeys);
    check("no stepRef, text also matches a broken step → kept", r.kept.length === 1 && r.dropped.length === 0);
  }

  // 6 — an exposed finding without stepRef that matches only a skipped step is
  // dropped too, and the log says so in the words the ticket asked for.
  {
    const exposed: SynthesizedFinding = {
      title: "Insight Preferences endpoint accepts writes without a session",
      category: "exposed",
      severity: "high",
      detail: {
        where: "/settings — Insight Preferences",
        whatHappened: "The preferences request looked like it would be accepted without authentication.",
      },
    };
    const r = gateFindings([exposed], RUN_153);
    check("exposed without stepRef matching only a skipped step → dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "…with the specific reason",
      r.dropped[0]?.reason.startsWith(EXPOSED_NO_EVIDENCE) === true,
      r.dropped[0]?.reason,
    );
  }

  // 7 — an exposed finding WITH a stepRef to an exposed step is never dropped,
  // whatever else was skipped in the run.
  {
    const exposed: SynthesizedFinding = {
      title: "Settings page leaks another user's email in the response",
      category: "exposed",
      severity: "high",
      detail: { where: "/settings", whatHappened: "Response body contained a different account's email." },
      stepRef: { journeyIndex: 1, stepIndex: 0 },
    };
    const journeys: GateJourney[] = [
      RUN_153[0],
      { steps: [{ ...RUN_153[1].steps[0], status: "exposed" }, ...RUN_153[1].steps.slice(1)] },
    ];
    const r = gateFindings([exposed], journeys);
    check("exposed with stepRef to an exposed step → kept", r.kept.length === 1);
  }

  // 8 — findings on ok/broken/risky/confusing steps pass through untouched, in
  // order, alongside one that is dropped.
  {
    const onOk: SynthesizedFinding = {
      title: "Email toggle label is ambiguous",
      category: "polish",
      severity: "low",
      detail: { where: "/settings", whatHappened: "The toggle reads 'Notifications' with no hint of what it sends." },
      stepRef: { journeyIndex: 1, stepIndex: 1 },
    };
    // No stepRef, but its words are about a step this run walked ("landing",
    // "rendered"), so it has something to stand on (CHE-420).
    const unrelated: SynthesizedFinding = {
      title: "Landing hero image is 4 MB",
      category: "polish",
      severity: "low",
      detail: { where: "/", whatHappened: "The landing page rendered, but its hero loads a 4 MB PNG." },
    };
    const r = gateFindings([onOk, SLIDER_FINDING, unrelated], RUN_153);
    check(
      "findings on walked steps and unrelated findings are untouched, order preserved",
      r.kept.length === 2 && r.kept[0] === onOk && r.kept[1] === unrelated && r.dropped.length === 1,
      titles(r.kept),
    );
    for (const status of ["broken", "risky", "confusing", "exposed"]) {
      const journeys: GateJourney[] = [
        RUN_153[0],
        { steps: [RUN_153[1].steps[0], { ...RUN_153[1].steps[1], status }, SKIPPED_SLIDER] },
      ];
      const rr = gateFindings([onOk], journeys);
      check(`a finding with stepRef to a ${status} step is never dropped`, rr.kept.length === 1);
    }
  }

  // 9 — an out-of-range stepRef is no reference; the text rule decides.
  {
    const dangling = { ...SLIDER_FINDING, stepRef: { journeyIndex: 7, stepIndex: 0 } };
    const r = gateFindings([dangling], RUN_153);
    check("out-of-range stepRef falls through to the text rule (dropped here)", r.dropped.length === 1);
  }

  // 10 — no skipped step in the run ⇒ nothing is dropped, whatever the text.
  {
    const journeys: GateJourney[] = [RUN_153[0], { steps: RUN_153[1].steps.slice(0, 2) }];
    const toggle: SynthesizedFinding = {
      title: "Email notifications toggle gives no confirmation",
      category: "polish",
      severity: "low",
      detail: { where: "/settings", whatHappened: "The toggle flipped and Save Changes enabled, with no message." },
    };
    const { stepRef: _ref, ...noRef } = toggle;
    const r = gateFindings([noRef, { ...toggle, stepRef: { journeyIndex: 1, stepIndex: 1 } }], journeys);
    check("no skipped step in the run → every finding kept", r.kept.length === 2 && r.dropped.length === 0);
  }

  // 11 — empty inputs.
  {
    check("no findings → empty", gateFindings([], RUN_153).kept.length === 0);
    // CHE-420: with no walked step in the run, a finding has nothing to stand on.
    check(
      "no journeys → a finding with no stepRef is dropped",
      gateFindings([{ ...SLIDER_FINDING, stepRef: undefined }], []).dropped.some((d) => d.reason === NO_STEP_SUPPORTS),
    );
    const r = gateFindings([], []);
    check("nothing in → nothing out", r.kept.length === 0 && r.dropped.length === 0);
  }

  // 12 — the tokenizer: short words and stop words are not evidence, plurals
  // fold, casing is irrelevant.
  {
    const t = distinctiveTokens("The Sliders would NOT respond; Save stayed disabled — which is Insight");
    check(
      "tokens: ≥5 letters, stop words out, plural folded, lower-cased",
      t.has("slider") && t.has("respond") && t.has("stayed") && t.has("disabled") && t.has("insight"),
      [...t].join(","),
    );
    check("tokens: 'would' and 'which' are stop words, 'save' and 'the' too short", !t.has("would") && !t.has("which") && !t.has("save"));
  }

  // ─── CHE-215 ───────────────────────────────────────────────────────────────

  // 13 — the fixture is the run, not a paraphrase of it.
  {
    const steps = RUN_159.journeys.flatMap((j) => j.steps);
    check("#159 fixture: 5 journeys, 35 steps", RUN_159.journeys.length === 5 && steps.length === 35, `${steps.length} steps`);
    const text = steps.map((s) => `${s.label} ${s.observed ?? ""}`).join(" ").toLowerCase();
    check(
      "#159: no step mentions the accordion, an expansion or a notes field",
      !text.includes("accordion") && !text.includes("expanded") && !/\bnotes field\b/.test(text),
    );
    const trail = drivenControls(steps.filter((s) => s.status !== "skipped"));
    check("#159: the run recorded a machine trail", trail.recorded);
    check(
      "#159: it performed two fills, and the only one that names a control is the sign-in email box",
      trail.fill.count === 2 && [...trail.fill.tokens].join(" ") === "email address",
      `${trail.fill.count} fills: ${[...trail.fill.tokens].join(" ") || "(nothing named)"}`,
    );
  }

  // 14 — the ticket's case: run #159's own finding against run #159's own
  // steps → dropped.
  {
    const r = gateFindings([RUN_159.finding], RUN_159.journeys);
    check("#159: the published finding is dropped", r.kept.length === 0 && r.dropped.length === 1, titles(r.kept));
    check(
      "#159: the reason is the missing interaction, not the skipped steps",
      r.dropped[0]?.reason.startsWith(NO_INTERACTION_RECORDED) === true,
      r.dropped[0]?.reason,
    );
    check(
      "#159: it is dropped even when it names a walked step — CHE-188 alone would keep it",
      gateFindings([{ ...RUN_159.finding, stepRef: { journeyIndex: 2, stepIndex: 2 } }], RUN_159.journeys).kept
        .length === 0,
    );
  }

  // 15 — a finding whose whatWeTried matches what the run actually did → kept.
  // Same run, same trail; this one is about the sign-in email box, the one
  // control run #159's trail shows we filled (step 1.0, "Email address").
  {
    const real: SynthesizedFinding = {
      title: "Email address field does not accept input after a rejected submit",
      category: "confusing",
      severity: "medium",
      detail: {
        where: "/sign-in — Email address field",
        whatWeTried: ["Typed an address into the Email address field"],
        whatHappened: "Once the form had been rejected, the Email address field would not take a corrected address.",
        whyItMatters: "A visitor who mistypes their address cannot correct it without reloading.",
      },
    };
    const r = gateFindings([real], RUN_159.journeys);
    check("a null-effect finding about a control we really filled is kept", r.kept.length === 1, r.dropped[0]?.reason);
    check(
      "…and the same finding moved to a control nothing filled is dropped",
      gateFindings(
        [{ ...real, title: "Notes field does not accept input", detail: { ...real.detail, where: "/check — notes" } }],
        RUN_159.journeys,
      ).kept.length === 0,
    );
  }

  // 15b — one shared token is a coincidence, not an anchor. Our own primary
  // page is /check, so almost every locus carries "check", and run #159's trail
  // holds a click on the link "Check your app →". Anchoring on a single token
  // would let that nav link vouch for a claim about an unrelated control, which
  // is this PR's own failure moved one word to the left.
  {
    const coincidence: SynthesizedFinding = {
      title: "Password reset button does nothing",
      category: "broken",
      severity: "high",
      detail: {
        where: "/check — password reset",
        whatWeTried: ["Pressed the password reset button"],
        whatHappened: "Pressing it had no effect and no message appeared.",
      },
    };
    const r = gateFindings([coincidence], RUN_159.journeys);
    check(
      "a single token shared with a nav link does not anchor an unrelated claim",
      r.kept.length === 0,
      r.dropped[0]?.reason ?? "(kept)",
    );
    // …and where the hand's controls carry only one token, that one token is
    // the whole of the set and must appear, or nothing could ever anchor.
    const oneToken: GateJourney[] = [
      {
        steps: [
          {
            label: "Type into the notes box",
            status: "ok",
            unverifiedReason: null,
            observed: "Typed into the notes box. The password input was visible.",
            actions: JSON.stringify([{ kind: "fill", label: "Notes", value: "x", outcome: {} }]),
          },
        ],
      },
    ];
    const aboutNotes: SynthesizedFinding = {
      title: "Notes box does not accept input",
      category: "broken",
      severity: "medium",
      detail: { where: "/check — notes", whatHappened: "It would not accept input." },
    };
    check("a one-token control name still anchors its own claim", gateFindings([aboutNotes], oneToken).kept.length === 1);
    const aboutPassword = gateFindings(
      [{ ...aboutNotes, title: "Password box does not accept input", detail: { where: "/sign-in — password" } }],
      oneToken,
    );
    check(
      "…and does not anchor a claim about something else",
      aboutPassword.kept.length === 0 && aboutPassword.dropped[0]?.reason.startsWith(NO_INTERACTION_RECORDED) === true,
      aboutPassword.dropped[0]?.reason,
    );
  }

  // 16 — a link check is not an interaction. verify_links resolves outbound
  // URLs server-side (CLAUDE.md rule 3) and lands in a step's observed with no
  // click behind it; such a finding must stay publishable.
  {
    const linkFinding: SynthesizedFinding = {
      title: "Two YouTube embeds on the tour page are unplayable",
      category: "broken",
      severity: "medium",
      detail: {
        where: "/tour — video wall",
        whatWeTried: ["Resolved every outbound video URL on the page"],
        whatHappened: "Two of the eleven YouTube URLs return an oEmbed error: the videos are deleted or private.",
        whyItMatters: "A visitor on the tour page meets two dead videos.",
      },
    };
    check("a link-check finding claims no interaction of ours", claimedHands(linkFinding).length === 0);
    const journeys: GateJourney[] = [
      {
        steps: [
          {
            label: "Check the tour page's outbound video links",
            status: "broken",
            unverifiedReason: null,
            observed: "Eleven YouTube URLs resolved; two returned an oEmbed error (deleted or private).",
            actions: JSON.stringify([
              { kind: "navigate", url: "https://example.com/tour", outcome: { status: 200 } },
            ]),
          },
          {
            label: "Sign in to the members area",
            status: "skipped",
            unverifiedReason: "missing_access",
            observed: "No credentials were provided this run.",
            actions: null,
          },
        ],
      },
    ];
    const r = gateFindings([linkFinding], journeys);
    check("link-check finding with no click step is kept", r.kept.length === 1, r.dropped[0]?.reason);
  }

  // 17 — CHE-188 is untouched: a finding supported only by a skipped step is
  // still dropped, and for CHE-188's reason, in a run that also carries a
  // trail. The trail must not become a way to rescue one.
  {
    const withTrail: GateJourney[] = [
      {
        steps: RUN_153[1].steps.map((s) => ({
          ...s,
          actions: JSON.stringify([
            { kind: "fill", label: "Insight Preferences", value: "0.5", outcome: {} },
            { kind: "click", role: "button", name: "Save Changes", outcome: {} },
          ]),
        })),
      },
    ];
    const r = gateFindings([{ ...SLIDER_FINDING, stepRef: { journeyIndex: 0, stepIndex: 2 } }], withTrail);
    check(
      "CHE-188 unchanged: a finding on a skipped step is dropped even when the trail would anchor it",
      r.kept.length === 0 && r.dropped[0]?.reason.includes("our_capability") === true,
      r.dropped[0]?.reason,
    );
  }

  // 18 — the rule stays silent where it cannot speak: no trail at all, and a
  // hand whose recorded controls have no nameable token.
  {
    const noTrail: GateJourney[] = [
      { steps: [{ label: "Open the settings page", status: "ok", unverifiedReason: null, observed: "Settings rendered with Insight Preferences." }] },
    ];
    check(
      "a run with no machine trail keeps the finding (the rule cannot speak)",
      gateFindings([{ ...SLIDER_FINDING, stepRef: undefined }], noTrail).kept.length === 1,
    );
    const shortNames: GateJourney[] = [
      {
        steps: [
          {
            label: "Press Save",
            status: "ok",
            unverifiedReason: null,
            observed: "The Save button was pressed on the pricing page.",
            actions: JSON.stringify([{ kind: "click", role: "button", name: "Save", outcome: {} }]),
          },
        ],
      },
    ];
    const shortClaim: SynthesizedFinding = {
      title: "Buy button does nothing",
      category: "broken",
      severity: "high",
      detail: { where: "/pricing", whatWeTried: ["Clicked Buy"], whatHappened: "Clicking Buy had no effect." },
    };
    check(
      "a trail whose controls have no nameable token is silence, not a denial",
      gateFindings([shortClaim], shortNames).kept.length === 1,
    );
  }

  // 19 — the null-effect phrases and the hand they name.
  {
    const claim = (title: string, whatHappened: string): SynthesizedFinding => ({
      title,
      category: "confusing",
      severity: "low",
      detail: { whatHappened },
    });
    check("'did not accept input' is a fill claim", claimedHands(claim("Field problem", "The field did not accept input.")).includes("fill"));
    check("'nothing happened' after a click is a click claim", claimedHands(claim("Button problem", "We clicked the button and nothing happened.")).includes("click"));
    check(
      "a 500 is not a claim about our hands",
      claimedHands(claim("Checkout returns 500", "Submitting the order returned HTTP 500 and no confirmation was shown.")).length === 0,
    );
    check(
      "a curly apostrophe does not hide the phrase",
      claimedHands(claim("Slider problem", "The slider didn’t respond to a drag.")).includes("click"),
    );
  }

  // ─── CHE-219: the same evidence, applied to a summary and a bottom line ────

  // 20 — run #159's journey 0 summary, against journey 0's own steps. The
  // false clause goes; the true sentence beside it stays, word for word.
  {
    const journey0 = RUN_159.journeys[0];
    const r = cutUndrivenClaims(journey0.summary, [journey0]);
    check("#159 summary: one sentence is cut", r.cut.length === 1, r.cut.join(" | ") || "(nothing cut)");
    check(
      "…the cut one is the fill claim",
      r.cut[0]?.includes("fails to accept input") && r.cut[0]?.includes("the fill operation times out"),
      r.cut[0],
    );
    check(
      "…and the sign-in sentence survives verbatim",
      r.text === "The sign-in page, which previously rendered blank, now loads correctly with Clerk scripts.",
      r.text ?? "(nothing left)",
    );
  }

  // 21 — the same run's bottom line, against the whole run.
  {
    const r = cutUndrivenClaims(RUN_159.bottomLine, RUN_159.journeys);
    check("#159 bottom line: the opening claim is cut", r.cut.length === 1, r.cut.join(" | ") || "(nothing cut)");
    check(
      "…the cut one is the credential/notes claim",
      r.cut[0]?.includes("would not accept input this run"),
      r.cut[0],
    );
    check(
      "…and everything the run did verify is kept",
      Boolean(r.text?.startsWith("Otherwise everything we walked is healthy")) &&
        Boolean(r.text?.includes("add test-account credentials in your dashboard")),
      r.text ?? "(nothing left)",
    );
  }

  // 22 — fail-open, the same three ways the finding gate fails open.
  {
    const noTrail: GateJourney[] = [
      { steps: [{ label: "Open the form", status: "ok", unverifiedReason: null, observed: "It rendered." }] },
    ];
    const claim = "The notes field did not accept input.";
    check("a run with no machine trail is left alone", cutUndrivenClaims(claim, noTrail).text === claim);
    const named: GateJourney[] = [
      {
        steps: [
          {
            label: "Fill the notes",
            status: "ok",
            unverifiedReason: null,
            observed: "Typed into the notes field.",
            actions: JSON.stringify([{ kind: "fill", label: "Notes", value: "x", outcome: {} }]),
          },
        ],
      },
    ];
    check("a claim about a control we did fill is kept", cutUndrivenClaims(claim, named).text === claim);
    const unnamed: GateJourney[] = [
      {
        steps: [
          {
            label: "Fill it",
            status: "ok",
            unverifiedReason: null,
            observed: "Typed something.",
            actions: JSON.stringify([{ kind: "fill", selector: "input[type=text]", value: "x", outcome: {} }]),
          },
        ],
      },
    ];
    check("a fill that named no control is silence, not a denial", cutUndrivenClaims(claim, unnamed).text === claim);
    check("empty text is returned as it came", cutUndrivenClaims("", named).text === "");
    check("null text is returned as null", cutUndrivenClaims(null, named).text === null);
  }

  // 23 — a sentence that says nothing about our hands is never touched, and a
  // text that was ONLY the claim comes back null so the caller can stand in a
  // fallback rather than publish an empty line.
  {
    const trail: GateJourney[] = [
      {
        steps: [
          {
            label: "Open the checkout",
            status: "broken",
            unverifiedReason: null,
            observed: "The order endpoint answered 500.",
            actions: JSON.stringify([{ kind: "navigate", url: "https://shop.test/checkout", outcome: { status: 500 } }]),
          },
        ],
      },
    ];
    const product = "Checkout returns HTTP 500 and no order is created.";
    check("a product failure with no claim about our hands is untouched", cutUndrivenClaims(product, trail).text === product);
    const onlyClaim = cutUndrivenClaims("The Buy button did nothing when pressed.", trail);
    check("a text that was only the claim comes back null", onlyClaim.text === null && onlyClaim.cut.length === 1, onlyClaim.text ?? "null");
  }

  // ─── What the retro sweep found in stored prod text ────────────────────────
  //
  // Both of these came out of the first dry run of sweep-undriven-claims.ts
  // over production, and both were defects in the rule rather than in the data.

  // 24 — a sentence that says the interaction WORKED is not a claim that it
  // produced nothing. Run #158 stored a success narrated with the stumble
  // before it, and the timeout phrasing fired on it.
  {
    const succeeded =
      "The field accepted the text (a CSS-selector fill first timed out during hydration, but the placeholder-targeted fill succeeded).";
    check("a success narrated with its stumble is not a claim", handsInText(succeeded).length === 0, JSON.stringify(handsInText(succeeded)));
    check("…and the cut leaves it alone", cutNullEffectClauses(succeeded).text === succeeded);
    // But a real claim in the same shape still counts, and a success elsewhere
    // in the sentence does not excuse it — run #159's finding contrasted its
    // own failure with the sign-in box accepting input normally.
    const contrast =
      "The input attempt did not take — we could not enter text here, whereas the sign-in email field accepted input normally in the same run.";
    check("a claim contrasted with another control's success is still a claim", handsInText(contrast).includes("fill"));
    check("'did not accept input' is not read as a success", handsInText("The field did not accept input.").includes("fill"));

    // The first version of that exception was a hole, found by running these
    // two sentences rather than reading the regex. Both are verbatim.
    const wrongPage = "The button click landed on the wrong page and did nothing.";
    check(
      "a success word that is about direction, not outcome, does not excuse a claim",
      handsInText(wrongPage).includes("click"),
      JSON.stringify(handsInText(wrongPage)),
    );
    check("…and the sentence is cut", cutNullEffectClauses(wrongPage).cut.length === 1);
    const negatedSuccess = "The field never really accepted the input, nothing happened.";
    check(
      "a negation an adverb away from the verb still negates it",
      handsInText(negatedSuccess).includes("fill"),
      JSON.stringify(handsInText(negatedSuccess)),
    );
    check("…and that sentence is cut too", cutNullEffectClauses(negatedSuccess).cut.length === 1);
    // The success verb must govern the hand it names, not merely share a
    // sentence with it.
    check(
      "a success elsewhere in the clause does not reach across to another hand",
      handsInText("The click did nothing after the upload succeeded.").includes("click"),
    );
  }

  // 25 — a dependent clause cannot be promoted to a sentence. The first sweep
  // would have published "the very field paying customers use to hand you test
  // logins." on run #159's verdict page, and "but the placeholder-targeted
  // fill succeeded)" on a step.
  {
    const bottomLineShape =
      "The credential/notes field on /check would not accept input this run — the very field paying customers use to hand you test logins.";
    const r = cutNullEffectClauses(bottomLineShape);
    check(
      "a lower-case continuation is not promoted to a sentence",
      r.text === null,
      r.text ?? "(null)",
    );
    const brackets = cutNullEffectClauses("Clicking it did nothing (0 requests, no DOM change).");
    check("an unbalanced bracket fragment is not published", brackets.text === null, brackets.text ?? "(null)");
    // The clause that DID open its sentence still survives, which is the whole
    // point of cutting at clause level.
    check(
      "the opening clause still survives",
      cutNullEffectClauses("The field is present but the input attempt did not take.").text === "The field is present.",
    );
  }

  // 26 — CHE-420, run cmuvu9xhl: a journey that walked and never recorded a
  // step, a summary that names a defect, and a finding grown from it. No
  // stepRef, and it claims no null-effect hand, so neither the CHE-215 anchor
  // nor rule (b) had anything to test.
  {
    const SEARCH_CLAIM: SynthesizedFinding = {
      title: "Visitor Logs search count never reflects a matching result",
      category: "confusing",
      severity: "medium",
      detail: {
        where: "Visitor Logs",
        whatWeTried: ["Searched the Visitor Logs for part of an address"],
        whatHappened: "The count under the Visitor Logs search reads 0 entries matching your search while matching rows render.",
        whyItMatters: "An admin reviewing blocked visitors cannot trust the count.",
      },
      stepRef: undefined,
    };
    const unrecorded: GateJourney[] = [
      {
        status: "ok",
        steps: [
          { label: "Open the Block Log overview", status: "ok", unverifiedReason: null, observed: "The overview lists protection totals." },
        ],
      },
      {
        status: "skipped",
        // What a zero-step walk leaves behind today: the one skipped step of
        // ours that says nothing about the product.
        steps: [
          {
            label: "Review the Block Log (blocked visitors)",
            status: "skipped",
            unverifiedReason: "our_capability",
            observed: "This journey could not be confirmed this time.",
          },
        ],
      },
    ];
    const r = gateFindings([SEARCH_CLAIM], unrecorded);
    check("CHE-420: a finding with no stepRef and no walked step behind it is dropped", r.kept.length === 0, titles(r.kept));
    check("…and the reason says so", r.dropped.length === 1 && r.dropped[0].reason === NO_STEP_SUPPORTS, r.dropped[0]?.reason);

    // A run with nothing skipped at all takes the other branch of the gate.
    const noSkip = gateFindings([SEARCH_CLAIM], [unrecorded[0]]);
    check("…also when nothing in the run was skipped", noSkip.dropped.length === 1 && noSkip.dropped[0].reason === NO_STEP_SUPPORTS, noSkip.dropped[0]?.reason);

    // The same finding with a walked step that supports it stays.
    const walked: GateJourney[] = [
      unrecorded[0],
      {
        status: "ok",
        steps: [
          {
            label: "Search the Visitor Logs for an address",
            status: "confusing",
            unverifiedReason: null,
            observed: "The Visitor Logs count reads 0 entries matching your search while three rows render.",
          },
        ],
      },
    ];
    check("CHE-420: the same finding with a walked step that supports it is kept", gateFindings([SEARCH_CLAIM], walked).kept.length === 1);
    check(
      "…also when it names that step",
      gateFindings([{ ...SEARCH_CLAIM, stepRef: { journeyIndex: 1, stepIndex: 0 } }], walked).kept.length === 1,
    );
    // `attempted` is part of what a walked step can vouch for: here the label
    // and the observation share too little with the finding, and only what was
    // attempted ties them. Without `attempted` in the match this is dropped.
    const viaAttempted: GateJourney[] = [
      {
        status: "ok",
        steps: [
          {
            label: "Open the page",
            status: "ok",
            unverifiedReason: null,
            observed: "It loaded.",
            attempted: "Typed part of an address and read the matching visitor result",
          },
        ],
      },
    ];
    check(
      "CHE-420: tokens from `attempted` let a finding with no stepRef stand",
      gateFindings([SEARCH_CLAIM], viaAttempted).kept.length === 1,
    );
    check(
      "…in the run that skipped something too",
      gateFindings([SEARCH_CLAIM], [...viaAttempted, unrecorded[1]]).kept.length === 1,
    );

    // A finding our own code wrote from a recorded measurement names no step
    // and need not share words with any (extension-charge-not-final).
    const MEASURED: SynthesizedFinding = {
      ...SEARCH_CLAIM,
      errorSignature: "extension-charge-not-final:signed-in",
    };
    check(
      "CHE-420: an errorSignature finding with no stepRef is not dropped for want of a step",
      gateFindings([MEASURED], [unrecorded[0]]).kept.length === 1 &&
        gateFindings([MEASURED], unrecorded).kept.length === 1,
    );

    // Naming a step is a reference; the gate does not second-guess a stepRef
    // that points at a walked step (CHE-215's anchor still reads its claim).
    check(
      "a stepRef to a walked step is not re-judged by wording",
      gateFindings([{ ...SEARCH_CLAIM, stepRef: { journeyIndex: 0, stepIndex: 0 } }], unrecorded).kept.length === 1,
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
