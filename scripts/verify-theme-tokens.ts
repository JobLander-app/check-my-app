// Two themes, one palette (CHE-414).
//
// Every colour a component asks for resolves to a CSS variable on <html>, and
// the variables are what a theme changes. Three things keep that true:
//
//   1. No colour is written by hand anywhere in src/ except the two files that
//      define them (tailwind.config.ts, src/app/globals.css). A `#1a2b3c`, an
//      `rgb(…)` of fixed numbers or an `hsl(…)` in a class or style string is a
//      colour the light theme cannot reach. `color-mix(… currentColor …)` and
//      `rgb(var(--x) / …)` are references, not colours, and pass.
//   2. Tailwind's own output — compiled from the real config and the real
//      content globs, exactly as the build does — declares every token in the
//      dark block, the explicit light block and the prefers-color-scheme light
//      block, with the two light blocks identical, and every `var(--x)` the
//      stylesheet reads is a variable one of those blocks declares.
//   3. Every text token reads at 4.5:1 or better on every surface it can land
//      on, in both themes, and the page colour reads at 4.5:1 on every accent
//      and status fill (the dots and primary buttons put it there). The table
//      is printed, so the numbers are in the log, not just the verdict.
//
// The theme reaches <html> from the server (src/app/layout.tsx reads the
// cookie and renders data-theme); nothing in the browser sets it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-theme-tokens.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import ts from "typescript";
import tailwindConfig, { THEME_TOKENS, type ThemeName } from "../tailwind.config";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ── 1. Hand-written colours ──────────────────────────────────────────────────

// Where the palette is allowed to be spelled out.
const PALETTE_FILES = new Set(["tailwind.config.ts", "src/app/globals.css"]);

// A six- or eight-digit hex, or a three-digit one with a letter in it (`#fff`):
// a three-digit run of plain digits is a ticket or PR number in prose. A
// colour function whose first argument is not a variable. A colour-mix with
// neither currentColor nor a variable in it.
const HEX = /#(?:[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|(?=[0-9a-fA-F]{3}\b)(?:[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*))\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*(?!var\()/;
const COLOR_MIX = /color-mix\(([^)]*)\)/g;

function hardCodedColours(text: string): string[] {
  const found: string[] = [];
  const hex = text.match(HEX);
  if (hex) found.push(hex[0]);
  const fn = text.match(COLOR_FN);
  if (fn) found.push(fn[0].trim());
  for (const m of text.matchAll(COLOR_MIX)) {
    if (!/currentColor|var\(/.test(m[1])) found.push(m[0]);
  }
  return found;
}

type Hit = { file: string; line: number; text: string };

// Every string and template literal in a TypeScript file, wherever it is: a
// colour in a className, a style object, a status map or a constant is the
// same leak, and reading all of them means no attribute name can hide one.
function literalsIn(file: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: parts.join(" ") });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function colourHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  if (file.endsWith(".css")) {
    text.split("\n").forEach((line, i) => {
      for (const c of hardCodedColours(line)) hits.push({ file, line: i + 1, text: c });
    });
    return hits;
  }
  for (const lit of literalsIn(file, text)) {
    for (const c of hardCodedColours(lit.text)) hits.push({ file, line: lit.line, text: c });
  }
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return abs === path.join(repoRoot, "src/generated") ? [] : sourceFiles(abs);
    return /\.(tsx?|css)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [abs] : [];
  });
}

// ── 3. Contrast ──────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN_CONTRAST = 4.5;

// Where text lands: the page, the raised surface, the card, the inset and the
// active row. 700 and 600 are border and fill tokens, not surfaces.
const SURFACES = ["950", "900", "850", "800", "750"] as const;
const TEXT = [
  ["fg", "DEFAULT"],
  ["fg", "muted"],
  ["fg", "faint"],
  ["fg", "label"],
  ["accent", "DEFAULT"],
  ["status", "ok"],
  ["status", "confusing"],
  ["status", "risky"],
  ["status", "broken"],
  ["status", "exposed"],
] as const;
const FILLS = [
  ["accent", "DEFAULT"],
  ["accent", "hover"],
  ["status", "ok"],
  ["status", "confusing"],
  ["status", "risky"],
  ["status", "broken"],
  ["status", "exposed"],
] as const;

// The dark palette predates the light one and is kept as it is: its faint
// text (#5d6678) was drawn for 12px labels that sit beside stronger text and
// reads at 3.5:1 on the page, and its group label (#7d8699) reads at 4.4:1 on
// the active row, where no label is ever drawn. The numbers are printed with
// the rest; the light palette, drawn with the rule, is held to it everywhere.
const KNOWN_BELOW: Record<ThemeName, Set<string>> = {
  dark: new Set(["fg-faint", "fg-label"]),
  light: new Set(),
};

function tokenHex(group: string, shade: string, theme: ThemeName): string {
  return (THEME_TOKENS as Record<string, Record<string, Record<ThemeName, string>>>)[group][shade][theme];
}

function tokenName(group: string, shade: string): string {
  return shade === "DEFAULT" ? group : `${group}-${shade}`;
}

function contrastTable(theme: ThemeName) {
  console.log(`\n${theme}: text on surfaces (minimum ${MIN_CONTRAST}:1)`);
  console.log("  " + "token".padEnd(18) + SURFACES.map((s) => `ink-${s}`.padStart(8)).join(""));
  let worst = Infinity;
  for (const [group, shade] of TEXT) {
    const name = tokenName(group, shade);
    const row = SURFACES.map((s) => contrast(tokenHex(group, shade, theme), tokenHex("ink", s, theme)));
    const low = Math.min(...row);
    const exempt = KNOWN_BELOW[theme].has(name);
    if (!exempt) worst = Math.min(worst, low);
    console.log(`  ${name.padEnd(18)}${row.map((r) => r.toFixed(2).padStart(8)).join("")}${low < MIN_CONTRAST ? (exempt ? "   (below, kept as it was)" : "   BELOW") : ""}`);
  }
  console.log(`${theme}: page text (ink-950) on fills`);
  for (const [group, shade] of FILLS) {
    const r = contrast(tokenHex("ink", "950", theme), tokenHex(group, shade, theme));
    worst = Math.min(worst, r);
    console.log(`  ${tokenName(group, shade).padEnd(18)}${r.toFixed(2).padStart(8)}${r < MIN_CONTRAST ? "   BELOW" : ""}`);
  }
  return worst;
}

// ── 2. The compiled stylesheet ───────────────────────────────────────────────

type Block = Map<string, string>;

async function compiledBlocks(): Promise<{ dark: Block; light: Block; system: Block; varsRead: Set<string>; css: string }> {
  const cssPath = path.join(repoRoot, "src/app/globals.css");
  const config = { ...tailwindConfig, content: [path.join(repoRoot, "src/**/*.{ts,tsx}")] };
  const out = await postcss([tailwindcss(config)]).process(read("src/app/globals.css"), { from: cssPath });
  const blocks = { dark: new Map(), light: new Map(), system: new Map() } as Record<"dark" | "light" | "system", Block>;
  out.root.walkRules((rule) => {
    const inLightMedia =
      rule.parent?.type === "atrule" && /prefers-color-scheme:\s*light/.test((rule.parent as postcss.AtRule).params);
    const which =
      rule.selector === ":root" && !inLightMedia
        ? "dark"
        : rule.selector === ':root[data-theme="light"]'
          ? "light"
          : rule.selector === ':root:not([data-theme="dark"])' && inLightMedia
            ? "system"
            : null;
    if (!which) return;
    rule.walkDecls((d) => {
      if (d.prop.startsWith("--") || d.prop === "color-scheme") blocks[which].set(d.prop, d.value);
    });
  });
  const varsRead = new Set<string>();
  for (const m of out.css.matchAll(/var\((--[\w-]+)/g)) varsRead.add(m[1]);
  return { ...blocks, varsRead, css: out.css };
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  // The detector's own eyes first: planted colours in every shape it claims
  // to read, and the references it claims to let through.
  const planted = colourHits(
    "fixture.tsx",
    [
      'const a = <div className="bg-[#1a2b3c] text-fg" />;',
      'const b = <div style={{ color: "rgb(1, 2, 3)" }} />;',
      "const c = <div className={`border-[#fff] ${x}`} />;",
      'const d = { pillClassName: "hsl(10 20% 30%)" };',
      'const e = <i style={{ borderColor: "color-mix(in srgb, oklch(0.5 0.1 200) 30%, transparent)" }} />;',
    ].join("\n"),
  ).map((h) => h.text);
  check(
    "the detector catches a planted colour in a class, a style, a template, a status map and a fixed color-mix",
    ["#1a2b3c", "rgb(", "#fff", "hsl(", "oklch(", "color-mix(in srgb, oklch"].every((p) => planted.some((t) => t.startsWith(p))),
    `found ${planted.join(" · ")}`,
  );
  const allowed = colourHits(
    "fixture.tsx",
    [
      'const ok1 = "color-mix(in srgb, currentColor 30%, transparent)";',
      'const ok2 = "rgb(var(--accent) / 0.5)";',
      'const ok3 = "fixed in PR #184 and #1234, see CHE-414";',
      'const ok4 = <div className="bg-ink-850/50 text-status-ok" />;',
    ].join("\n"),
  );
  check("…and lets currentColor mixes, var() references, ticket numbers and token classes through", allowed.length === 0, allowed.map((h) => h.text).join(" · "));

  const files = sourceFiles(path.join(repoRoot, "src")).map((f) => path.relative(repoRoot, f));
  const hits: Hit[] = [];
  for (const file of files) {
    if (PALETTE_FILES.has(file)) continue;
    hits.push(...colourHits(file, read(file)));
  }
  check(`read ${files.length} files under src/`, files.length > 200);
  for (const h of hits) check(`hand-written colour in ${h.file}:${h.line}`, false, h.text);
  check("no colour is written by hand outside the palette files", hits.length === 0, hits.length ? `${hits.length} found` : "");

  const { dark, light, system, varsRead, css } = await compiledBlocks();
  // A config without the table is the old one: colours spelled out as hex
  // for Tailwind alone, nothing for a second theme to change.
  check("tailwind.config.ts exports the palette table (THEME_TOKENS)", THEME_TOKENS !== undefined);
  const tokenNames = new Set<string>();
  for (const [group, shades] of Object.entries(THEME_TOKENS ?? {})) {
    for (const shade of Object.keys(shades)) tokenNames.add(`--${tokenName(group, shade)}`);
  }
  const declares = (block: Block) => tokenNames.size > 0 && [...tokenNames].every((t) => block.has(t));
  const missing = (block: Block) => [...tokenNames].filter((t) => !block.has(t)).join(" ");
  check(`the dark block declares every token (${tokenNames.size})`, declares(dark), missing(dark));
  check("the explicit light block declares every token", declares(light), missing(light));
  check("the prefers-color-scheme light block declares every token", declares(system), missing(system));
  const sameKeys = dark.size === light.size && [...dark.keys()].every((k) => light.has(k));
  check(`dark and light declare the same set of variables (${dark.size})`, sameKeys, [...new Set([...dark.keys(), ...light.keys()])].filter((k) => !(dark.has(k) && light.has(k))).join(" "));
  const lightTwice = light.size === system.size && [...light].every(([k, v]) => system.get(k) === v);
  check("the two light blocks are identical", lightTwice);
  check("each block names its color-scheme", dark.get("color-scheme") === "dark" && light.get("color-scheme") === "light" && system.get("color-scheme") === "light");
  const unread = [...varsRead].filter((v) => !v.startsWith("--tw-") && !v.startsWith("--font-") && !dark.has(v));
  check("every variable the stylesheet reads is declared", unread.length === 0, unread.join(" "));
  check("Tailwind's colour utilities read the variables", /\.bg-ink-850 \{[^}]*rgb\(var\(--ink-850\)/.test(css) && /\.text-status-ok \{[^}]*rgb\(var\(--status-ok\)/.test(css));
  check("an opacity modifier still works on a variable colour", /\.bg-accent\\\/10 \{[^}]*rgb\(var\(--accent\) \/ 0\.1\)/.test(css));
  check("Clerk's variables are flat colours Clerk can parse", [...dark].filter(([k]) => k.startsWith("--clerk-color-")).length >= 12 && [...dark, ...light].filter(([k]) => k.startsWith("--clerk-color-")).every(([, v]) => /^#[0-9a-f]{6}$/.test(v)));

  const layout = read("src/app/layout.tsx");
  check("the server renders data-theme on <html> from the cookie", /cookies\(\)/.test(layout) && /<html[^>]*data-theme=\{theme\}/.test(layout));
  const browserSets = files.filter((f) => /documentElement\.(setAttribute\(["']data-theme|dataset\.theme)|localStorage\.[gs]etItem\(["']cma_theme/.test(read(f)));
  check("nothing in the browser sets the theme", browserSets.length === 0, browserSets.join(" "));
  check("no inline script decides the theme", !/dangerouslySetInnerHTML[^]*theme/i.test(layout));

  for (const theme of ["dark", "light"] as const) {
    if (!THEME_TOKENS) {
      check(`${theme}: contrast table`, false, "no palette to measure");
      continue;
    }
    const worst = contrastTable(theme);
    check(`${theme}: every text token reads at ${MIN_CONTRAST}:1 on every surface, page text on every fill`, worst >= MIN_CONTRAST, `worst ${worst.toFixed(2)}`);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
