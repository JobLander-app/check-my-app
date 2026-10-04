// CHE-415: the three code standards a guard can hold, held.
//
// docs/CODE_STANDARDS.md is read by the agents that build and review this code.
// Three of its rules are mechanical, and this is their mechanism:
//
//   R3  no `dangerouslySetInnerHTML` anywhere under src/ — owner rule,
//       2026-10-04, after an inline <script> through it passed a review round;
//   R4  no <script> element in a .tsx under src/app or src/components;
//   R8  no `overflow-x-auto` / `overflow-x-scroll` (nor `overflow-auto` /
//       `overflow-scroll`, under any Tailwind variant) on an element that wraps
//       a <table> there — a table that scrolls sideways hides the columns that
//       did not fit (owner rule, 2026-10-04).
//
// Read from each file's syntax tree, not from its text (the way
// scripts/verify-lens-flags.ts reads the client graph): a comment that names
// the prop is not a use of it, a string that spells it is, and "the element
// that wraps a table" is a question about JSX parents, which text cannot
// answer. The reader is run on a fixture of each offence first — written,
// caught, removed — so the day one of them stops being caught, this script is
// what goes red.
//
// The doc's rule count is printed beside the checks so the doc and the guard
// are seen together: a rule added there is a line here, or a reason why not.
//
// Usage: npm run verify:code-standards

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import ts from "typescript";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = "docs/CODE_STANDARDS.md";
const FORBIDDEN_PROP = "dangerouslySetInnerHTML";
// A class token that scrolls sideways at some width: `overflow-x-auto`,
// `overflow-auto` (both axes), their `scroll` forms, each behind any Tailwind
// variants (`md:`, `max-lg:`, `supports-[…]:`) and the `!` important mark. A
// variant does not make the rule hold less — it makes the table scroll at
// exactly the width the variant names (Codex on #264).
const SIDEWAYS_TOKEN = /(?:^|:)!?overflow-(?:x-)?(?:auto|scroll)$/;
const sidewaysIn = (classes: string): string | undefined => classes.split(/\s+/).find((t) => SIDEWAYS_TOKEN.test(t));
// Where a page is: the directories whose .tsx files render for the customer.
const PAGE_DIRS = ["src/app", "src/components"];

function sourceFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

const where = (file: ts.SourceFile, node: ts.Node, root: string) =>
  `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

/** The tag of a JSX element, when it is a plain name: `table`, `section`, `Card`. */
function tagOf(node: ts.Node): string | null {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  return opening && ts.isIdentifier(opening.tagName) ? opening.tagName.text : null;
}

/** Every string the element's `className` is made of: a literal, or each literal inside clsx(...), a template, a conditional. */
function classNames(node: ts.Node): string[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return [];
  const attr = opening.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "className");
  if (!attr?.initializer) return [];
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(attr.initializer);
  return out;
}

/** What in a tree of source files breaks R3, R4 or R8, each as "path:line  what". */
export function offenders(root: string): string[] {
  const out: string[] = [];
  const pageDirs = PAGE_DIRS.map((d) => join(root, d) + sep);
  for (const path of sourceFiles(join(root, "src"))) {
    const file = parse(path);
    const isPage = path.endsWith(".tsx") && pageDirs.some((d) => path.startsWith(d));
    const visit = (node: ts.Node): void => {
      // R3: the identifier (a JSX attribute, a property, a destructured name)
      // or the string (props["dangerouslySetInnerHTML"]) — the prop under any spelling.
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === FORBIDDEN_PROP) {
        out.push(`${where(file, node, root)}  ${FORBIDDEN_PROP} (R3)`);
      }
      if (isPage) {
        const tag = tagOf(node);
        // R4: a <script> element, with a body or self-closing.
        if (tag === "script") out.push(`${where(file, node, root)}  <script> element (R4)`);
        // R8: a <table>, or any JSX element above it, that scrolls sideways.
        if (tag === "table") {
          for (let up: ts.Node | undefined = node; up; up = up.parent) {
            if (!ts.isJsxElement(up) && !ts.isJsxSelfClosingElement(up)) continue;
            const sideways = classNames(up).map(sidewaysIn).find((t) => t !== undefined);
            if (sideways) {
              out.push(`${where(file, up, root)}  <${tagOf(up) ?? "element"} className="…${sideways}…"> wraps the <table> at ${where(file, node, root)} (R8)`);
              break;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return out;
}

// ─── The reader, on a fixture of each offence ───────────────────────────────

function fixtureChecks(): void {
  const root = mkdtempSync(join(tmpdir(), "che-415-standards-"));
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  try {
    // Clean: a <pre> may scroll, a plain table may not be wrapped in anything that does,
    // a comment may name the prop, and src/agent may match "<script" in a string.
    write("src/components/ok.tsx", [
      `export const Ok = () => (`,
      `  <section className="card">`,
      `    {/* dangerouslySetInnerHTML is forbidden here (R3) */}`,
      `    <pre className="overflow-x-auto">code</pre>`,
      `    <div className="overflow-y-auto md:overflow-hidden overflow-x-hidden"><table className="w-full"><tbody /></table></div>`,
      `  </section>`,
      `);`,
    ].join("\n"));
    write("src/agent/scan.ts", `export const INLINE = /<script[^>]*>/g; export const name = "script";\n`);
    write("src/generated/prisma/client.ts", `export const x = { dangerouslySetInnerHTML: 1 };\n`);
    const clean = offenders(root);
    check("fixture: a scrolling <pre>, a table that scrolls only vertically or hides overflow, a comment naming the prop, a regex in src/agent and src/generated are all fine", clean.length === 0, clean.join("; "));

    const offences: [string, string, string, RegExp][] = [
      ["dangerouslySetInnerHTML as a JSX attribute", "src/app/a.tsx", `export const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n`, /dangerouslySetInnerHTML \(R3\)/],
      ["dangerouslySetInnerHTML as a spread property", "src/components/b.tsx", `const p = { dangerouslySetInnerHTML: { __html: "x" } };\nexport const B = () => <div {...p} />;\n`, /b\.tsx:1 {2}dangerouslySetInnerHTML \(R3\)/],
      ["dangerouslySetInnerHTML as a string key", "src/lib/c.ts", `export const c = (p: Record<string, unknown>) => p["dangerouslySetInnerHTML"];\n`, /c\.ts:1 {2}dangerouslySetInnerHTML \(R3\)/],
      ["dangerouslySetInnerHTML outside the page directories (src/lib, a .ts)", "src/lib/d.ts", `export const key = "dangerouslySetInnerHTML";\n`, /d\.ts:1 {2}dangerouslySetInnerHTML \(R3\)/],
      ["a <script> element with a body", "src/app/e.tsx", `export const E = () => <script>{"alert(1)"}</script>;\n`, /<script> element \(R4\)/],
      ["a self-closing <script src>", "src/components/f.tsx", `export const F = () => <script src="/x.js" />;\n`, /<script> element \(R4\)/],
      ["overflow-x-auto on the table's parent", "src/app/g.tsx", `export const G = () => <section className="card overflow-x-auto"><table /></section>;\n`, /<section className="…overflow-x-auto…"> wraps the <table>/],
      ["overflow-x-scroll two levels above the table", "src/components/h.tsx", `export const H = () => <div className="overflow-x-scroll"><div><table /></div></div>;\n`, /<div className="…overflow-x-scroll…"> wraps the <table>/],
      ["overflow-x-auto inside clsx(...) on the wrapper", "src/app/i.tsx", `declare const clsx: (...a: string[]) => string;\nexport const I = () => <div className={clsx("card", "overflow-x-auto")}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["overflow-x-auto in a template on the wrapper", "src/app/j.tsx", `export const J = (w: string) => <div className={\`\${w} overflow-x-auto\`}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["overflow-x-auto on the table itself", "src/components/k.tsx", `export const K = () => <table className="overflow-x-auto" />;\n`, /<table className="…overflow-x-auto…"> wraps the <table>/],
      // Codex on #264: a variant scrolls the table at the width it names.
      ["md:overflow-x-auto on the wrapper", "src/app/l.tsx", `export const L = () => <div className="card md:overflow-x-auto"><table /></div>;\n`, /<div className="…md:overflow-x-auto…"> wraps the <table>/],
      ["max-lg:overflow-x-scroll on the wrapper", "src/app/m.tsx", `export const M = () => <div className="max-lg:overflow-x-scroll"><table /></div>;\n`, /<div className="…max-lg:overflow-x-scroll…"> wraps the <table>/],
      ["supports-[display:grid]:overflow-x-auto on the wrapper", "src/app/n.tsx", `export const N = () => <div className="supports-[display:grid]:overflow-x-auto"><table /></div>;\n`, /<div className="…supports-\[display:grid\]:overflow-x-auto…"> wraps the <table>/],
      ["!overflow-x-auto (important) on the wrapper", "src/app/o.tsx", `export const O = () => <div className="!overflow-x-auto"><table /></div>;\n`, /<div className="…!overflow-x-auto…"> wraps the <table>/],
      ["md:!overflow-x-scroll on the wrapper", "src/app/p.tsx", `export const P = () => <div className="md:!overflow-x-scroll"><table /></div>;\n`, /<div className="…md:!overflow-x-scroll…"> wraps the <table>/],
      ["overflow-auto (both axes) on the wrapper", "src/app/q.tsx", `export const Q = () => <div className="overflow-auto"><table /></div>;\n`, /<div className="…overflow-auto…"> wraps the <table>/],
      ["lg:overflow-scroll on the wrapper", "src/app/r.tsx", `export const R = () => <div className="lg:overflow-scroll"><table /></div>;\n`, /<div className="…lg:overflow-scroll…"> wraps the <table>/],
    ];
    for (const [name, rel, text, expected] of offences) {
      write(rel, text);
      const found = offenders(root);
      rmSync(join(root, rel));
      const after = offenders(root);
      check(`fixture: ${name} is caught`, found.some((o) => expected.test(o)) && after.length === 0, found.join("; ") || "nothing caught");
    }

    // Outside the page directories, a <script> element and a scrolling table are not this guard's
    // (an e-mail template in src/lib renders no page) — stated, so a move there is a decision.
    write("src/lib/mail.tsx", `export const M = () => <div className="overflow-x-auto"><table /><script /></div>;\n`);
    const lib = offenders(root);
    check("fixture: a .tsx outside src/app and src/components is not read for R4/R8", lib.length === 0, lib.join("; "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── The repository ─────────────────────────────────────────────────────────

function repoChecks(): void {
  const files = sourceFiles(join(ROOT, "src"));
  check(`src/ has files to read (${files.length})`, files.length > 0);
  const found = offenders(ROOT);
  check("no dangerouslySetInnerHTML, no <script> element, no table that scrolls sideways in src/", found.length === 0, found.length ? `\n        ${found.join("\n        ")}` : "");
}

function docChecks(): void {
  const text = readFileSync(join(ROOT, DOC), "utf8");
  const rules = [...text.matchAll(/^### (R\d+)\. /gm)].map((m) => m[1]);
  check(`${DOC} exists and numbers its rules (${rules.length} rules, ${rules[0]}…${rules[rules.length - 1]})`, rules.length > 0);
  const dupes = rules.filter((r, i) => rules.indexOf(r) !== i);
  check("every rule number is used once", dupes.length === 0, dupes.join(", "));
  const guarded = ["R3", "R4", "R8"];
  check(`the three rules this guard holds (${guarded.join(", ")}) are in the doc`, guarded.every((r) => rules.includes(r)));
  check("the doc names this script as their mechanism", text.includes("scripts/verify-code-standards.ts"));
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0); // as `wc -l` counts
  check(`the doc stays readable in one sitting (${lines} lines, limit 300)`, lines <= 300);
}

fixtureChecks();
repoChecks();
docChecks();
console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
