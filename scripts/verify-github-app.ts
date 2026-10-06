// CHE-369: the GitHub App. This proves, with a real D1 (Miniflare) and a fake
// GitHub, no network:
//
//   1. the signature: a body signed with the secret passes, a changed body, a
//      wrong secret or a missing header does not;
//   2. the App's identity: the PKCS#1 key GitHub issues imports (wrapped as
//      PKCS#8) and the JWT it signs verifies with the matching public key;
//   3. one delivery, one effect: a redelivery (same X-GitHub-Delivery) is a
//      no-op; two `success` statuses of one deployment start one run; a
//      status that is not success, a repository nobody mapped, a policy of
//      "off", a non-production environment, a suspended installation — none
//      starts anything;
//   4. the answer on the commit: a started run opens an in-progress Check
//      Run; a refused start (balance, already running) leaves a neutral one
//      that says why; when the run ends the Check Run completes with the
//      verdict's conclusion, and its title carries the price and never a
//      cost;
//   5. installation events: suspend/unsuspend, repositories added/removed,
//      deleted.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-github-app.ts

import "./fixtures/wasm-module-loader.mjs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { realD1 } from "./fixtures/real-d1";
import {
  answerGitHub,
  appJwt,
  checkRunOutput,
  checkRunTitle,
  conclusionFor,
  deploymentWanted,
  installationIsFresh,
  isProductionEnv,
  parseDeploymentStatus,
  signBody,
  signatureMatches,
  toPkcs8,
  type Fetch,
} from "../src/lib/github-app";
import { handleDelivery, refusalTitle, syncInstallationRepos, type WebhookDeps } from "../src/lib/github-webhook";
import { OFFERED_POLICIES, mappingFromForm, priceLine, saveRepoMapping, teamGitHub } from "../src/lib/github-mapping";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ─── 1. Signature ───────────────────────────────────────────────────────────

async function signature() {
  const body = JSON.stringify({ action: "created", deployment: { id: 1 } });
  const sig = await signBody(body, "s3cret");
  check("a body signed with the secret passes", await signatureMatches(body, sig, "s3cret"));
  check("a changed body does not", !(await signatureMatches(body + " ", sig, "s3cret")));
  check("a wrong secret does not", !(await signatureMatches(body, sig, "other")));
  check("a missing header does not", !(await signatureMatches(body, null, "s3cret")));
  check("a header without the sha256= prefix does not", !(await signatureMatches(body, sig.slice(7), "s3cret")));
}

// ─── 2. The App's identity ──────────────────────────────────────────────────

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function identity(keys: ReturnType<typeof keyPair>) {
  const wrapped = toPkcs8(keys.pkcs1);
  const nodePkcs8 = Buffer.from(keys.pkcs8.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  check("a PKCS#1 key wrapped as PKCS#8 is byte for byte what Node exports", Buffer.from(wrapped).equals(nodePkcs8), `${wrapped.length} vs ${nodePkcs8.length} bytes`);
  const jwt = await appJwt({ GITHUB_APP_ID: "5203150", GITHUB_APP_PRIVATE_KEY: keys.pkcs1 }, Date.parse("2026-10-06T00:00:00Z"));
  const [h, p, s] = jwt.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  eq("the JWT names the App and a nine-minute window from a minute ago", [JSON.parse(Buffer.from(h, "base64url").toString()).alg, payload.iss, payload.exp - payload.iat], ["RS256", "5203150", 600]);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  check("…and its signature verifies with the public key", verifier.verify(keys.publicPem, Buffer.from(s, "base64url")));
  const jwt8 = await appJwt({ GITHUB_APP_ID: "5203150", GITHUB_APP_PRIVATE_KEY: keys.pkcs8 });
  check("a PKCS#8 key works as it is", jwt8.split(".").length === 3);
  const escaped = keys.pkcs1.replace(/\n/g, "\\n");
  check("a key pasted with literal \\n (a secret typed on one line) still imports", (await appJwt({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: escaped })).split(".").length === 3);
}

// ─── 3–5. Deliveries against a real D1 and a fake GitHub ────────────────────

interface FakeGitHub {
  fetch: Fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
  checkRuns: Map<number, { status: string; conclusion?: string; output: { title: string; summary: string; text?: string } }>;
  failNext: boolean;
  truncated: boolean;
}

function fakeGitHub(): FakeGitHub {
  const gh: FakeGitHub = { calls: [], checkRuns: new Map(), failNext: false, truncated: false, fetch: async () => new Response() };
  let nextCheckRun = 100;
  gh.fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    gh.calls.push({ method, path, body });
    if (gh.failNext) {
      gh.failNext = false;
      return new Response("boom", { status: 502 });
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) return Response.json({ token: `ghs_${path.split("/")[3]}` });
    if (/^\/app\/installations\/\d+$/.test(path)) return Response.json({ id: Number(path.split("/")[3]), account: { login: "acme", type: "Organization" }, created_at: new Date().toISOString() });
    if (path.startsWith("/installation/repositories")) {
      // `gh.truncated`: GitHub says three, lists two, then an empty page.
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      const all = [{ id: 11, full_name: "acme/shop" }, { id: 12, full_name: "acme/site" }];
      return Response.json({ total_count: gh.truncated ? 3 : 2, repositories: page === 1 ? all : [] });
    }
    const create = /^\/repos\/([^/]+\/[^/]+)\/check-runs$/.exec(path);
    if (create && method === "POST") {
      const id = nextCheckRun++;
      gh.checkRuns.set(id, { status: body.status, conclusion: body.conclusion, output: body.output });
      return Response.json({ id });
    }
    const patch = /^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)$/.exec(path);
    if (patch && method === "PATCH") {
      gh.checkRuns.set(Number(patch[2]), { status: body.status, conclusion: body.conclusion, output: body.output });
      return Response.json({ id: Number(patch[2]) });
    }
    return new Response("not found", { status: 404 });
  };
  return gh;
}

const ENV = { GITHUB_APP_ID: "5203150", GITHUB_APP_SLUG: "checkmyapp", GITHUB_APP_WEBHOOK_SECRET: "s3cret", GITHUB_APP_PRIVATE_KEY: "" };

function deploymentStatus(over: { state?: string; deploymentId?: number; environment?: string; repo?: string; repoId?: number; installationId?: number; sha?: string } = {}) {
  return {
    action: "created",
    deployment_status: { state: over.state ?? "success", environment_url: "https://shop.example" },
    deployment: { id: over.deploymentId ?? 500, environment: over.environment ?? "Production", sha: over.sha ?? "abcdef1234567890" },
    repository: { id: over.repoId ?? 11, full_name: over.repo ?? "acme/shop" },
    installation: { id: over.installationId ?? 777 },
  };
}

async function deliveries(keys: ReturnType<typeof keyPair>) {
  const real = await realD1();
  const gh = fakeGitHub();
  const triggered: string[] = [];
  const deps: WebhookDeps = { trigger: async (id) => void triggered.push(id), siteCap: () => 1000, fetch: gh.fetch, baseUrl: "https://checkmyapp.dev" };
  const env = { ...ENV, GITHUB_APP_PRIVATE_KEY: keys.pkcs1 };
  let n = 0;
  const deliver = (event: string, payload: unknown) => handleDelivery(real.db, env, { deliveryId: `d-${++n}`, event, payload }, deps);
  try {
    const { db } = real;
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "gh@example.test" } });
    await db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    await db.app.create({ data: { id: "a", teamId: "t", ownerId: "u", appSlug: "shop.example", targetUrl: "https://shop.example", targetKind: "website" } });
    await db.gitHubInstallation.create({ data: { id: "i", installationId: 777, accountLogin: "acme", accountType: "Organization", teamId: "t", connectedById: "u" } });
    await db.gitHubRepo.create({ data: { id: "r", installationId: "i", repoFullName: "acme/shop", repoId: 11, appId: "a", teamId: "t" } });
    await db.gitHubRepo.create({ data: { id: "r2", installationId: "i", repoFullName: "acme/site", repoId: 12, appId: null, teamId: "t" } });

    // 3. One delivery, one effect.
    eq("a ping is ignored", await deliver("ping", { zen: "hi" }), "ignored");
    eq("an in_progress status starts nothing", await deliver("deployment_status", deploymentStatus({ state: "in_progress" })), "not-wanted");
    eq("a preview environment starts nothing (previews come later)", await deliver("deployment_status", deploymentStatus({ environment: "Preview" })), "not-wanted");
    eq("a repository nobody mapped starts nothing", await deliver("deployment_status", deploymentStatus({ repo: "acme/site", repoId: 12 })), "not-wanted");
    eq("a repository the App never saw starts nothing", await deliver("deployment_status", deploymentStatus({ repo: "someone/else", repoId: 99 })), "unmapped");
    eq("nothing started so far", triggered.length, 0);

    eq("a successful production deploy starts the app's check", await deliver("deployment_status", deploymentStatus()), "started");
    eq("…one run, handed to the agent", triggered.length, 1);
    const run = await db.run.findFirst({ where: { appId: "a" }, select: { id: true, publicId: true, deploySha: true, deployEnv: true, startedVia: true, teamId: true, ownerId: true } });
    eq("…bound to the deploy, started by github, the installer's run for the team", [run?.deploySha, run?.deployEnv, run?.startedVia, run?.teamId, run?.ownerId], ["abcdef1234567890", "Production", "github", "t", "u"]);
    const claim = await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 500 } } });
    eq("…the deployment row holds the run and the Check Run", [claim?.runId === run?.id, claim?.githubCheckId, claim?.refusal], [true, 100, null]);
    const opened = gh.checkRuns.get(100)!;
    eq("…an in-progress Check Run opened on the commit", [opened.status, gh.calls.find((c) => c.path.endsWith("/check-runs"))?.body.head_sha, gh.calls.find((c) => c.path.endsWith("/check-runs"))?.body.name], ["in_progress", "abcdef1234567890", "CheckMyApp"]);
    check("…whose details link is the review", String(gh.calls.find((c) => c.path.endsWith("/check-runs"))?.body.details_url).endsWith(`/verdict/${run?.publicId}`));

    eq("the same success delivered again (same delivery id) is a no-op", await handleDelivery(db, env, { deliveryId: `d-${n}`, event: "deployment_status", payload: deploymentStatus() }, deps), "duplicate-delivery");
    // A delivery whose handler threw (the route answered 500) is on record
    // but unfinished; GitHub's retry of it is handled, not skipped.
    await db.gitHubDelivery.create({ data: { deliveryId: "d-retry", event: "installation" } });
    eq("a retried delivery that never finished is handled this time", await handleDelivery(db, env, { deliveryId: "d-retry", event: "installation", payload: { action: "suspend", installation: { id: 777 } } }, deps), "installation-updated");
    check("…and is now on record as finished", (await db.gitHubDelivery.findUnique({ where: { deliveryId: "d-retry" } }))?.handledAt !== null);
    await deliver("installation", { action: "unsuspend", installation: { id: 777 } });
    // A rename: the deploy names the new name, the mapping survives, the name follows.
    eq("a renamed repository is still the mapped one (by GitHub's id)", await deliver("deployment_status", deploymentStatus({ repo: "acme/shop-renamed", deploymentId: 500 })), "duplicate-deployment");
    eq("…and the row now carries the new name", (await db.gitHubRepo.findUnique({ where: { id: "r" } }))?.repoFullName, "acme/shop-renamed");
    await db.gitHubRepo.update({ where: { id: "r" }, data: { repoFullName: "acme/shop" } });
    eq("a second success status of the same deployment (new delivery id) starts no second run", await deliver("deployment_status", deploymentStatus()), "duplicate-deployment");
    eq("…still one run", triggered.length, 1);
    eq("…and one Check Run", gh.checkRuns.size, 1);

    // 4. A refused start answers neutral and says why.
    // The app's check is still running: the next deploy is not checked separately.
    eq("a new deploy while a check of the app is running", await deliver("deployment_status", deploymentStatus({ deploymentId: 501, sha: "1111111111111111" })), "refused");
    const busy = await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 501 } } });
    check("…is recorded with its reason and no run", busy?.runId === null && /already running/.test(busy?.refusal ?? ""), busy?.refusal ?? "");
    const neutral = gh.checkRuns.get(busy!.githubCheckId!)!;
    eq("…and its Check Run completes neutral, naming the reason", [neutral.status, neutral.conclusion, neutral.output.title.startsWith("Not checked — ")], ["completed", "neutral", true]);
    eq("still one run", triggered.length, 1);

    // The run ends: the Check Run completes with the verdict.
    await db.run.update({ where: { id: run!.id }, data: { status: "completed", verdict: "needs_attention", bottomLine: "The checkout opens in German.", priceUsd: 0.61, costUsd: 0.2, completedAt: new Date() } });
    await db.finding.create({ data: { runId: run!.id, number: 1, title: "Checkout in German", category: "confusing", severity: "high", detail: "{}" } });
    eq("the ended run answers on the commit", await answerGitHub(db, env, run!.id, { baseUrl: "https://checkmyapp.dev", fetch: gh.fetch }), "answered");
    const done = gh.checkRuns.get(100)!;
    eq("…completed, neutral for needs_attention, with the verdict's words and the price", [done.status, done.conclusion, done.output.title], ["completed", "neutral", "Needs attention · 1 finding · $0.61"]);
    check("…the summary is the bottom line with the review link", done.output.summary.startsWith("The checkout opens in German.") && done.output.summary.includes(`/verdict/${run?.publicId}`));
    check("…the findings are listed", done.output.text?.includes("Checkout in German") === true);
    check("…and nothing on the commit says what the check cost us", !JSON.stringify(done).includes("0.2") && !/cost/i.test(JSON.stringify(done.output)));
    eq("a run no deploy started is not GitHub's business", await answerGitHub(db, env, "no-such-run", { baseUrl: "https://checkmyapp.dev", fetch: gh.fetch }), "not-a-deploy");

    // GitHub down when the run starts: the run still starts, the answer waits.
    await db.run.update({ where: { id: run!.id }, data: { status: "completed" } });
    gh.failNext = true;
    eq("GitHub unreachable at the start: the run still starts", await deliver("deployment_status", deploymentStatus({ deploymentId: 502, sha: "2222222222222222" })), "started");
    eq("…two runs now", triggered.length, 2);
    const noCheck = await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 502 } } });
    eq("…with no Check Run recorded yet", noCheck?.githubCheckId, null);
    await db.run.update({ where: { id: noCheck!.runId! }, data: { status: "completed", verdict: "all_good", bottomLine: "Fine.", priceUsd: 0.04 } });
    eq("…and when the run ends, the answer opens the Check Run itself, completed", await answerGitHub(db, env, noCheck!.runId!, { baseUrl: "https://checkmyapp.dev", fetch: gh.fetch }), "created");
    const late = await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 502 } } });
    const lateRun = gh.checkRuns.get(late!.githubCheckId!);
    eq("…on the deploy's commit, success, with the price", [lateRun?.status, lateRun?.conclusion, lateRun?.output.title, gh.calls.at(-1)?.body?.head_sha], ["completed", "success", "All good · nothing to fix · $0.04", "2222222222222222"]);

    // The hand-off to the agent throws after the run row exists (the route
    // answers 500, GitHub retries): the claim already names its run, so the
    // retry does not read that run as "another check already running".
    await db.run.updateMany({ where: { appId: "a" }, data: { status: "completed" } });
    const failingTrigger: WebhookDeps = { ...deps, trigger: async () => { throw new Error("workflow binding unavailable"); } };
    let threw = false;
    try {
      await handleDelivery(db, env, { deliveryId: "d-trigger", event: "deployment_status", payload: deploymentStatus({ deploymentId: 506, sha: "6666666666666666" }) }, failingTrigger);
    } catch {
      threw = true;
    }
    const bound = await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 506 } } });
    check("a hand-off that throws: the delivery fails (500) …", threw);
    check("…but the claim already names the run it created", bound?.runId !== null && bound?.refusal === null, JSON.stringify(bound));
    eq("…and GitHub's retry finds the claim finished, not a refusal", await handleDelivery(db, env, { deliveryId: "d-trigger", event: "deployment_status", payload: deploymentStatus({ deploymentId: 506, sha: "6666666666666666" }) }, deps), "duplicate-deployment");
    eq("…the claim still names that run, no refusal written", [(await db.gitHubDeploymentCheck.findUnique({ where: { id: bound!.id } }))?.runId === bound?.runId, (await db.gitHubDeploymentCheck.findUnique({ where: { id: bound!.id } }))?.refusal], [true, null]);
    await db.run.updateMany({ where: { appId: "a" }, data: { status: "completed" } });

    // The first attempt threw between the claim and the run (the route
    // answered 500): GitHub's retry resumes the claim instead of skipping it.
    await db.run.updateMany({ where: { appId: "a" }, data: { status: "completed" } });
    await db.gitHubDeploymentCheck.create({ data: { repoId: "r", deploymentId: 505, environment: "Production", sha: "5555555555555555" } });
    eq("an unfinished claim is resumed on redelivery", await deliver("deployment_status", deploymentStatus({ deploymentId: 505, sha: "5555555555555555" })), "started");
    eq("…three runs now, the resumed one bound to its deploy", [triggered.length, (await db.gitHubDeploymentCheck.findUnique({ where: { repoId_deploymentId: { repoId: "r", deploymentId: 505 } } }))?.runId !== null], [3, true]);
    await db.run.updateMany({ where: { appId: "a" }, data: { status: "completed" } });

    // A full sync whose listing stopped short deletes nothing.
    gh.truncated = true;
    await db.gitHubRepo.create({ data: { id: "r9", installationId: "i", repoFullName: "acme/beyond", repoId: 99, appId: "a", teamId: "t" } });
    await syncInstallationRepos(db, env, 777, gh.fetch);
    eq("a truncated listing keeps the mappings it did not reach", await db.gitHubRepo.count({ where: { id: "r9" } }), 1);
    gh.truncated = false;
    await syncInstallationRepos(db, env, 777, gh.fetch);
    eq("a complete listing removes what the App no longer sees", await db.gitHubRepo.count({ where: { id: "r9" } }), 0);

    // A failed run closes neutral and says nothing about why.
    await db.run.update({ where: { id: run!.id }, data: { status: "failed", errorMessage: "internal: LLM budget exhausted" } });
    await answerGitHub(db, env, run!.id, { baseUrl: "https://checkmyapp.dev", fetch: gh.fetch });
    const failed = gh.checkRuns.get(100)!;
    eq("a failed run closes its Check Run neutral", [failed.conclusion, failed.output.title], ["neutral", "The check did not finish — nothing was charged"]);
    check("…and the commit never learns why", !/budget|LLM|internal/i.test(JSON.stringify(failed.output)));

    // Policy and suspension.
    await db.gitHubRepo.update({ where: { id: "r" }, data: { policy: "off" } });
    eq("policy off: a production deploy starts nothing", await deliver("deployment_status", deploymentStatus({ deploymentId: 503 })), "not-wanted");
    await db.gitHubRepo.update({ where: { id: "r" }, data: { policy: "production" } });
    await db.run.updateMany({ where: { appId: "a" }, data: { status: "completed" } });
    eq("suspend: recorded", await deliver("installation", { action: "suspend", installation: { id: 777 } }), "installation-updated");
    eq("a suspended installation starts nothing", await deliver("deployment_status", deploymentStatus({ deploymentId: 504 })), "suspended");
    eq("unsuspend: recorded", await deliver("installation", { action: "unsuspend", installation: { id: 777 } }), "installation-updated");
    eq("an unknown installation's events are ignored", await deliver("installation", { action: "suspend", installation: { id: 1 } }), "ignored");

    // 5. Repositories added and removed.
    eq("repositories added", await deliver("installation_repositories", { action: "added", installation: { id: 777 }, repositories_added: [{ id: 13, full_name: "acme/new" }], repositories_removed: [] }), "repos-updated");
    eq("…the row exists, unmapped", (await db.gitHubRepo.findUnique({ where: { installationId_repoId: { installationId: "i", repoId: 13 } } }))?.appId, null);
    eq("repositories removed", await deliver("installation_repositories", { action: "removed", installation: { id: 777 }, repositories_added: [], repositories_removed: [{ id: 13, full_name: "acme/new" }] }), "repos-updated");
    eq("…the row is gone", await db.gitHubRepo.count({ where: { repoFullName: "acme/new" } }), 0);
    eq("a mapping survives a re-list", (await db.gitHubRepo.findUnique({ where: { id: "r" } }))?.appId, "a");
    eq("installation deleted", await deliver("installation", { action: "deleted", installation: { id: 777 } }), "installation-removed");
    eq("…its repositories and deployment rows go with it", [await db.gitHubInstallation.count(), await db.gitHubRepo.count(), await db.gitHubDeploymentCheck.count()], [0, 0, 0]);
    eq("…the runs stay", await db.run.count({ where: { appId: "a" } }), 4);
    eq("every delivery is on record (the n numbered ones plus d-retry and d-trigger), all finished", [await db.gitHubDelivery.count(), await db.gitHubDelivery.count({ where: { handledAt: null } })], [n + 2, 0]);

    // 6. Part B: the mapping the team sets on Integrations.
    await db.team.create({ data: { id: "o", name: "Other", plan: "business" } });
    await db.app.create({ data: { id: "oa", teamId: "o", ownerId: "u", appSlug: "other.example", targetUrl: "https://other.example", targetKind: "website" } });
    await db.gitHubInstallation.create({ data: { id: "i2", installationId: 888, accountLogin: "acme", accountType: "Organization", teamId: "t", connectedById: "u" } });
    await db.gitHubInstallation.create({ data: { id: "io", installationId: 999, accountLogin: "other", accountType: "User", teamId: "o", connectedById: "u" } });
    await db.gitHubRepo.create({ data: { id: "m1", installationId: "i2", repoFullName: "acme/shop", repoId: 11, teamId: "t" } });
    await db.gitHubRepo.create({ data: { id: "mo", installationId: "io", repoFullName: "other/repo", repoId: 21, teamId: "o" } });
    eq("map a repository to the team's app, every production deploy", await saveRepoMapping(db, "t", { repoId: "m1", appId: "a", policy: "production" }), { ok: true, repoFullName: "acme/shop", appSlug: "shop.example" });
    eq("…stored", (await db.gitHubRepo.findUnique({ where: { id: "m1" } }))?.appId, "a");
    eq("another team's repository is refused", await saveRepoMapping(db, "t", { repoId: "mo", appId: "a", policy: "production" }), { error: "That repository is not connected to this team." });
    eq("another team's app is refused", await saveRepoMapping(db, "t", { repoId: "m1", appId: "oa", policy: "production" }), { error: "That app is not one of this team's." });
    eq("…and the row kept its app", (await db.gitHubRepo.findUnique({ where: { id: "m1" } }))?.appId, "a");
    eq("unmap: an empty app clears it", (await saveRepoMapping(db, "t", { repoId: "m1", appId: null, policy: "off" })) as unknown, { ok: true, repoFullName: "acme/shop", appSlug: null });
    const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    eq("form: production with an app", mappingFromForm(form({ repoId: "m1", appId: "a", policy: "production" })), { repoId: "m1", appId: "a", policy: "production" });
    eq("form: previews are not offered yet", mappingFromForm(form({ repoId: "m1", appId: "a", policy: "all" })), { error: "Choose when this repository's deploys are checked." });
    eq("form: no repository", mappingFromForm(form({ appId: "a", policy: "off" })), { error: "No repository was named." });
    await saveRepoMapping(db, "t", { repoId: "m1", appId: "a", policy: "production" });
    const gh2 = await teamGitHub(db, { id: "t", plan: "business" });
    eq("the screen sees the team's installations only", gh2.installations.map((i) => i.accountLogin).sort(), ["acme"]);
    eq("…its repositories with their mapping", gh2.installations.flatMap((i) => i.repos.map((r) => [r.repoFullName, r.appId, r.policy])), [["acme/shop", "a", "production"]]);
    eq("…the team's apps only, each with its price line", gh2.apps.map((a) => a.appSlug), ["shop.example"]);
    check("…an app with under three checks shows the plan's typical range", /^a check is typically \$\d+\.\d\d–\$\d+\.\d\d$/.test(gh2.apps[0].priceLine), gh2.apps[0].priceLine);
  } finally {
    await real.dispose();
  }
}

// ─── Pure tables ────────────────────────────────────────────────────────────

function tables() {
  eq("parse: the fields a deployment_status carries", parseDeploymentStatus(deploymentStatus())?.deploymentId, 500);
  eq("parse: not a deployment", parseDeploymentStatus({ zen: "x" }), null);
  eq("production env matches case-insensitively, by list", [isProductionEnv("production", "production,Production"), isProductionEnv("PROD", "prod, live"), isProductionEnv("preview", "production")], [true, true, false]);
  const repo = { policy: "production", productionEnvs: "production", appId: "a" };
  eq("wanted: success on production", deploymentWanted(parseDeploymentStatus(deploymentStatus({ environment: "production" }))!, repo), "production");
  eq("wanted: failure is not", deploymentWanted(parseDeploymentStatus(deploymentStatus({ state: "failure", environment: "production" }))!, repo), null);
  eq("conclusions", ["broken", "all_good", "mostly_ok", "needs_attention", "unverified", null].map((v) => conclusionFor({ status: "completed", verdict: v })), ["failure", "success", "neutral", "neutral", "neutral", "neutral"]);
  eq("a run that did not finish is neutral whatever it says", conclusionFor({ status: "failed", verdict: "broken" }), "neutral");
  const run = { publicId: "p", status: "completed", verdict: "all_good", bottomLine: "Fine.", priceUsd: 0.04, findings: [] };
  eq("title: clean run", checkRunTitle(run), "All good · nothing to fix · $0.04");
  eq("title: free run shows no price", checkRunTitle({ ...run, priceUsd: 0 }), "All good · nothing to fix");
  eq("refusal title", refusalTitle("Your team's balance is used up."), "Not checked — Your team's balance is used up");
  const out = checkRunOutput({ ...run, status: "failed" }, "https://checkmyapp.dev/verdict/p");
  check("a failed run's summary charges nothing and names the review", /Nothing was charged/.test(out.summary) && out.summary.includes("/verdict/p"));
  eq("price line: the app's own range, a single price, the plan's range", [
    priceLine({ low: 0.48, high: 0.8 }, { low: 0.3, high: 1.5 }),
    priceLine({ low: 0.61, high: 0.61 }, { low: 0.3, high: 1.5 }),
    priceLine(null, { low: 0.3, high: 1.5 }),
  ], ["usually $0.48–$0.80 a check", "usually $0.61 a check", "a check is typically $0.30–$1.50"]);
  eq("the switch offers production and off — previews arrive with their runs", [...OFFERED_POLICIES], ["production", "off"]);
  const now = Date.parse("2026-10-06T12:00:00Z");
  eq("a first claim binds only an installation GitHub made just now (the nonce's window plus slack)", [
    installationIsFresh({ created_at: "2026-10-06T11:52:00Z" }, now),
    installationIsFresh({ created_at: "2026-10-06T11:40:00Z" }, now),
    installationIsFresh({ created_at: "2026-10-05T12:00:00Z" }, now),
    installationIsFresh({ created_at: "not a date" }, now),
  ], [true, false, false, false]);
}

(async () => {
  const keys = keyPair();
  await signature();
  await identity(keys);
  tables();
  await deliveries(keys);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
