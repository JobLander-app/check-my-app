// CHE-367 verification: the Release lens's data layer (src/lib/releases.ts).
//
// A release is a check we were told is a build (Run.deploySha). For each one:
// its app and env, sha, verdict, price, and what it broke, fixed and left
// unchanged against the previous release of the same app and env — matched by
// finding signature (CHE-354), "fixed" only where the release walked the
// journey again, and split by who would have hit it: existing (signed-in)
// users or new visitors. Owner, from the Goran call (2026-10-01, 24:45): «it's
// kinda tricky that it doesn't break for the existing customers».
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-releases.ts

import {
  audienceAt,
  computeReleases,
  isRelease,
  releaseEnv,
  type Release,
  type ReleaseRunInput,
} from "@/lib/releases";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ── Fixture: one app, two journeys ────────────────────────────────────────────
// "account": the walk signs in at step 0 (the fill carries the placeholder the
// agent records, never a real address), then checks the order page.
// "signup": an anonymous visitor on the sign-up page; actions recorded, no
// sign-in anywhere in it.
const SIGN_IN = JSON.stringify([
  { kind: "navigate", url: "https://shop.example/sign-in" },
  { kind: "fill", label: "Email", value: "{{TEST_EMAIL}}" },
  { kind: "fill", label: "Password", value: "{{TEST_PASSWORD}}" },
  { kind: "click", role: "button", name: "Sign in" },
]);
const ORDERS = JSON.stringify([{ kind: "navigate", url: "https://shop.example/orders" }]);
const SIGNUP = JSON.stringify([{ kind: "navigate", url: "https://shop.example/sign-up" }]);

type J = ReleaseRunInput["journeys"][number];
const account = (walked = true): J => ({
  identity: "aj_account",
  carried: !walked,
  walked,
  steps: [
    { status: "ok", actions: SIGN_IN },
    { status: "ok", actions: ORDERS },
  ],
});
const signup = (walked = true): J => ({
  identity: "aj_signup",
  carried: !walked,
  walked,
  steps: [{ status: "ok", actions: SIGNUP }],
});

// X: the order total is wrong — on the signed-in order page (account, step 1).
// Y: the sign-up button does nothing — on the anonymous sign-up page (signup, step 0).
const X = (n: number, title = "Order total ignores the discount") => ({
  id: `x-${n}`, title, category: "broken", severity: "high", mark: "none", signature: null,
  detail: JSON.stringify({ where: "/orders — order summary", whatHappened: "Total shows the full price." }),
  anchor: JSON.stringify({ stepRef: { journeyIndex: 0, stepIndex: 1 } }),
});
const Y = (n: number, title = "Sign-up button does nothing") => ({
  id: `y-${n}`, title, category: "broken", severity: "high", mark: "none", signature: null,
  detail: JSON.stringify({ where: "/sign-up — Create account button", whatHappened: "No request, no message." }),
  anchor: JSON.stringify({ stepRef: { journeyIndex: 1, stepIndex: 0 } }),
});

const at = (iso: string) => new Date(iso);
const base = { appId: "app_shop", appSlug: "shop.example", status: "completed", priceUsd: 0.6 };
const run = (o: Partial<ReleaseRunInput> & Pick<ReleaseRunInput, "runNumber" | "findings">): ReleaseRunInput => ({
  ...base,
  publicId: `pub_${o.runNumber}`,
  env: "production",
  sha: `sha${o.runNumber}`,
  verdict: o.findings.length ? "broken" : "all_good",
  completedAt: at(`2026-10-0${Math.min(9, Math.floor(o.runNumber / 10))}T1${o.runNumber % 10}:00:00Z`),
  journeys: [account(), signup()],
  ...o,
});

const RELEASES: ReleaseRunInput[] = [
  run({ runNumber: 10, findings: [] }), // first production release we checked
  run({ runNumber: 12, findings: [X(12), Y(12)] }), // broke X (existing users) and Y (new visitors)
  run({ runNumber: 13, env: "preview", sha: "pr-7", findings: [X(13)] }), // preview: its own line
  run({ runNumber: 14, findings: [Y(14, "Create account does nothing")] }), // fixed X; Y unchanged, reworded
  run({ runNumber: 16, findings: [Y(16)] }), // unchanged Y; nothing broke or fixed
  // Staging: #20 sees X and Y; #22 is a partial check that CARRIED the account
  // journey, so whether X is gone is unknown — not "fixed".
  run({ runNumber: 20, env: "staging", findings: [X(20), Y(20)] }),
  run({ runNumber: 22, env: "staging", journeys: [account(false), signup()], findings: [Y(22)] }),
];
const out = computeReleases(RELEASES);
const byRun = new Map(out.map((r) => [r.runNumber, r]));
// A missing release fails its checks instead of crashing the script.
const zero = { broke: 0, fixed: 0, unchanged: 0 };
const MISSING = { summary: { existing_users: zero, new_visitors: zero, unknown: zero } } as unknown as Release;
const release = (n: number): Release => byRun.get(n) ?? MISSING;

// ── 1. The feed ───────────────────────────────────────────────────────────────
check("every release is listed, newest first",
  JSON.stringify(out.map((r) => r.runNumber)) === JSON.stringify([22, 20, 16, 14, 13, 12, 10]),
  out.map((r) => `#${r.runNumber}`).join(" "));
const r10 = release(10);
check("the first production release says so: no previous, no delta",
  r10?.previous === null && r10?.delta === null && r10?.firstRelease === true);
check("a release carries price (priceUsd), never cost", r10?.priceUsd === 0.6 && !("costUsd" in (r10 ?? {})));

// ── 2. One broke X, one fixed X, one unchanged ────────────────────────────────
const titles = (xs: { title: string }[] | undefined) => (xs ?? []).map((x) => x.title).sort().join(" | ");
const r12 = release(12);
check("#12 against #10: broke X and Y", titles(r12.delta?.broke) === "Order total ignores the discount | Sign-up button does nothing",
  titles(r12.delta?.broke));
const r14 = release(14);
check("#14 against #12 (not the #13 preview): previous is #12", r14.previous?.runNumber === 12, String(r14.previous?.runNumber));
check("#14: fixed X (its journey was walked again and X was absent)", titles(r14.delta?.fixed) === "Order total ignores the discount",
  titles(r14.delta?.fixed));
check("#14: Y unchanged although reworded (same signature)", titles(r14.delta?.unchanged) === "Create account does nothing" &&
  (r14.delta?.broke.length ?? -1) === 0, `broke ${r14.delta?.broke.length}, unchanged ${titles(r14.delta?.unchanged)}`);
const r16 = release(16);
check("#16: nothing broke, nothing fixed, Y unchanged",
  r16.delta?.broke.length === 0 && r16.delta?.fixed.length === 0 && titles(r16.delta?.unchanged) === "Sign-up button does nothing");
const r22 = release(22);
check("#22 carried the account journey: X is not compared, not fixed; Y unchanged",
  r22.previous?.runNumber === 20 && r22.delta?.fixed.length === 0 && titles(r22.delta?.notCompared) === "Order total ignores the discount" &&
    titles(r22.delta?.unchanged) === "Sign-up button does nothing",
  `fixed ${titles(r22.delta?.fixed)} · notCompared ${titles(r22.delta?.notCompared)}`);
// The previous release must have LOOKED before something counts as broke.
const late = computeReleases([
  run({ runNumber: 30, journeys: [account(false), signup()], findings: [] }),
  run({ runNumber: 31, findings: [X(31)] }),
]).find((r) => r.runNumber === 31);
check("X seen now, but the previous release carried its journey → not compared, not broke",
  late?.delta?.broke.length === 0 && titles(late?.delta?.notCompared) === "Order total ignores the discount",
  `broke ${titles(late?.delta?.broke)} · notCompared ${titles(late?.delta?.notCompared)}`);

// ── 3. Preview vs production ──────────────────────────────────────────────────
const r13 = release(13);
check("the preview release is its own line: env preview, first preview release we checked",
  r13.env === "preview" && r13.firstRelease === true && r13.delta === null);
check("releaseEnv: deployEnv production / prod → production",
  releaseEnv({ deployEnv: "production", ephemeral: false }) === "production" && releaseEnv({ deployEnv: "Prod", ephemeral: false }) === "production");
check("releaseEnv: an ephemeral (PR preview) run → preview, whatever deployEnv says",
  releaseEnv({ deployEnv: null, ephemeral: true }) === "preview" && releaseEnv({ deployEnv: "production", ephemeral: true }) === "preview");
check("releaseEnv: staging / stage → staging; no deployEnv → production",
  releaseEnv({ deployEnv: "stage", ephemeral: false }) === "staging" && releaseEnv({ deployEnv: null, ephemeral: false }) === "production");
check("releaseEnv: anything else is kept as the caller named it", releaseEnv({ deployEnv: "qa-eu", ephemeral: false }) === "qa-eu");

// What counts as a release: a check we were told is a build. A scheduled check
// (no sha) is not one. Neither is an ephemeral check with no sha: `ephemeral`
// is the caller's choice ("don't make this an app"), and on prod it was used
// for three checks of a Shopify store that is not a build of anything (#281–283).
check("isRelease: a check with a deploy sha", isRelease({ deploySha: "abc123", ephemeral: false }));
check("isRelease: a scheduled check with no sha is not a release", !isRelease({ deploySha: null, ephemeral: false }));
check("isRelease: an ephemeral check with no sha is not a release (prod #281–283)", !isRelease({ deploySha: null, ephemeral: true }));
check("isRelease: an ephemeral PR preview with a sha is one", isRelease({ deploySha: "pr7sha", ephemeral: true }));

// ── 4. Existing users vs new visitors ─────────────────────────────────────────
const aud = (xs: { title: string; audience: string }[] | undefined) =>
  Object.fromEntries((xs ?? []).map((x) => [x.title, x.audience]));
check("#12: X broke for existing (signed-in) users, Y for new visitors",
  aud(r12.delta?.broke)["Order total ignores the discount"] === "existing_users" &&
    aud(r12.delta?.broke)["Sign-up button does nothing"] === "new_visitors",
  JSON.stringify(aud(r12.delta?.broke)));
check("#12 summary: broke 1 for existing users, 1 for new visitors",
  r12.summary.existing_users.broke === 1 && r12.summary.new_visitors.broke === 1, JSON.stringify(r12.summary));
check("#14 summary: fixed 1 for existing users; unchanged 1 for new visitors",
  r14.summary.existing_users.fixed === 1 && r14.summary.new_visitors.unchanged === 1, JSON.stringify(r14.summary));

check("audienceAt: a step after a sign-in in the same journey → existing_users", audienceAt(account().steps, 1) === "existing_users");
check("audienceAt: the sign-in step itself counts as signed in", audienceAt(account().steps, 0) === "existing_users");
check("audienceAt: actions recorded and no sign-in up to the step → new_visitors", audienceAt(signup().steps, 0) === "new_visitors");
check("audienceAt: a sign-in AFTER the step does not count",
  audienceAt([{ status: "ok", actions: SIGNUP }, { status: "ok", actions: SIGN_IN }], 0) === "new_visitors");
check("audienceAt: a skipped sign-in does not sign in",
  audienceAt([{ status: "skipped", actions: SIGN_IN }, { status: "ok", actions: ORDERS }], 1) === "new_visitors");
check("audienceAt: a named account ({{TEST_EMAIL:admin}}) signs in too",
  audienceAt([{ status: "ok", actions: JSON.stringify([{ kind: "fill", value: "{{TEST_EMAIL:admin}}" }]) }], 0) === "existing_users");
check("audienceAt: a journey with no recorded actions at all (before CHE-129) → unknown",
  audienceAt([{ status: "ok", actions: null }, { status: "ok", actions: null }], 1) === "unknown");

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
