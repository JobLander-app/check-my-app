// Reading our own source as syntax, for the wiring checks of verify scripts.
// A regex over the text breaks on a reformat, or passes by accident on a
// comment that happens to match; the TypeScript compiler API answers the same
// questions — which calls exist, with which arguments, which JSX props are
// passed — from the parse tree.
//
// Usage:
//   const sf = source("src/agent/workflow.ts");
//   calls(sf).some((c) => c.callee === "noticeNewCauses");

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type Call = { callee: string; args: string[]; node: ts.CallExpression };
export type Jsx = { tag: string; props: Record<string, string>; guard: string | null; node: ts.JsxSelfClosingElement | ts.JsxOpeningElement };

export function source(rel: string): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), rel), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** Every call expression under `within` (the whole file by default). */
export function calls(sf: ts.SourceFile, within: ts.Node = sf): Call[] {
  const out: Call[] = [];
  walk(within, (n) => {
    if (ts.isCallExpression(n)) out.push({ callee: n.expression.getText(sf), args: n.arguments.map((a) => a.getText(sf)), node: n });
  });
  return out;
}

/**
 * Every JSX element in the file: its tag, its props as source text (a string
 * literal keeps its quotes), and the expression it is rendered behind
 * (`{guard && <Tag/>}`), if any.
 */
export function jsx(sf: ts.SourceFile): Jsx[] {
  const out: Jsx[] = [];
  walk(sf, (n) => {
    if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
    const props: Record<string, string> = {};
    for (const p of n.attributes.properties) {
      if (!ts.isJsxAttribute(p) || !p.initializer) continue;
      const init = p.initializer;
      props[p.name.getText(sf)] = ts.isJsxExpression(init) ? (init.expression?.getText(sf) ?? "") : init.getText(sf);
    }
    const element = ts.isJsxOpeningElement(n) ? n.parent : n;
    const parent = element.parent;
    const guard =
      parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? parent.left.getText(sf) : null;
    out.push({ tag: n.tagName.getText(sf), props, guard, node: n });
  });
  return out;
}

/** Every `a[b]` / `a?.[b]` in the file, as [object, index] source text. */
export function elementAccesses(sf: ts.SourceFile): [string, string][] {
  const out: [string, string][] = [];
  walk(sf, (n) => {
    if (ts.isElementAccessExpression(n)) out.push([n.expression.getText(sf), n.argumentExpression.getText(sf)]);
  });
  return out;
}

/** The initializer of `const name = …` anywhere in the file. */
export function initializerOf(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  walk(sf, (n) => {
    if (!found && ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) found = n.initializer;
  });
  return found;
}

/** `key: value` properties of object literals in the file, value as source text. */
export function properties(sf: ts.SourceFile, key: string): string[] {
  const out: string[] = [];
  walk(sf, (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === key) out.push(n.initializer.getText(sf));
  });
  return out;
}

/** Positions in the file of JSX text that contains `text`. */
export function jsxTextAt(sf: ts.SourceFile, text: string): number[] {
  const out: number[] = [];
  walk(sf, (n) => {
    if (ts.isJsxText(n) && n.getText(sf).includes(text)) out.push(n.getStart(sf));
  });
  return out;
}
