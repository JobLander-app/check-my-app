// CHE-421: the home page says what the visitor is afraid of and what they get,
// in their words — and nothing about our machinery. This proves, without a
// browser, a server or PostHog:
//
//   1. every sentence on the page lives in src/lib/home-copy.ts and passes the
//      same gates as a verdict (src/lib/verdict-language.ts): no homework for
//      the customer, no environment leak, no machinery narration — and none of
//      the §10 pricing words (scripts/verify-public-copy.ts reads the module
//      too; this is the belt to its braces);
//   2. the proof is a real check: a publicId of the shape the database issues,
//      a verdict and a severity the product knows, a price with cents, and the
//      "Open the verdict" link goes to that same run (src/lib/example-verdict.ts
//      is derived from it, so the excerpt and the link can never disagree);
//   3. the first screen is one sentence and one line, chosen from the variants
//      the owner compared; the form no longer carries a headline of its own;
//   4. the page is sections, not a wall: one <h1>, the proof and the four pains
//      render on the server with their words, and nothing on the page is an
//      inline script, dangerouslySetInnerHTML, a useEffect or a sideways
//      scroll (CODE_STANDARDS R3/R4/R8/R9).
//
// Made to fail first: with page.tsx and submit-form.tsx from before CHE-421,
// checks 3 and 4 fail (two headlines, a <br> in the <h1>, no proof, no pains).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-home-copy.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { HomePains } from "@/components/home-pains";
import { HomeProof } from "@/components/home-proof";
import { SubmitForm } from "@/components/submit-form";
import { EXAMPLE_VERDICT_PATH } from "@/lib/example-verdict";
import { FORM_NOTE, HERO, HERO_VARIANTS, PAINS, PROOF, allHomeSentences } from "@/lib/home-copy";
import { SEVERITY_META, VERDICT_META } from "@/lib/status";
import { hasEnvironmentLeak, hasHomework, narrationIn } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

// ─── 1. Every sentence passes the verdict's own gates ───────────────────────

// CLAUDE.md §10 and §1 in one list: our price formula and our instruments.
const PRICING_OR_MACHINERY = /\b(multiplier|mark-?up|our margin|at cost|costs?\s+us|agent\s+compute|headless|playwright|in\s+our\s+environment|our\s+test\s+browser)\b/i;

function leaks(sentence: string): string[] {
  const out: string[] = [];
  if (hasHomework(sentence)) out.push("homework");
  if (hasEnvironmentLeak(sentence)) out.push("environment");
  const narration = narrationIn(sentence);
  if (narration.length) out.push(`narration: ${narration.join(" | ")}`);
  if (PRICING_OR_MACHINERY.test(sentence)) out.push("pricing/machinery word");
  return out;
}

// The gate proves it would catch the sentence it exists for.
check("the gate flags homework", leaks("Spot-check the checkout yourself in a real browser.").length > 0);
check("the gate flags a machinery word", leaks("Our headless browser walks your app.").length > 0);
check("the gate flags a pricing word", leaks("We price every check at a 3× multiplier.").length > 0);

const sentences = allHomeSentences();
check("the module lists its sentences", sentences.length >= 20, `${sentences.length}`);
for (const s of sentences) {
  const found = leaks(s);
  check(`clean: “${s.slice(0, 60)}${s.length > 60 ? "…" : ""}”`, found.length === 0, found.join(", "));
}

// ─── 2. The proof is a real check, and the link goes to it ──────────────────

check("proof publicId has the database's shape", /^c[a-z0-9]{24}$/.test(PROOF.publicId), PROOF.publicId);
check("proof verdict is one the product knows", PROOF.verdict in VERDICT_META, PROOF.verdict);
check("proof severity is one the product knows", PROOF.finding.severity in SEVERITY_META, PROOF.finding.severity);
check("proof price is a price with cents, not a cost", PROOF.priceUsd > 0 && Number.isInteger(PROOF.priceUsd * 100), String(PROOF.priceUsd));
check("proof date is a day", /^\d{4}-\d{2}-\d{2}$/.test(PROOF.checkedOn) && !Number.isNaN(Date.parse(PROOF.checkedOn)));
check("the example verdict is the proof's run", EXAMPLE_VERDICT_PATH === `/verdict/${PROOF.publicId}`, EXAMPLE_VERDICT_PATH);
check("the proof names our own product, nobody else's", PROOF.app === "joblander.app", PROOF.app);

// ─── 3. The first screen ────────────────────────────────────────────────────

// A headline is a breath, not a paragraph (the anti-reference: a three-line
// H1 over a long subtitle). Sentences are counted by their terminal marks.
const sentencesIn = (s: string) => (s.trim().match(/[.!?](\s|$)/g) ?? []).length;
const wordsIn = (s: string) => s.trim().split(/\s+/).length;
check("HERO is one of the compared variants", HERO_VARIANTS.includes(HERO), HERO.key);
for (const v of HERO_VARIANTS) {
  check(`${v.key}: headline is ≤ 2 sentences and ≤ 12 words, no line break`, sentencesIn(v.headline) <= 2 && wordsIn(v.headline) <= 12 && !v.headline.includes("\n"), `${wordsIn(v.headline)} words`);
  check(`${v.key}: the line is ≤ 2 sentences and ≤ 40 words`, sentencesIn(v.line) <= 2 && wordsIn(v.line) <= 40, `${sentencesIn(v.line)} sentences, ${wordsIn(v.line)} words`);
}
check("four pains, as in the research", PAINS.length === 4);
check("every pain is the fear in their words, in quotes", PAINS.every((p) => /^“.+”$/.test(p.fear)));

const form = source("src/components/submit-form.tsx");
check("the form carries no headline of its own", !/<h1\b/.test(form));
check("the form no longer reads the landing-variant bucket", !/useLandingVariant/.test(form));
check("the form's note is the one line from the module", form.includes("{FORM_NOTE}") && !/No signup\. Free first run\./.test(form));

// ─── 4. Sections, not a wall ────────────────────────────────────────────────

const page = source("src/app/page.tsx");
const h1s = page.match(/<h1\b[\s\S]*?<\/h1>/g) ?? [];
check("exactly one <h1> on the page", h1s.length === 1, `${h1s.length}`);
check("…and it is the headline from the module, without a <br>", h1s[0] !== undefined && h1s[0].includes("{HERO.headline}") && !/<br/.test(h1s[0]));
check("the page shows the proof", /<HomeProof\s*\/>/.test(page));
check("the page shows the pains", /<HomePains\s*\/>/.test(page));
check("the page keeps the form and the flag it needs", /<SubmitForm[^>]*extensionCheck=\{extensionCheck\}/.test(page));

for (const f of ["src/app/page.tsx", "src/components/home-proof.tsx", "src/components/home-pains.tsx", "src/lib/home-copy.ts"]) {
  const s = source(f);
  check(`${f}: no useEffect, inline script, dangerouslySetInnerHTML or sideways scroll`, !/useEffect|<script|dangerouslySetInnerHTML|overflow-x-(auto|scroll)/.test(s));
}

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const pains = renderToString(createElement(HomePains));
for (const p of PAINS) check(`rendered pains carry “${p.fear.slice(1, 40)}…”`, pains.includes(escapeHtml(p.fear)));
// React separates adjacent text nodes with `<!-- -->`; the reader sees one string.
const proof = renderToString(createElement(HomeProof)).replace(/<!--\s*-->/g, "");
check("rendered proof carries the finding", proof.includes(escapeHtml(PROOF.finding.title)));
check("rendered proof carries the price with cents", proof.includes(`$${PROOF.priceUsd.toFixed(2)}`));
check("rendered proof links to the verdict", proof.includes(`href="${EXAMPLE_VERDICT_PATH}"`));
check("rendered proof carries the verdict's label", proof.includes(VERDICT_META[PROOF.verdict].label));
const formHtml = renderToString(createElement(AppRouterContext.Provider, { value: router as never }, createElement(SubmitForm, {})));
check("rendered form carries the one-line note", formHtml.includes(escapeHtml(FORM_NOTE)));
check("rendered form has no headline", !/<h1/.test(formHtml));
check("nothing rendered is a script", ![pains, proof, formHtml].some((h) => /<script/.test(h)));

const publicCopy = source("scripts/verify-public-copy.ts");
check("verify-public-copy reads the module as customer-facing", publicCopy.includes('"src/lib/home-copy.ts"'));

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
