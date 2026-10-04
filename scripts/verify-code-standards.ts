// CHE-415: the three code standards a guard can hold, held.
//
// docs/CODE_STANDARDS.md is read by the agents that build and review this code.
// Three of its rules are mechanical, and this is their mechanism:
//
//   R3  no `dangerouslySetInnerHTML` anywhere under src/ — owner rule,
//       2026-10-04, after an inline <script> through it passed a review round;
//   R4  no <script> element in any .tsx under src/;
//   R8  no `overflow-x-auto` / `overflow-x-scroll` (nor `overflow-auto` /
//       `overflow-scroll`, under any Tailwind variant) on an element that wraps
//       a <table> — a table that scrolls sideways hides the columns that did
//       not fit (owner rule, 2026-10-04).
//
// Read from each file's syntax tree, not from its text (the way
// scripts/verify-lens-flags.ts reads the client graph): a comment that names
// the prop is not a use of it, a string that spells it is, "the element that
// wraps a table" is a question about JSX parents, and a className is read
// through the constants and imports it refers to — none of which text can
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

// ─── Reading a className ────────────────────────────────────────────────────
//
// The strings a className is made of are not always written in the attribute:
// this codebase keeps cell styles in constants (`const TD = "…"`,
// `className={\`${TD} text-right\`}`) and shares them between files. So a
// className is read through what it refers to — a constant in the same file,
// a property of a constant object, a named import from a module under src/
// (Codex on #264) — each resolved from the syntax tree of the file that holds
// it. What cannot be read (a function parameter, a call's result, a package)
// is left alone: the guard reads what is written, and says nothing about the
// rest.

type Resolved = { files: Map<string, ts.SourceFile>; root: string };

function fileSet(root: string): Set<string> {
  return new Set(sourceFiles(join(root, "src")));
}

function resolveModule(root: string, from: string, spec: string, files: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = join(from, "..", spec);
  else return null;
  const bare = base.replace(/\.(js|jsx|mjs)$/, "");
  const candidates = [base, ...[bare, base].flatMap((b) => [".ts", ".tsx"].map((e) => b + e)), ...["ts", "tsx"].map((e) => join(base, `index.${e}`))];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** The declaration a name refers to in this file: its own `const`, or the module it is imported from. */
function declarationOf(file: ts.SourceFile, name: string): { init: ts.Expression } | { from: string; imported: string } | null {
  let found: { init: ts.Expression } | { from: string; imported: string } | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = { init: n.initializer };
    else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      const el = n.importClause.namedBindings.elements.find((e) => e.name.text === name);
      if (el) found = { from: n.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text };
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

/** What a name is initialised with, following a named import to the module under src/ that exports it. */
function initializerOf(name: string, file: ts.SourceFile, ctx: Resolved, files: Set<string>): { init: ts.Expression; file: ts.SourceFile } | null {
  const decl = declarationOf(file, name);
  if (!decl) return null;
  if ("init" in decl) return { init: decl.init, file };
  const target = resolveModule(ctx.root, file.fileName, decl.from, files);
  if (!target) return null;
  const other = ctx.files.get(target) ?? parse(target);
  ctx.files.set(target, other);
  const theirs = declarationOf(other, decl.imported);
  return theirs && "init" in theirs ? { init: theirs.init, file: other } : null;
}

/** Every string an expression is made of, through the names it refers to. */
function stringsOf(expr: ts.Node, file: ts.SourceFile, ctx: Resolved, files: Set<string>, seen: Set<string>, out: string[]): void {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return void out.push(expr.text);
  if (ts.isTemplateExpression(expr)) {
    out.push(expr.head.text, ...expr.templateSpans.map((s) => s.literal.text));
    for (const s of expr.templateSpans) stringsOf(s.expression, file, ctx, files, seen, out);
    return;
  }
  if (ts.isIdentifier(expr)) {
    const key = `${file.fileName}#${expr.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const found = initializerOf(expr.text, file, ctx, files);
    if (found) stringsOf(found.init, found.file, ctx, files, seen, out);
    return;
  }
  // `STYLES.cell`: the property of a constant object, when the object is written out — here or in the module it comes from.
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const found = initializerOf(expr.expression.text, file, ctx, files);
    if (!found) return;
    const objects: ts.ObjectLiteralExpression[] = [];
    const collect = (n: ts.Node) => (ts.isObjectLiteralExpression(n) ? objects.push(n) : ts.forEachChild(n, collect));
    collect(found.init);
    for (const o of objects) {
      const p = o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === expr.name.text);
      if (p) stringsOf(p.initializer, found.file, ctx, files, seen, out);
    }
    return;
  }
  ts.forEachChild(expr, (child) => stringsOf(child, file, ctx, files, seen, out));
}

/** Every string the element's `className` is made of, through constants, object properties and imports. */
function classNames(node: ts.Node, file: ts.SourceFile, ctx: Resolved, files: Set<string>): string[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return [];
  const attr = opening.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "className");
  if (!attr?.initializer) return [];
  const out: string[] = [];
  stringsOf(attr.initializer, file, ctx, files, new Set(), out);
  return out;
}

/** What in a tree of source files breaks R3, R4 or R8, each as "path:line  what". */
export function offenders(root: string): string[] {
  const out: string[] = [];
  const files = fileSet(root);
  const ctx: Resolved = { files: new Map(), root };
  for (const path of files) {
    const file = ctx.files.get(path) ?? parse(path);
    ctx.files.set(path, file);
    const visit = (node: ts.Node): void => {
      // R3: the identifier (a JSX attribute, a property, a destructured name)
      // or the string (props["dangerouslySetInnerHTML"]) — the prop under any spelling.
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === FORBIDDEN_PROP) {
        out.push(`${where(file, node, root)}  ${FORBIDDEN_PROP} (R3)`);
      }
      // R4 and R8 are about JSX, wherever under src/ it is written: a component
      // in src/lib is rendered by a page all the same (Codex on #264).
      const tag = tagOf(node);
      // R4: a <script> element, with a body or self-closing.
      if (tag === "script") out.push(`${where(file, node, root)}  <script> element (R4)`);
      // R8: a <table>, or any JSX element above it, that scrolls sideways.
      if (tag === "table") {
        for (let up: ts.Node | undefined = node; up; up = up.parent) {
          if (!ts.isJsxElement(up) && !ts.isJsxSelfClosingElement(up)) continue;
          const sideways = classNames(up, file, ctx, files).map(sidewaysIn).find((t) => t !== undefined);
          if (sideways) {
            out.push(`${where(file, up, root)}  <${tagOf(up) ?? "element"} className="…${sideways}…"> wraps the <table> at ${where(file, node, root)} (R8)`);
            break;
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

    // A className read through what it refers to (Codex on #264).
    write("src/lib/styles.ts", `export const CARD = "card overflow-x-auto";\nexport const CELLS = { wrap: "min-w-0 overflow-x-scroll", cell: "px-3" };\nexport const PLAIN = "card";\n`);
    const resolved: [string, string, string, RegExp][] = [
      ["a constant in the same file", "src/app/s.tsx", `const WRAP = "card overflow-x-auto";\nexport const S = () => <div className={WRAP}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["a constant inside a template", "src/app/t.tsx", `const WRAP = "md:overflow-x-auto";\nexport const T = () => <div className={\`\${WRAP} p-4\`}><table /></div>;\n`, /<div className="…md:overflow-x-auto…"> wraps the <table>/],
      ["a constant built from another constant", "src/app/u.tsx", `const BASE = "overflow-x-scroll";\nconst WRAP = \`card \${BASE}\`;\nexport const U = () => <div className={WRAP}><table /></div>;\n`, /<div className="…overflow-x-scroll…"> wraps the <table>/],
      ["a property of a constant object", "src/app/v.tsx", `const S = { wrap: "overflow-x-auto", cell: "px-3" };\nexport const V = () => <div className={S.wrap}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["a constant imported by @/ path", "src/app/w.tsx", `import { CARD } from "@/lib/styles";\nexport const W = () => <div className={CARD}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["an imported object's property, by relative path", "src/app/x.tsx", `import { CELLS } from "../lib/styles";\nexport const X = () => <div className={CELLS.wrap}><table /></div>;\n`, /<div className="…overflow-x-scroll…"> wraps the <table>/],
      ["a renamed import (import { CARD as C })", "src/app/y.tsx", `import { CARD as C } from "@/lib/styles";\nexport const Y = () => <div className={C}><table /></div>;\n`, /<div className="…overflow-x-auto…"> wraps the <table>/],
      ["a constant passed to clsx with a literal", "src/app/z.tsx", `declare const clsx: (...a: string[]) => string;\nconst WRAP = "overflow-auto";\nexport const Z = () => <div className={clsx("card", WRAP)}><table /></div>;\n`, /<div className="…overflow-auto…"> wraps the <table>/],
      ["a <script> element or a scrolling table in src/lib — a component a page renders", "src/lib/mail.tsx", `export const M = () => <div className="overflow-x-auto"><table /><script /></div>;\n`, /mail\.tsx:1 {2}<script> element \(R4\)/],
    ];
    for (const [name, rel, text, expected] of resolved) {
      write(rel, text);
      const found = offenders(root);
      rmSync(join(root, rel));
      const after = offenders(root);
      check(`fixture: ${name} is caught`, found.some((o) => expected.test(o)) && after.length === 0, found.join("; ") || "nothing caught");
    }
    // What refers to nothing readable, or to something harmless, is not an offence.
    write("src/app/quiet.tsx", [
      `import { PLAIN } from "@/lib/styles";`,
      `const CELL = "px-3 text-right";`,
      `export const Q = ({ wrap }: { wrap: string }) => (`,
      `  <div className={wrap}><table className={\`\${CELL} \${PLAIN}\`}><tbody /></table></div>`,
      `);`,
    ].join("\n"));
    const quiet = offenders(root);
    check("fixture: a className from a parameter, a harmless constant and a harmless import is fine", quiet.length === 0, quiet.join("; "));
    // A constant that refers to itself must not loop.
    write("src/app/loop.tsx", `const A: string = \`\${B} x\`;\nconst B: string = \`\${A} y\`;\nexport const L = () => <div className={A}><table /></div>;\n`);
    const loop = offenders(root);
    check("fixture: two constants that refer to each other end, and are no offence", loop.length === 0, loop.join("; "));
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
