// An address on somebody's own network is refused before a check starts.
//
// Run #292 (2026-10-02): a new account's first check was pointed at
// https://192.168.0.197:53317. It was accepted, priced at $0.28 and reported as
// the owner's "Broken" app, for a page we could never have opened.
//
//   1. isPrivateTarget: private, loopback and link-local addresses in every
//      spelling the URL parser accepts, and the names that only resolve at
//      home; public addresses right next to each range are not caught.
//   2. Every door validates a target with createCheckSchema's `url` — the
//      form's API, the paid one-off check, app settings and onboarding, MCP —
//      so the schema is where it is refused, with a sentence that says what to
//      paste instead and names none of our machinery (CLAUDE.md §1).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-private-target.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateTarget, PRIVATE_TARGET_MESSAGE } from "../src/lib/private-target";
import { createCheckSchema } from "../src/lib/validation";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ── 1. The rule ─────────────────────────────────────────────────────────────
const PRIVATE = [
  "https://192.168.0.197:53317", // run #292, as pasted
  "http://192.168.1.1",
  "https://10.0.0.5:8080/app",
  "https://172.16.0.1",
  "https://172.31.255.254",
  "http://127.0.0.1:3000",
  "http://127.1", // short form of 127.0.0.1
  "http://2130706433", // 127.0.0.1 as one number
  "http://0x7f.0.0.1",
  "http://0.0.0.0:8000",
  "https://169.254.169.254/latest/meta-data", // link-local
  "https://100.64.0.1", // carrier-grade NAT
  "http://localhost:3000",
  "http://app.localhost:3000",
  "https://my-macbook.local:5173",
  "https://build.internal",
  "https://nas.lan",
  "http://[::1]:3000",
  "http://[fd12:3456:789a::1]",
  "http://[fe80::1]",
  "http://[::ffff:192.168.0.197]",
];
const PUBLIC = [
  "https://checkmyapp.dev",
  "https://192.169.0.1",
  "https://172.32.0.1",
  "https://172.15.255.255",
  "https://11.0.0.1",
  "https://100.63.255.255",
  "https://100.128.0.1",
  "https://169.253.1.1",
  "https://8.8.8.8",
  "https://localhost.example.com",
  "https://local.example.com",
  "https://internal-tools.example.com",
  "https://mylan.io",
  "https://[2606:4700:4700::1111]",
  "https://[::ffff:8.8.8.8]",
];
for (const u of PRIVATE) check(`private: ${u}`, isPrivateTarget(u));
for (const u of PUBLIC) check(`public: ${u}`, !isPrivateTarget(u));
check("not an address at all is another rule's refusal, not this one's", !isPrivateTarget("not a url"));

// ── 2. The doors ────────────────────────────────────────────────────────────
const refusal = (url: string) => {
  const r = createCheckSchema.safeParse({ url });
  return r.success ? null : r.error.issues[0]?.message ?? "";
};
check("the schema refuses run #292's address as it was pasted, with the sentence", refusal("https://192.168.0.197:53317") === PRIVATE_TARGET_MESSAGE, String(refusal("https://192.168.0.197:53317")));
check("…and without a scheme, as people paste it", refusal("192.168.0.197:53317") === PRIVATE_TARGET_MESSAGE, String(refusal("192.168.0.197:53317")));
check("localhost:3000 is told why, not that it is no URL", refusal("localhost:3000") === PRIVATE_TARGET_MESSAGE, String(refusal("localhost:3000")));
check("a public address still passes", refusal("checkmyapp.dev") === null && refusal("https://8.8.8.8") === null);
check("a word that is no address keeps its own message", refusal("hello") === "Doesn't look like a working URL", String(refusal("hello")));
check("the url shape other doors reuse refuses it too (app settings, onboarding)",
  !createCheckSchema.shape.url.safeParse("https://10.0.0.5").success);

check("the sentence says what to paste and names none of our machinery",
  /Paste the public address/.test(PRIVATE_TARGET_MESSAGE) && !/\b(browser|server|cloud|bot|crawler|our|we)\b/i.test(PRIVATE_TARGET_MESSAGE), PRIVATE_TARGET_MESSAGE);

// Every door that takes a target goes through the schema: nothing in src
// starts a check from a raw address.
for (const [door, file] of [
  ["POST /api/checks", "src/app/api/checks/route.ts"],
  ["the paid one-off check", "src/app/api/billing/one-check/route.ts"],
  ["app settings and onboarding", "src/lib/app-settings.ts"],
  ["MCP start_check / create_app", "src/lib/mcp/tools.ts"],
] as const) {
  check(`${door} validates its target with createCheckSchema`, /createCheckSchema(\.shape\.url)?\.safeParse\(/.test(read(file)));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
