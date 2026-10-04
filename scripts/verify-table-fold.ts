// A table fits the work area at every width (CHE-412; owner rule 2026-10-04:
// no table scrolls sideways). Over every page under src/app/(app) that draws
// a table:
//
//   1. No table scrolls inside its card: `overflow-x-auto` is gone from the
//      pages, and every table is the fixed-layout one from src/lib/table-fold.ts.
//   2. Every table folds: it is drawn only from the width the sidebar stands
//      beside the page (the shell's own 900px), and below it the same rows are
//      cards — both halves from the one module, so the points agree.
//   3. A column that is hidden until a wide screen has its content folded into
//      a column that stays — moved, never dropped.
//   4. A fixed-layout table needs a width on every column but one: a column
//      with none is squeezed to nothing, not scrolled.
//   5. All apps' list row is what the owner asked for: the app, its latest
//      check (number and age on one line), the strip with a tooltip that says
//      what grey is, the window's spend, the schedule, Settings — and not the
//      figures that live on the app's page.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-table-fold.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FOLD, TABLE_CLASS } from "../src/lib/table-fold";
import { stripTitle } from "../src/lib/all-apps";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

function sources(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((d) => {
    const p = `${dir}/${d.name}`;
    return d.isDirectory() ? sources(p) : /\.tsx$/.test(d.name) ? [p] : [];
  });
}

// ── The fold points ─────────────────────────────────────────────────────────
const shell = read("src/components/shell/app-shell.tsx");
const sidebarFrom = shell.match(/min-\[(\d+)px\]:flex/)?.[1];
check("the cards fold at the width the sidebar appears at — the shell's own number", sidebarFrom !== undefined && FOLD.tableClassName.includes(`min-[${sidebarFrom}px]:block`) && FOLD.cardsClassName.includes(`min-[${sidebarFrom}px]:hidden`), `shell ${sidebarFrom}px; ${FOLD.tableClassName} / ${FOLD.cardsClassName}`);
check("the table is hidden below it, the cards above it", /^hidden /.test(FOLD.tableClassName) && !/hidden/.test(FOLD.cardsClassName.replace(/min-\[\d+px\]:hidden/, "")));
check("a secondary column is a cell from xl on, and its folded copy is gone from xl on", FOLD.wideColumnClassName === "hidden xl:table-cell" && FOLD.foldedClassName === "xl:hidden");
check("the table is fixed-layout and full width", /\btable-fixed\b/.test(TABLE_CLASS) && /\bw-full\b/.test(TABLE_CLASS));

// ── Every table under the app ───────────────────────────────────────────────
const pages = sources("src/app/(app)").filter((f) => /<table\b/.test(read(f)));
check("the pages with a table are the ones the rule was written for, and the accuracy page's small one",
  pages.length === 5 && ["health/accuracy/page.tsx", "health/apps/page.tsx", "health/checks/page.tsx", "health/issues/page.tsx", "settings/billing/page.tsx"].every((p) => pages.some((f) => f.endsWith(p))), pages.join(", "));

// A table of up to four columns — a name and three numbers — fits a phone as it
// is; wider than that it folds to cards. The accuracy page's is the small one.
const SMALL = 4;
for (const file of pages) {
  const src = read(file);
  const name = file.replace("src/app/(app)/", "");
  const tables = src.match(/<thead>[\s\S]*?<\/thead>/g) ?? [];
  const columns = Math.max(...tables.map((t) => (t.match(/<th\b/g) ?? []).length));
  check(`${name}: no table scrolls inside its card`, !/overflow-x-auto/.test(src));
  check(`${name}: every table is the fixed-layout one`, (src.match(/<table className=\{(`\$\{)?TABLE_CLASS\b/g) ?? []).length === (src.match(/<table\b/g) ?? []).length, `${(src.match(/<table\b/g) ?? []).length} table(s)`);
  if (columns > SMALL) {
    check(`${name}: ${columns} columns — the table is drawn from the sidebar's width, and the rows are cards below it`, /FOLD\.tableClassName/.test(src) && /FOLD\.cardsClassName/.test(src) && src.indexOf("FOLD.tableClassName") < src.indexOf("FOLD.cardsClassName"));
  } else {
    check(`${name}: ${columns} columns — fits as it is, and its names truncate rather than widen it`, /\btruncate\b/.test(src));
  }
  const wide = (src.match(/FOLD\.wideColumnClassName/g) ?? []).length;
  const folded = (src.match(/FOLD\.foldedClassName/g) ?? []).length;
  check(`${name}: a column hidden until xl has its content folded somewhere that stays`, wide === 0 || folded > 0, `${wide} wide, ${folded} folded`);
  // Every <th> but at most one per table carries a width.
  for (const [i, table] of tables.entries()) {
    const ths = table.match(/<th\b[^>]*>/g) ?? [];
    const widthless = ths.filter((th) => !/\bw-\[\d+px\]/.test(th));
    check(`${name}: table ${i + 1} gives every column but one a width (fixed layout)`, ths.length > 0 && widthless.length <= 1, `${widthless.length} of ${ths.length} without`);
  }
  check(`${name}: drawn on the server, no effect`, !/^"use client"/.test(src) && !/useEffect/.test(src));
}

// ── All apps' row ───────────────────────────────────────────────────────────
const apps = read("src/app/(app)/health/apps/page.tsx");
const list = apps.slice(apps.indexOf("function List("), apps.indexOf("// Health → All apps"));
const headers = [...list.matchAll(/<th className=\{(?:TH|`[^`]*`)\}(?: \/>|>([^<]*)<\/th>)/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
eq("the list's columns: app, latest, the strip, the window's spend, schedule", headers.join(" | "), "App | Latest | Last 21 checks | {days} days | Schedule");
check("…and none of the figures that live on the app's page", !/A day|Last check|Checks<\/th>|Scheduled · on request|Recurring/.test(list));
check("the latest check's number and age are one line, in mono",
  /<span className="whitespace-nowrap font-mono text-\[13px\] text-fg-faint">\s*<Link[^>]*>\s*#\{app\.latest\.runNumber\}\s*<\/Link>\s*\{app\.latest\.completedAt && ` · \$\{checkedWhen\(app\.latest\.completedAt\)\}`\}/.test(apps));
check("the strip's tooltip is the one that explains grey", /summary=\{stripTitle\(app\.verdicts\.map\(\(v\) => v\.verdict\)\)\}/.test(list));
check("the schedule is a column on a wide screen and a line under the app until then",
  /<th className=\{`\$\{TH\} w-\[\d+px\] \$\{FOLD\.wideColumnClassName\}`\}>Schedule<\/th>/.test(list) && /\$\{FOLD\.foldedClassName\}`\}>\{scheduleLabel\(app\.watch\)\}/.test(list));
check("below the sidebar's width the list is the cards", /<div className=\{FOLD\.cardsClassName\}>\s*\{apps\.map\(\(app\) => \(\s*<Card/.test(list));
check("the list carries no price (it opens with its reason in the cards and on the app's page)", !/CheckPrice|priceUsd|usd\(app\.latest/.test(list));

eq("tooltip: a strip with nothing grey says only its story", stripTitle(["all_good", "mostly_ok", "broken"], 3), "Broken in the latest check; it was not in the one before.");
eq("tooltip: a strip with a check that verified nothing says what grey is", stripTitle(["unverified", "unverified", "unverified"], 3), "Nothing verified yet. Grey bars: checks that verified nothing.");
eq("tooltip: an app younger than the strip says what the dark slots are", stripTitle(["all_good"], 21), "All good in its first check. Dark slots: no check yet (1 of 21).");
check("tooltip: it names no machinery", !/run|agent|smoke|walk|browser/i.test(stripTitle(["unverified", "all_good"], 21)));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
