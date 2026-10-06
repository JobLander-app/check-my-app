// The GitHub App "checkmyapp" (CHE-369): install once, and every successful
// deploy of a mapped repository checks the app it deploys and answers on the
// commit as a Check Run — no YAML. The Action (CHE-368) is the same contract
// for people who want a step in their own workflow.
//
// Shared by the web worker (the webhook and the install callback) and the
// agent worker (the answer when a run ends), so nothing here imports anything
// Next-only. Every request to GitHub goes through the `fetch` the caller
// passes, so the verify script runs the whole flow with no network.
//
// What the customer reads here — the Check Run's title, summary and text — is
// customer-facing copy (CLAUDE.md §1, §10): the verdict's own words, the price
// of the check, never what it cost us.

import type { PrismaClient } from "@/generated/prisma/client";
import { VERDICT_META } from "@/lib/status";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface GitHubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  // What GitHub signs every delivery with (X-Hub-Signature-256).
  GITHUB_APP_WEBHOOK_SECRET?: string;
  // The App's private key, PEM, as GitHub issued it (PKCS#1, "RSA PRIVATE
  // KEY") or PKCS#8 ("PRIVATE KEY") — both are accepted.
  GITHUB_APP_PRIVATE_KEY?: string;
}

export function getGitHubAppEnv(env: Record<string, unknown>): GitHubAppEnv {
  return {
    GITHUB_APP_ID: env.GITHUB_APP_ID as string | undefined,
    GITHUB_APP_SLUG: env.GITHUB_APP_SLUG as string | undefined,
    GITHUB_APP_WEBHOOK_SECRET: env.GITHUB_APP_WEBHOOK_SECRET as string | undefined,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY as string | undefined,
  };
}

// The App can sign and answer only with all three; the slug is for the install
// link alone.
export function appConfigured(env: GitHubAppEnv): env is Required<Pick<GitHubAppEnv, "GITHUB_APP_ID" | "GITHUB_APP_WEBHOOK_SECRET" | "GITHUB_APP_PRIVATE_KEY">> & GitHubAppEnv {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_WEBHOOK_SECRET && env.GITHUB_APP_PRIVATE_KEY);
}

// The CSRF nonce the install start sets and the callback checks.
export const GITHUB_INSTALL_NONCE_COOKIE = "github_install_nonce";

export function installUrl(slug: string, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export const GITHUB_API = "https://api.github.com";
export const CHECK_RUN_NAME = "CheckMyApp";
export const USER_AGENT = "checkmyapp (+https://checkmyapp.dev)";

// ─── Webhook signature ──────────────────────────────────────────────────────

export const SIGNATURE_HEADER = "X-Hub-Signature-256";
export const EVENT_HEADER = "X-GitHub-Event";
export const DELIVERY_HEADER = "X-GitHub-Delivery";

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA256 of the raw body, compared in constant time: the comparison
// takes the same number of steps whatever the guess.
export async function signatureMatches(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const given = header.slice("sha256=".length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// For the verify script and the "Redeliver" rehearsal: what GitHub would send.
export async function signBody(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)))}`;
}

// ─── The App's own identity: a JWT signed with its private key ──────────────

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const u8 = typeof bytes === "string" ? encoder.encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemBody(pem: string): { label: string; der: Uint8Array } {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM");
  const bin = atob(m[2].replace(/\s+/g, ""));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { label: m[1], der };
}

// DER length: short form below 128, else 0x80 | byte count, then the bytes.
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// GitHub issues the key as PKCS#1 ("RSA PRIVATE KEY"); WebCrypto imports only
// PKCS#8. PKCS#8 is the PKCS#1 blob inside a fixed envelope:
//   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
export function toPkcs8(pem: string): Uint8Array {
  const { label, der } = pemBody(pem);
  if (label === "PRIVATE KEY") return der;
  if (label !== "RSA PRIVATE KEY") throw new Error(`GITHUB_APP_PRIVATE_KEY: unexpected PEM label "${label}"`);
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(der.length)];
  const inner = 1 + 2 + algorithm.length + octet.length + der.length; // INTEGER 0 is 02 01 00
  const out = new Uint8Array([0x30, ...derLength(inner), 0x02, 0x01, 0x00, ...algorithm, ...octet]);
  const result = new Uint8Array(out.length + der.length);
  result.set(out, 0);
  result.set(der, out.length);
  return result;
}

async function privateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = toPkcs8(pem);
  return crypto.subtle.importKey("pkcs8", pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength) as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// RS256, issued a minute in the past (GitHub rejects a clock that is ahead),
// valid nine minutes (the maximum is ten).
export async function appJwt(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string }, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 600, iss: env.GITHUB_APP_ID }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await privateKey(env.GITHUB_APP_PRIVATE_KEY), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubAppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

async function api<T>(fetchImpl: Fetch, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new GitHubAppError(res.status, `GitHub ${method} ${path} → ${res.status} ${text}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// An installation token: what acts on the repositories of one installation
// (one hour, scoped to the App's permissions there).
export async function installationToken(
  env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string },
  installationId: number,
  fetchImpl: Fetch,
): Promise<string> {
  const r = await api<{ token: string }>(fetchImpl, await appJwt(env), "POST", `/app/installations/${installationId}/access_tokens`);
  return r.token;
}

export interface InstallationRepo {
  id: number;
  full_name: string;
}

// Every repository the installation may see, page by page.
export async function installationRepos(token: string, fetchImpl: Fetch): Promise<InstallationRepo[]> {
  const out: InstallationRepo[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api<{ repositories: InstallationRepo[]; total_count: number }>(fetchImpl, token, "GET", `/installation/repositories?per_page=100&page=${page}`);
    out.push(...r.repositories.map((x) => ({ id: x.id, full_name: x.full_name })));
    if (out.length >= r.total_count || r.repositories.length === 0) break;
  }
  return out;
}

export interface InstallationInfo {
  id: number;
  account: { login: string; type: string };
}

export async function installationInfo(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string }, installationId: number, fetchImpl: Fetch): Promise<InstallationInfo> {
  return api<InstallationInfo>(fetchImpl, await appJwt(env), "GET", `/app/installations/${installationId}`);
}

// Turns the App's webhook on (it was registered inactive until the route
// existed). Idempotent.
export async function activateWebhook(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string }, fetchImpl: Fetch): Promise<void> {
  await api(fetchImpl, await appJwt(env), "PATCH", "/app/hook/config", { active: true });
}

// ─── What a delivery says ───────────────────────────────────────────────────

export interface DeploymentStatusEvent {
  action: string;
  state: string;
  deploymentId: number;
  environment: string;
  environmentUrl: string | null;
  sha: string;
  repoFullName: string;
  repoId: number;
  installationId: number | null;
}

// The fields this product reads from a `deployment_status` delivery; null for
// a body that is not one.
export function parseDeploymentStatus(payload: unknown): DeploymentStatusEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    action?: unknown;
    deployment_status?: { state?: unknown; environment_url?: unknown };
    deployment?: { id?: unknown; environment?: unknown; sha?: unknown };
    repository?: { id?: unknown; full_name?: unknown };
    installation?: { id?: unknown };
  };
  const state = p.deployment_status?.state;
  const id = p.deployment?.id;
  const sha = p.deployment?.sha;
  const fullName = p.repository?.full_name;
  const repoId = p.repository?.id;
  if (typeof state !== "string" || typeof id !== "number" || typeof sha !== "string" || typeof fullName !== "string" || typeof repoId !== "number") return null;
  return {
    action: typeof p.action === "string" ? p.action : "",
    state,
    deploymentId: id,
    environment: typeof p.deployment?.environment === "string" ? p.deployment.environment : "",
    environmentUrl: typeof p.deployment_status?.environment_url === "string" ? p.deployment_status.environment_url : null,
    sha,
    repoFullName: fullName,
    repoId,
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
  };
}

export function isProductionEnv(environment: string, productionEnvs: string): boolean {
  const names = productionEnvs.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.includes(environment.trim().toLowerCase());
}

export type RepoPolicy = "production" | "all" | "off";
export const REPO_POLICIES: readonly RepoPolicy[] = ["production", "all", "off"];

// Whether this deployment is one the repository's policy checks.
export function deploymentWanted(event: DeploymentStatusEvent, repo: { policy: string; productionEnvs: string; appId: string | null }): "production" | "preview" | null {
  if (!repo.appId || repo.policy === "off") return null;
  if (event.state !== "success") return null;
  if (isProductionEnv(event.environment, repo.productionEnvs)) return "production";
  // Previews come with the next PR (ephemeral runs, CHE-202); until then a
  // policy of "all" checks production only and says so on the settings screen.
  return null;
}

// ─── The answer on the commit ───────────────────────────────────────────────

export type CheckConclusion = "success" | "neutral" | "failure";

// The verdict → the Check Run's conclusion. Broken fails the commit; a verdict
// with something to look at is neutral (the owner decides, not the robot);
// clean is green. A run that did not finish is neutral: our failure never
// reads as theirs (rule 4), and never blocks their merge.
export function conclusionFor(run: { status: string; verdict: string | null }): CheckConclusion {
  if (run.status !== "completed" && run.status !== "partial") return "neutral";
  if (run.verdict === "broken") return "failure";
  if (run.verdict === "all_good") return "success";
  return "neutral";
}

export interface AnswerRun {
  publicId: string;
  status: string;
  verdict: string | null;
  bottomLine: string | null;
  priceUsd: number | null;
  findings: Array<{ title: string; severity: string; category: string }>;
}

export function reviewUrl(baseUrl: string, publicId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/verdict/${publicId}`;
}

// "Mostly OK · 2 findings · $0.61" — the label the product gives the verdict,
// how many problems, the price of the check (§10: the price, never the cost).
export function checkRunTitle(run: AnswerRun): string {
  if (run.status !== "completed" && run.status !== "partial") return "The check did not finish — nothing was charged";
  const label = run.verdict ? (VERDICT_META[run.verdict]?.label ?? run.verdict) : "Checked";
  const n = run.findings.length;
  const parts = [label, n === 0 ? "nothing to fix" : `${n} finding${n === 1 ? "" : "s"}`];
  if (run.priceUsd !== null && run.priceUsd > 0) parts.push(`$${run.priceUsd.toFixed(2)}`);
  return parts.join(" · ");
}

export function checkRunOutput(run: AnswerRun, url: string): { title: string; summary: string; text?: string } {
  const title = checkRunTitle(run);
  if (run.status !== "completed" && run.status !== "partial") {
    return { title, summary: `The check of this deploy did not finish on our side. Nothing was charged. Start it again from ${url} or wait for the next deploy.` };
  }
  const summary = `${run.bottomLine ?? ""}\n\n[Open the review](${url})`.trim();
  const text = run.findings.length
    ? run.findings.map((f) => `- **${f.severity.toUpperCase()}** · ${f.category} — ${f.title}`).join("\n")
    : undefined;
  return { title, summary, ...(text ? { text } : {}) };
}

export interface CheckRunRef {
  id: number;
}

export async function createCheckRun(
  token: string,
  repoFullName: string,
  input: { headSha: string; detailsUrl: string; status: "in_progress" | "completed"; conclusion?: CheckConclusion; output: { title: string; summary: string; text?: string } },
  fetchImpl: Fetch,
): Promise<CheckRunRef> {
  const r = await api<{ id: number }>(fetchImpl, token, "POST", `/repos/${repoFullName}/check-runs`, {
    name: CHECK_RUN_NAME,
    head_sha: input.headSha,
    details_url: input.detailsUrl,
    status: input.status,
    ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    output: input.output,
  });
  return { id: r.id };
}

export async function completeCheckRun(
  token: string,
  repoFullName: string,
  checkRunId: number,
  input: { conclusion: CheckConclusion; detailsUrl: string; output: { title: string; summary: string; text?: string } },
  fetchImpl: Fetch,
): Promise<void> {
  await api(fetchImpl, token, "PATCH", `/repos/${repoFullName}/check-runs/${checkRunId}`, {
    status: "completed",
    conclusion: input.conclusion,
    details_url: input.detailsUrl,
    output: input.output,
  });
}

// ─── The answer when a run ends (the agent worker) ──────────────────────────

// Finds the deploy this run was started for and completes its Check Run. A
// run with no deploy row (not started by the App) is not GitHub's business:
// nothing happens. Never throws for GitHub's sake — the caller logs.
export async function answerGitHub(
  db: PrismaClient,
  env: GitHubAppEnv,
  runId: string,
  opts: { baseUrl: string; fetch: Fetch },
): Promise<"answered" | "not-a-deploy" | "unconfigured" | "no-check-run"> {
  const deploy = await db.gitHubDeploymentCheck.findFirst({
    where: { runId },
    select: { id: true, checkRunId: true, repo: { select: { repoFullName: true, installation: { select: { installationId: true } } } } },
  });
  if (!deploy) return "not-a-deploy";
  if (!appConfigured(env)) return "unconfigured";
  if (deploy.checkRunId === null) return "no-check-run";
  const run = await db.run.findUnique({
    where: { id: runId },
    select: {
      publicId: true,
      status: true,
      verdict: true,
      bottomLine: true,
      priceUsd: true,
      findings: { select: { title: true, severity: true, category: true }, orderBy: { number: "asc" } },
    },
  });
  if (!run) return "not-a-deploy";
  const url = reviewUrl(opts.baseUrl, run.publicId);
  const token = await installationToken(env, deploy.repo.installation.installationId, opts.fetch);
  await completeCheckRun(token, deploy.repo.repoFullName, deploy.checkRunId, { conclusion: conclusionFor(run), detailsUrl: url, output: checkRunOutput(run, url) }, opts.fetch);
  return "answered";
}
