// Public copy carries no machinery and no cost figure (CLAUDE.md rule §1).
//
// The verdict text has a deterministic gate (src/lib/verdict-language.ts, run
// after synthesis). The static pages never had one, and on 2026-09-06 /pricing
// was telling every visitor that "a full first check of a typical app runs
// ~$0.50 of agent compute" — our operating figure, on the page that asks them
// for $29. This script is the gate for everything a customer reads that is not
// produced by a model: the public pages, the shared components, the email.
//
// Pure: no browser, no network, no model. It reads the source files, strips
// comments (a comment is ours to read, not theirs), and fails with file:line on
// any forbidden phrasing left in the code. Rendering nothing is the point —
// what is not in the source cannot reach the page.
//
// To add a phrasing, add it to FORBIDDEN. To exempt a single line, add it to
// ALLOW with the reason — never widen a pattern to make a hit go away.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-public-copy.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Everything a customer reads that is written by hand rather than by a model.
// Directories are walked recursively; files are taken as they are.
const SOURCES = [
  "src/app/pricing",
  "src/app/faq",
  "src/app/about",
  "src/app/page.tsx",
  "src/app/paid",
  "src/app/checks/today",
  "src/app/verdict/[id]",
  "src/app/run/[id]",
  "src/app/onboarding",
  "src/app/dashboard",
  // The signed-in app (CHE-348): its pages, and the modules that write their
  // sentences. Until CHE-371 none of it was read here.
  "src/app/(app)",
  "src/lib/today.ts",
  "src/lib/check-delta.ts",
  "src/lib/billing-page.ts",
  "src/lib/all-apps.ts",
  "src/lib/app-page.ts",
  "src/components",
  "src/lib/email.ts",
];

const SOURCE_EXT = new Set([".ts", ".tsx"]);

// Each entry names the phrasing and why it is a leak. Matching is
// case-insensitive on comment-stripped source.
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  // "$0.50 of agent compute", "$2 in compute" — what a check costs us.
  { name: "cost figure", pattern: /\$\d+(\.\d+)?\s*(of|in)\s+(agent\s+)?compute/i },
  // "costs us", "cost us" — our side of the invoice, on their side of the page.
  { name: "costs us", pattern: /\bcosts?\s+us\b/i },
  // Compute is our bill, not their product.
  { name: "agent compute", pattern: /\bagent\s+compute\b/i },
  // How we check.
  { name: "headless", pattern: /\bheadless\b/i },
  { name: "in our environment", pattern: /\bin\s+our\s+environment\b/i },
  { name: "our test browser", pattern: /\bour\s+test\s+browser\b/i },
  // Pricing rule (CLAUDE.md §10): how we price a check — the multiplier, the
  // markup, our margin — is ours. A customer sees a price and its reason.
  // Appended last: the self-tests below address earlier entries by index.
  { name: "our pricing formula", pattern: /\b(multiplier|mark-?up|our margin|at cost)\b/i },
];

// Explicit exemptions: a file, the exact line text after trimming, and the
// reason it is not a leak. Empty today. An entry here is a decision that needs
// a reason a customer would accept, not a way to get a green run.
const ALLOW: { file: string; line: string; reason: string }[] = [];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function walk(rel: string): string[] {
  const abs = path.join(repoRoot, rel);
  const st = statSync(abs);
  if (st.isFile()) return SOURCE_EXT.has(path.extname(rel)) ? [rel] : [];
  return readdirSync(abs)
    .sort()
    .flatMap((entry) => walk(path.join(rel, entry)));
}

// Comments are ours. Block comments (including JSX `{/* … */}`) are blanked
// character-for-character so line numbers survive; a `//` comment is cut from
// the first `//` that follows the start of the line or whitespace, which keeps
// `https://` inside a string intact.
function stripComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

type Hit = { file: string; line: number; name: string; text: string };

function scan(rel: string): Hit[] {
  const lines = stripComments(readFileSync(path.join(repoRoot, rel), "utf8")).split("\n");
  const hits: Hit[] = [];
  lines.forEach((text, i) => {
    for (const { name, pattern } of FORBIDDEN) {
      if (!pattern.test(text)) continue;
      const exempt = ALLOW.some((a) => a.file === rel && a.line === text.trim());
      if (!exempt) hits.push({ file: rel, line: i + 1, name, text: text.trim() });
    }
  });
  return hits;
}

function main() {
  // The gate proves it would have caught the sentence it exists for, and that
  // the comment strip does not hide a leak that sits after a URL.
  const leaked =
    'Launch pricing. A full first check of a typical app runs ~$0.50 of agent compute — we\n' +
    "keep the free tier honest, not infinite.";
  check("the 2026-09-06 /pricing sentence trips 'cost figure'", FORBIDDEN[0].pattern.test(leaked));
  check("the 2026-09-06 /pricing sentence trips 'agent compute'", FORBIDDEN[2].pattern.test(leaked));
  check(
    "a comment is not a customer's text",
    scanText("// this check cost us $0.47 on opus\n{/* headless */}\nconst x = 1;").length === 0,
  );
  check(
    "a URL is not a comment",
    scanText('const href = "https://example.com"; // ok\nconst copy = "headless";').length === 1,
  );
  check("costUsd is a field, not the phrase", scanText("const costUsd = run.costUsd;").length === 0);

  const files = SOURCES.flatMap(walk);
  check("sources resolve to files", files.length > 0, `${files.length} files`);

  const hits = files.flatMap(scan);
  for (const h of hits) console.log(`FAIL  ${h.file}:${h.line}  [${h.name}]  ${h.text}`);
  failures += hits.length;
  check(`${files.length} customer-facing source files carry no forbidden phrasing`, hits.length === 0);

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function scanText(source: string): Hit[] {
  const lines = stripComments(source).split("\n");
  const hits: Hit[] = [];
  lines.forEach((text, i) => {
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) hits.push({ file: "<inline>", line: i + 1, name, text });
    }
  });
  return hits;
}

main();
