// No `dangerouslySetInnerHTML` anywhere under src/ (CHE-411).
//
// /home carried an inline <script> through it to turn /dashboard#balance into
// Billing. Next 16 does not run a script injected this way from a server
// component — it logged a console error on every visit and did nothing — and
// markup written as a string bypasses React's escaping, which is the one thing
// standing between a stored string and the page. Whatever needs a script is a
// client component; whatever needs a link is a link.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-no-inner-html.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : walk(p);
    return /\.(tsx?|jsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

const hits: string[] = [];
for (const file of walk(path.join(repoRoot, "src"))) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/dangerouslySetInnerHTML/.test(line)) hits.push(`${path.relative(repoRoot, file)}:${i + 1}`);
  });
}

const ok = hits.length === 0;
console.log(`${ok ? "PASS" : "FAIL"}  no dangerouslySetInnerHTML under src/${ok ? "" : `  →  ${hits.join(", ")}`}`);
console.log(ok ? "\nall passed" : "\n1 FAILED");
process.exit(ok ? 0 : 1);
