// ESLint 9 flat config. Next 16 dropped `next lint`; eslint-config-next ships a
// flat config directly, so we consume it and run ESLint via the CLI.
import next from "eslint-config-next/core-web-vitals";

export default [
  ...next,
  // docs/CODE_STANDARDS.md R3 and R7 (CHE-415): no dangerouslySetInnerHTML,
  // no explicit `any`. scripts/verify-code-standards.ts holds R3 over the
  // syntax tree as well; the lint rule is the one an editor shows while typing.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    rules: { "react/no-danger": "error" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  // The one file written against CDP's untyped accessibility nodes before the
  // rule; its `any`s come off with a type for the node, not with a switch here.
  {
    files: ["src/agent/extension-replay.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "src/generated/**",
      "spikes/**",
      "generated-tests/**",
    ],
  },
];
