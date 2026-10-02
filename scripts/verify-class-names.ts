// Every class a component asks for exists (CHE-350).
//
// `btn-primary`, `btn-secondary`, `input` and `divide-border` were written as
// class names on the team page, the invite page, both settings pages and the
// billing button — and defined nowhere. Tailwind has no such utilities, the
// config has no `border` colour and globals.css declares none of them, so the
// "Send invitation" and "Join" buttons rendered with the browser's defaults.
// Nothing complained: an unknown class is silently nothing.
//
// The check asks the only authority there is. Tailwind itself compiles
// src/app/globals.css against the real tailwind.config.ts and the real content
// globs — exactly what the build does — and every class selector in that output
// is a class that exists. Every class token written in the source must be one of
// them — or a behaviour class (`ph-no-capture`), which code reads instead of CSS
// and whose readers the check proves are still there.
//
// Where tokens come from (TypeScript's own parser, src/**/*.{ts,tsx}):
//   - `className` / `class` JSX attributes;
//   - the arguments of cn(), clsx(), cx() and twMerge(), and the className
//     argument of buttonClass(), wherever they are called;
//   - object properties named `className` or `…ClassName` (the status maps in
//     src/lib that components read as `meta.pillClassName`);
//   - inside those: string literals, both branches of `a ? b : c`, the class side
//     of `a && b` / `a || b` / `a ?? b`, arrays, clsx object keys, the static
//     parts of template literals, and same-file `const`s and object maps reached
//     by name (`variants[variant]`).
// What is skipped, and counted: anything whose value is not in the file — a
// prop, an import, a function call's result, `+` concatenation, and a template
// fragment glued to an interpolation (`px-${n}`), whose token is not knowable
// until runtime. `--show-skipped` lists every one.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-class-names.ts [--show-skipped]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import tailwindcss from "tailwindcss";
import ts from "typescript";
import tailwindConfig from "../tailwind.config";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const showSkipped = process.argv.includes("--show-skipped");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ── What exists: Tailwind's own output for this config and this content ──────

async function definedClasses(): Promise<Set<string>> {
  const cssPath = path.join(repoRoot, "src/app/globals.css");
  const config = { ...tailwindConfig, content: [path.join(repoRoot, "src/**/*.{ts,tsx}")] };
  const out = await postcss([tailwindcss(config)]).process(readFileSync(cssPath, "utf8"), { from: cssPath });
  const classes = new Set<string>();
  // Every rule's selector, including those inside @media and @supports: a class
  // that appears in any selector (`.group:hover .group-hover\:x`, `.stagger > *`)
  // is a class something styles.
  out.root.walkRules((rule) => {
    selectorParser((sel) => sel.walkClasses((c) => void classes.add(c.value))).processSync(rule.selector);
  });
  return classes;
}

// ── What is asked for: class tokens in the source ───────────────────────────

type Token = { file: string; line: number; token: string };
type Skip = { file: string; line: number; kind: string; text: string };

// Functions whose arguments are class names, and which arguments: all of them
// for the joiners, only the second for buttonClass(variant, className) — its
// first is a variant name, and the variants themselves are read from the map
// inside button.tsx.
const CLASS_FUNCTIONS = new Map<string, "all" | number[]>([
  ["cn", "all"],
  ["clsx", "all"],
  ["cx", "all"],
  ["twMerge", "all"],
  ["buttonClass", [1]],
]);
const CLASS_ATTRIBUTES = new Set(["className", "class"]);

// Classes that style nothing on purpose: they are read by code, not by CSS.
// Each names the files that read it, and the check proves every one of those
// still does — an entry whose reader is gone fails, so this cannot become a
// place to park a typo.
const BEHAVIOUR_CLASSES: Record<string, { why: string; readBy: string[] }> = {
  "ph-no-capture": {
    why: "PostHog skips the element in autocapture and session replay; our guardEvent drops events from it",
    readBy: ["src/lib/analytics.ts", "node_modules/posthog-js/dist/module.mjs"],
  },
};

function classArgs(call: ts.CallExpression): ts.Expression[] | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const which = CLASS_FUNCTIONS.get(call.expression.text);
  if (!which) return null;
  return which === "all" ? [...call.arguments] : which.flatMap((i) => (call.arguments[i] ? [call.arguments[i]] : []));
}

function extract(file: string, text: string): { tokens: Token[]; skipped: Skip[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tokens: Token[] = [];
  const skipped: Skip[] = [];
  const seen = new Set<string>();
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // Same-file `const x = …` by name, so `cn(base, …)` and `variants[v]` are read.
  const consts = new Map<string, ts.Expression>();
  const indexConsts = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, indexConsts);
  };
  indexConsts(sf);

  const add = (node: ts.Node, value: string) => {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      const line = lineOf(node);
      const key = `${line}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ file, line, token });
    }
  };
  const skip = (node: ts.Node, kind: string) =>
    skipped.push({ file, line: lineOf(node), kind, text: node.getText(sf).slice(0, 80) });

  const resolving = new Set<string>();
  const fromConst = (name: string, at: ts.Node, read: (e: ts.Expression) => void) => {
    const init = consts.get(name);
    if (!init || resolving.has(name)) return skip(at, "value not in this file");
    resolving.add(name);
    read(init);
    resolving.delete(name);
  };

  const visitClassExpr = (node: ts.Expression): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return add(node, node.text);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return visitClassExpr(node.expression);
    }
    if (ts.isConditionalExpression(node)) {
      visitClassExpr(node.whenTrue);
      return visitClassExpr(node.whenFalse);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return visitClassExpr(node.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        visitClassExpr(node.left);
        return visitClassExpr(node.right);
      }
      return skip(node, "concatenation");
    }
    if (ts.isTemplateExpression(node)) return visitTemplate(node);
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isSpreadElement(el)) skip(el, "spread");
        else visitClassExpr(el);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      // clsx's { "class names": condition } form — the keys are the classes.
      for (const p of node.properties) {
        if (p.name && (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name))) add(p.name, p.name.text);
        else skip(p, "computed object key");
      }
      return;
    }
    const args = ts.isCallExpression(node) ? classArgs(node) : null;
    if (args) {
      for (const arg of args) visitClassExpr(arg);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return;
      return fromConst(node.text, node, visitClassExpr);
    }
    // `variants[variant]` / `styles.primary` over a same-file object map: every
    // value of the map is a class string this expression can produce.
    if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) && ts.isIdentifier(node.expression)) {
      return fromConst(node.expression.text, node, (init) => {
        if (!ts.isObjectLiteralExpression(init)) return skip(node, "value not in this file");
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p)) visitClassExpr(p.initializer);
          else skip(p, "non-literal map entry");
        }
      });
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
    skip(node, ts.isCallExpression(node) ? "function result" : "value not in this file");
  };

  // `a ${x} b` — "a" and "b" are classes. `px-${n}` is not knowable, and neither
  // is a string interpolated into the middle of a token; an interpolation that
  // stands alone between spaces is a class expression of its own.
  const visitTemplate = (node: ts.TemplateExpression) => {
    const fragments = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
    fragments.forEach((frag, i) => {
      const parts = frag.split(/(\s+)/);
      const gluedLeft = i > 0 && !/^\s/.test(frag);
      const gluedRight = i < fragments.length - 1 && !/\s$/.test(frag);
      const words = parts.filter((p) => p.trim());
      words.forEach((w, j) => {
        if ((j === 0 && gluedLeft) || (j === words.length - 1 && gluedRight)) return;
        add(node, w);
      });
    });
    node.templateSpans.forEach((span, i) => {
      const before = fragments[i];
      const after = fragments[i + 1];
      const standsAlone = (before === "" || /\s$/.test(before)) && (after === "" || /^\s/.test(after));
      if (standsAlone) visitClassExpr(span.expression);
      else skip(span.expression, "interpolated into a token");
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && CLASS_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) add(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression) visitClassExpr(init.expression);
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      /^(class|className|\w+ClassName)$/.test(node.name.text)
    ) {
      // Status maps hand their classes over by property name
      // (`pillClassName: "…"`) to a component in another file, where they
      // arrive as `meta.pillClassName` — unreadable there, so read here.
      visitClassExpr(node.initializer);
    } else if (ts.isCallExpression(node)) {
      // A call directly inside className={…} was read above; any other call
      // to a class function, wherever it is, is read here.
      const args = classArgs(node);
      const inAttribute = ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent);
      if (args && !inAttribute) for (const arg of args) visitClassExpr(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { tokens, skipped };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    // src/generated is Prisma's client, produced by `prisma generate`: no
    // markup, and present or not depending on the checkout.
    if (e.isDirectory()) return abs === path.join(repoRoot, "src/generated") ? [] : sourceFiles(abs);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [abs] : [];
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const defined = await definedClasses();

  // The checker's own eyes first. Tailwind produced utilities and the globals.css
  // components, and the extractor finds a planted undefined class through every
  // shape it claims to read — a green run must not be a run that saw nothing.
  check("Tailwind compiled the real config", defined.has("bg-accent") && defined.has("text-fg-muted"));
  check("globals.css classes are in the compiled set", defined.has("card") && defined.has("section-label"));
  const planted = extract(
    "fixture.tsx",
    [
      'const base = "zz-const";',
      'const map = { a: "zz-map" };',
      "export const A = (p: { on: boolean; k: 'a' }) => (",
      '  <div className={cn("zz-cn", p.on && "zz-and", p.on ? "zz-then" : "zz-else", base, map[p.k], { "zz-key": p.on })}>',
      '    <span className={`zz-tpl ${p.on ? "zz-alone" : ""} px-${p.k}`} />',
      '    <i className="zz-plain mt-4" />',
      '    <a className={buttonClass("primary", "zz-button")} />',
      '    {[{ pillClassName: "zz-prop" }].length}',
      "  </div>",
      ");",
    ].join("\n"),
  );
  const plantedFound = new Set(planted.tokens.map((t) => t.token).filter((t) => !defined.has(t)));
  const expected = ["zz-const", "zz-map", "zz-cn", "zz-and", "zz-then", "zz-else", "zz-key", "zz-tpl", "zz-alone", "zz-plain", "zz-button", "zz-prop"];
  check(
    "the extractor catches a planted undefined class in every shape it reads",
    expected.every((t) => plantedFound.has(t)) && plantedFound.size === expected.length,
    `found ${[...plantedFound].sort().join(" ")}`,
  );
  check("a glued interpolation is skipped, not guessed", planted.skipped.some((s) => s.kind === "interpolated into a token"));

  const files = sourceFiles(path.join(repoRoot, "src"));
  const tokens: Token[] = [];
  const skipped: Skip[] = [];
  for (const file of files) {
    const r = extract(path.relative(repoRoot, file), readFileSync(file, "utf8"));
    tokens.push(...r.tokens);
    skipped.push(...r.skipped);
  }
  check(`read class names in src/ (${files.length} files, ${tokens.length} tokens)`, tokens.length > 1000);

  for (const [token, { readBy }] of Object.entries(BEHAVIOUR_CLASSES)) {
    const missing = readBy.filter((f) => {
      const abs = path.join(repoRoot, f);
      return !existsSync(abs) || !readFileSync(abs, "utf8").includes(token);
    });
    check(`behaviour class "${token}" is still read by ${readBy.join(", ")}`, missing.length === 0, missing.join(", "));
  }

  const undefinedTokens = tokens.filter((t) => !defined.has(t.token) && !(t.token in BEHAVIOUR_CLASSES));
  const byToken = new Map<string, string[]>();
  for (const t of undefinedTokens) byToken.set(t.token, [...(byToken.get(t.token) ?? []), `${t.file}:${t.line}`]);
  for (const [token, where] of [...byToken].sort(([a], [b]) => a.localeCompare(b))) {
    check(`class "${token}" is defined by Tailwind or globals.css`, false, where.join(", "));
  }
  check("every class a component asks for exists", undefinedTokens.length === 0, undefinedTokens.length ? `${byToken.size} undefined` : "");

  const kinds = new Map<string, number>();
  for (const s of skipped) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  console.log(
    `\nskipped ${skipped.length} expressions whose value is not in the source: ` +
      [...kinds].map(([k, n]) => `${n} ${k}`).join(", ") +
      (showSkipped ? "" : " (--show-skipped lists them)"),
  );
  if (showSkipped) for (const s of skipped) console.log(`  ${s.file}:${s.line}  [${s.kind}]  ${s.text}`);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
