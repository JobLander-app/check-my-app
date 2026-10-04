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
import { holdsPrivateTarget, isPrivateTarget, PRIVATE_TARGET_MESSAGE } from "../src/lib/private-target";
import { createCheckSchema } from "../src/lib/validation";
import { createRecheckRun } from "../src/lib/recheck";
import { enableWatchForRun } from "../src/lib/watch-enable";
import { startSavedApp } from "../src/lib/start-saved-app";

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
  "https://198.18.0.1", // benchmarking — not routed (Codex P2 r3 on #237)
  "https://192.0.2.10", // documentation
  "https://203.0.113.7",
  "https://224.0.0.1", // multicast
  "https://255.255.255.255",
  "http://localhost.:3000", // the root dot does not make it public
  "https://my-macbook.local.",
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
  "https://198.17.255.1",
  "https://198.20.0.1",
  "https://192.0.3.1",
  "https://223.255.255.1",
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
check("localhost:3000 is told why, not that it is no URL", refusal("localhost:3000") === PRIVATE_TARGET_MESSAGE && PRIVATE_TARGET_MESSAGE !== "Doesn't look like a working URL", String(refusal("localhost:3000")));
check("a public address still passes", refusal("checkmyapp.dev") === null && refusal("https://8.8.8.8") === null);
check("a word that is no address keeps its own message", refusal("hello") === "Doesn't look like a working URL", String(refusal("hello")));
check("the url shape other doors reuse refuses it too (app settings, onboarding)",
  !createCheckSchema.shape.url.safeParse("https://10.0.0.5").success);

// The page an extension is opened on is a target as well (Codex P2 on #235).
const STORE = "https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop";
const companion = (companionUrl: string) => {
  const r = createCheckSchema.safeParse({ url: STORE, extension: { companionUrl } });
  return r.success ? null : r.error.issues[0]?.message ?? "";
};
check("an extension's companion page on a private address is refused with the same sentence",
  companion("https://192.168.1.2:3000") === PRIVATE_TARGET_MESSAGE, String(companion("https://192.168.1.2:3000")));
check("…and a public companion page still passes", companion("https://example.com/app") === null, String(companion("https://example.com/app")));

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

// ── 3. What was accepted before the doors refused it ────────────────────────
// Codex P1 on #237: a check, an app or a watch that already holds a private
// address never passes the schema again — the verdict's Re-check button, Enable
// Daily Watch, a saved app's Run and the scheduler copy the stored address. Runs
// #291–#293 are exactly that. Each path refuses before it writes or starts
// anything.
const PRIVATE_URL = "https://192.168.0.197:53317";
function stubDb(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const db = new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, op: string) => async () => {
        calls.push(`${model}.${op}`);
        return answers[`${model}.${op}`] ?? null;
      },
    }),
  });
  return { db: db as never, calls };
}

async function persisted() {
  const triggered: string[] = [];
  const trigger = async (id: string) => void triggered.push(id);

  const re = stubDb({ "run.findUnique": { id: "r292", targetUrl: PRIVATE_URL, appSlug: "192.168.0.197:53317", ownerId: "u1", teamId: "t1", team: { plan: "free" }, status: "completed" } });
  const rechecked = await createRecheckRun(re.db, "pub_292", {}, {}, {
    canMutate: async () => true, trigger, siteCap: () => 20, now: () => new Date(), ephemeralTtlDays: () => 7,
  });
  check("re-check of a check on a private address is refused with the sentence, and nothing is created or started",
    rechecked.kind === "quota" && rechecked.reason === PRIVATE_TARGET_MESSAGE && rechecked.code === "private_target" &&
      re.calls.join() === "run.findUnique" && triggered.length === 0,
    `${JSON.stringify(rechecked)} · ${re.calls.join()}`);

  const en = stubDb({ "run.findUnique": { id: "r292", ownerId: "u1", appSlug: "192.168.0.197:53317", targetUrl: PRIVATE_URL, targetKind: "website", ephemeral: false } });
  const enabled = await enableWatchForRun(en.db, { id: "u1", teamId: "t1", plan: "free" }, { runPublicId: "pub_292", frequency: "daily", notifyOnChangeOnly: true });
  check("Enable Daily Watch on that check is refused before an app or a watch is written",
    enabled.kind === "gated" && enabled.reason === PRIVATE_TARGET_MESSAGE && en.calls.join() === "run.findUnique",
    `${JSON.stringify(enabled)} · ${en.calls.join()}`);

  const sv = stubDb({ "app.findFirst": { id: "a1", ownerId: "u1", teamId: "t1", targetUrl: PRIVATE_URL, appSlug: "192.168.0.197:53317", targetKind: "website" } });
  const saved = await startSavedApp(sv.db, { id: "u1", teamId: "t1", plan: "free" }, "a1", { trigger, siteCap: () => 20 });
  check("a saved app on a private address does not start",
    "error" in saved && saved.error === PRIVATE_TARGET_MESSAGE && sv.calls.join() === "app.findFirst" && triggered.length === 0,
    `${JSON.stringify(saved)} · ${sv.calls.join()}`);

  // Codex P1 r2 on #237: a stored extension's target is the public store link;
  // what the check opens is its companion page.
  const STORE_APP = { id: "a2", ownerId: "u1", teamId: "t1", targetUrl: STORE, appSlug: "extension:abc", targetKind: "extension" };
  const companionCfg = (companionUrl: string) => JSON.stringify({ companionUrl });
  check("holdsPrivateTarget: a public store link with a private companion page is private; with a public one it is not",
    holdsPrivateTarget({ targetUrl: STORE, extensionConfig: companionCfg("https://192.168.1.2:3000") }) &&
      !holdsPrivateTarget({ targetUrl: STORE, extensionConfig: companionCfg("https://example.com/app") }) &&
      !holdsPrivateTarget({ targetUrl: STORE, extensionConfig: null }) && !holdsPrivateTarget({ targetUrl: STORE, extensionConfig: "not json" }));
  const svx = stubDb({ "app.findFirst": { ...STORE_APP, extensionConfig: companionCfg("https://192.168.1.2:3000") } });
  const savedExt = await startSavedApp(svx.db, { id: "u1", teamId: "t1", plan: "free" }, "a2", { trigger, siteCap: () => 20 });
  check("a saved extension whose companion page is private does not start",
    "error" in savedExt && savedExt.error === PRIVATE_TARGET_MESSAGE && svx.calls.join() === "app.findFirst", `${JSON.stringify(savedExt)} · ${svx.calls.join()}`);
  const rex = stubDb({ "run.findUnique": { id: "r9", targetUrl: STORE, targetKind: "extension", extensionConfig: companionCfg("http://localhost:3000"), appSlug: "extension:abc", ownerId: "u1", teamId: "t1", team: { plan: "free" }, status: "completed" } });
  const recheckedExt = await createRecheckRun(rex.db, "pub_9", {}, {}, { canMutate: async () => true, trigger, siteCap: () => 20, now: () => new Date(), ephemeralTtlDays: () => 7 });
  check("a re-check of an extension check whose companion page is private starts nothing",
    recheckedExt.kind === "quota" && rex.calls.join() === "run.findUnique" && triggered.length === 0, `${JSON.stringify(recheckedExt)} · ${rex.calls.join()}`);

  const scheduler = read("src/agent/scheduler.ts");
  const loop = scheduler.slice(scheduler.indexOf("for (const watch of due)"), scheduler.indexOf("const inFlight"));
  check("the scheduler skips a watch on a private address before it creates a run", /if \(isPrivateTarget\(watch\.targetUrl\)\) \{[\s\S]*?continue;/.test(loop));
}

persisted().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
