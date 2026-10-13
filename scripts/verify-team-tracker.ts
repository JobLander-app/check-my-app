// CHE-469 verification: a tracker is connected once per team, on a real D1
// (Miniflare, every migration applied — 0076 among them).
//
// The owner, 2026-10-13: "integrations are team wide, if there is integration
// connected to one app, lets use it, dont ask second time".
//
//   1. adoption: the shapes prod had on the day — one Jira site connected
//      twice, one Linear workspace three times, another team's Jira beside
//      them — become one connection per team and kind, holding the freshest
//      grant, with every row of that team pointing at it; a second read
//      writes nothing; another team's rows are never touched;
//   2. a second app files into the team's Jira with no consent: choosing a
//      project is enough, and the tracker it files with carries the team's token;
//   3. one grant: a refresh through one app is the refresh every app sees —
//      Jira and Linear — with no second refresh;
//   4. the expand step: a row the previous release refreshed is taken back
//      into the connection, and a row it created is linked; an older row
//      never overwrites a newer grant;
//   5. a reconnect from one app keeps every other app's project where the new
//      grant reaches it, unsets it where it does not, and retires the links
//      of a site the grant no longer reaches;
//   6. disconnect is the team's: the grant and every row go, in-flight links
//      are retired, the other kind and the other team stay;
//   7. an app with no team keeps its own grant;
//   8. one place: every token read and write in the product goes through
//      connection.ts, token.ts and jira.ts — filing, reconciling and the pages
//      reach tokens only through trackerFor and the connection.
//
// Usage: npm run verify:team-tracker

process.env.CREDENTIALS_SECRET ??= "verify-team-tracker-secret";

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realD1 } from "./fixtures/real-d1";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { connectionGrant, disconnectTeamTracker, grantFor, putConnection, teamConnection, teamConnections } from "../src/lib/tracker/connection";
import { chooseJiraProject, connectJira } from "../src/lib/tracker/jira-connect";
import { chooseLinearTeam } from "../src/lib/tracker/linear-connect";
import { trackerFor } from "../src/lib/tracker/factory";
import { freshLinearToken } from "../src/lib/tracker/token";
import { JiraTracker } from "../src/lib/tracker/jira";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

// Atlassian, as far as these flows ask it.
function fakeAtlassian() {
  const calls: { url: string; grant: string | null; auth: string | null }[] = [];
  const state = {
    tokens: 0,
    sites: [{ id: "cloud-1", url: "https://otpcloud.atlassian.net", name: "otpcloud", scopes: ["read:jira-work", "write:jira-work"] }],
    projects: { "cloud-1": [{ key: "SEC", name: "Securify" }, { key: "OTPPLUS", name: "OTP+" }, { key: "OPS", name: "Ops" }] } as Record<string, { key: string; name: string }[]>,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, grant: body?.grant_type ?? null, auth: new Headers(init?.headers).get("Authorization") });
    if (url === "https://auth.atlassian.com/oauth/token") {
      state.tokens++;
      return json(200, { access_token: `at-${state.tokens}`, refresh_token: `rt-${state.tokens}`, expires_in: 3600 });
    }
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(200, state.sites);
    const search = url.match(/\/ex\/jira\/([^/]+)\/rest\/api\/3\/project\/search/);
    if (search) return json(200, { values: state.projects[search[1]] ?? [], isLast: true });
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

const enc = encryptSecret;
const at = (iso: string) => new Date(iso);
const JIRA_CREDS = { clientId: "cid", clientSecret: "sec" };

async function main() {
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "u1", clerkUserId: "ck1", email: "owner@otp.test" } });
    await db.team.create({ data: { id: "tA", name: "Owner", plan: "business" } });
    await db.team.create({ data: { id: "tB", name: "Someone else", plan: "business" } });
    const app = (id: string, teamId: string | null) =>
      db.app.create({ data: { id, teamId, ownerId: "u1", appSlug: `${id}.test`, targetUrl: `https://${id}.test`, targetKind: "website" } });
    for (const id of ["sec", "otp", "cma", "jl", "ext", "fresh", "ops", "web"]) await app(id, "tA");
    await app("b1", "tB");
    await app("lone", null);

    // ── 1. adoption, on the day's prod shapes ────────────────────────────────
    const row = (appId: string, type: string, teamId: string, token: string, expires: string, site: string | null = null) =>
      db.trackerIntegration.create({
        data: { appId, type, teamId, externalOrg: site ?? "Workspace", externalUrl: site ? "https://otpcloud.atlassian.net" : null, accessTokenEnc: enc(token), refreshTokenEnc: enc(`r-${token}`), tokenExpiresAt: at(expires) },
      });
    await row("sec", "jira", "SEC", "J1", "2026-10-13T18:19:52Z", "cloud-1");
    await row("otp", "jira", "OTPPLUS", "J2", "2026-10-13T18:16:36Z", "cloud-1");
    await row("cma", "linear", "lin-cma", "L1", "2026-10-14T01:43:12Z");
    await row("jl", "linear", "lin-jl", "L2", "2026-10-12T21:45:50Z");
    await row("ext", "linear", "lin-jl", "L3", "2026-10-02T16:03:11Z");
    await row("b1", "jira", "BEE", "B1", "2030-01-01T00:00:00Z", "cloud-b");

    const mine = await teamConnections(db, "tA");
    eq("adoption: one Jira and one Linear connection for the team, each the freshest grant",
      [mine.jira && decryptSecret(mine.jira.accessTokenEnc), mine.linear && decryptSecret(mine.linear.accessTokenEnc)], ["J1", "L1"]);
    const rows = await db.trackerIntegration.findMany({ orderBy: { appId: "asc" } });
    const of = (appId: string) => rows.find((r) => r.appId === appId)!;
    check("adoption: every row of the team points at its kind's connection",
      ["sec", "otp"].every((a) => of(a).connectionId === mine.jira!.id) && ["cma", "jl", "ext"].every((a) => of(a).connectionId === mine.linear!.id));
    eq("adoption: …and carries its tokens while the old columns live", ["sec", "otp", "cma", "jl", "ext"].map((a) => decryptSecret(of(a).accessTokenEnc)), ["J1", "J1", "L1", "L1", "L1"]);
    eq("adoption: …and keeps where its own tickets go", ["sec", "otp", "cma", "jl", "ext"].map((a) => of(a).teamId), ["SEC", "OTPPLUS", "lin-cma", "lin-jl", "lin-jl"]);
    eq("adoption: another team's row is not linked, and keeps its own grant", [of("b1").connectionId, decryptSecret(of("b1").accessTokenEnc)], [null, "B1"]);
    eq("adoption: there is one connection per team and kind, and none for the other team yet", await db.trackerConnection.count(), 2);

    const stamp = async () => JSON.stringify([
      (await db.trackerConnection.findMany({ orderBy: { id: "asc" } })).map((c) => c.updatedAt.toISOString()),
      (await db.trackerIntegration.findMany({ orderBy: { id: "asc" } })).map((r) => r.updatedAt.toISOString()),
    ]);
    const before = await stamp();
    await new Promise((r) => setTimeout(r, 20));
    await teamConnections(db, "tA");
    check("adoption: a second read writes nothing", (await stamp()) === before);

    const theirs = await teamConnection(db, "tB", "jira");
    check("adoption: the other team's own read makes its own connection, from its own grant",
      theirs !== null && theirs.teamId === "tB" && decryptSecret(theirs.accessTokenEnc) === "B1" && theirs.id !== mine.jira!.id);
    eq("adoption: …and a team with no tracker of a kind has no connection of it", await teamConnection(db, "tB", "linear"), null);

    // ── 2. a second app files into the team's Jira with no consent ──────────
    const atl = fakeAtlassian();
    await putConnection(db, "tA", "jira", { accessTokenEnc: enc("J1"), refreshTokenEnc: enc("r-J1"), tokenExpiresAt: new Date(Date.now() + 3600_000) });
    eq("second app: choosing a project is enough", await chooseJiraProject(db, "fresh", "cloud-1/SEC", JIRA_CREDS, atl.fetchImpl), "chosen");
    check("second app: …no consent, no code exchange, no refresh happened", atl.calls.every((c) => !c.url.startsWith("https://auth.atlassian.com")), atl.calls.map((c) => c.url).join(" "));
    check("second app: …the grant it reached projects with is the team's", atl.calls.filter((c) => c.url.includes("api.atlassian.com")).every((c) => c.auth === "Bearer J1"));
    const fresh = (await db.trackerIntegration.findUnique({ where: { appId: "fresh" } }))!;
    eq("second app: its row files into the team's Jira, in the project chosen", [fresh.type, fresh.connectionId === mine.jira!.id, fresh.teamId, fresh.externalOrg], ["jira", true, "SEC", "cloud-1"]);
    const filer = await trackerFor(db, fresh, { linear: {}, jira: JIRA_CREDS }, atl.fetchImpl);
    check("second app: the tracker it files with is Jira, on the team's token", filer instanceof JiraTracker && (filer as unknown as { accessToken: string }).accessToken === "J1");
    eq("second app: a project the team's grant does not reach is refused", await chooseJiraProject(db, "fresh", "cloud-9/NOPE", JIRA_CREDS, atl.fetchImpl), "unknown_choice");
    eq("second app: an app of a team with no Jira is told so", await chooseJiraProject(db, "lone", "cloud-1/SEC", JIRA_CREDS, atl.fetchImpl), "not_jira");
    await putConnection(db, "tA", "linear", { accessTokenEnc: enc("L1"), refreshTokenEnc: enc("r-L1"), tokenExpiresAt: new Date(Date.now() + 3600_000) });
    const asked: string[] = [];
    const workspace = async (token: string) => (asked.push(token), [{ id: "lin-web", name: "Web (as Linear names it)" }, { id: "lin-cma", name: "Check My App" }]);
    const linearCreds = { clientId: "lid", clientSecret: "lsec" };
    eq("second app: a team the grant does not reach is refused (a picker from before a reconnect)",
      [(await chooseLinearTeam(db, "web", "lin-gone", linearCreds, workspace)).outcome, await db.trackerIntegration.count({ where: { appId: "web" } })], ["unknown_choice", 0]);
    eq("second app: the same for Linear: a team with Linear lets any app choose its team", (await chooseLinearTeam(db, "web", "lin-web", linearCreds, workspace)).outcome, "chosen");
    const web = (await db.trackerIntegration.findUnique({ where: { appId: "web" } }))!;
    eq("second app: …and it files with the team's Linear grant, under the name Linear gives",
      [web.type, web.connectionId === mine.linear!.id, decryptSecret(web.accessTokenEnc), web.externalOrg, asked.every((t) => t === "L1")], ["linear", true, "L1", "Web (as Linear names it)", true]);
    await db.trackerIntegration.delete({ where: { appId: "web" } });

    // ── 3. one grant, one refresh ───────────────────────────────────────────
    await putConnection(db, "tA", "jira", { accessTokenEnc: enc("J1"), refreshTokenEnc: enc("r-J1"), tokenExpiresAt: new Date(Date.now() + 60_000) });
    const refresher = fakeAtlassian();
    const secRow = (await db.trackerIntegration.findUnique({ where: { appId: "sec" } }))!;
    const otpRow = (await db.trackerIntegration.findUnique({ where: { appId: "otp" } }))!;
    const viaSec = await trackerFor(db, secRow, { linear: {}, jira: JIRA_CREDS }, refresher.fetchImpl);
    const viaOtp = await trackerFor(db, otpRow, { linear: {}, jira: JIRA_CREDS }, refresher.fetchImpl);
    eq("one grant: a refresh through one app is what the next app files with — one refresh, one token",
      [refresher.state.tokens, (viaSec as unknown as { accessToken: string }).accessToken, (viaOtp as unknown as { accessToken: string }).accessToken], [1, "at-1", "at-1"]);
    const afterRefresh = await db.trackerIntegration.findMany({ where: { type: "jira", app: { teamId: "tA" } } });
    check("one grant: …and every row of the team mirrors the rotated tokens", afterRefresh.every((r) => decryptSecret(r.accessTokenEnc) === "at-1" && decryptSecret(r.refreshTokenEnc!) === "rt-1"));
    check("one grant: …the other team's grant is untouched", decryptSecret((await teamConnection(db, "tB", "jira"))!.accessTokenEnc) === "B1");

    // Linear, through its own refresh (Linear is asked through the global fetch).
    await putConnection(db, "tA", "linear", { accessTokenEnc: enc("L1"), refreshTokenEnc: enc("r-L1"), tokenExpiresAt: new Date(Date.now() + 60_000) });
    const realFetch = globalThis.fetch;
    let linearRefreshes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.linear.app/oauth/token") {
        linearRefreshes++;
        return new Response(JSON.stringify({ access_token: `lin-at-${linearRefreshes}`, refresh_token: `lin-rt-${linearRefreshes}`, expires_in: 86400 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      const creds = { clientId: "lid", clientSecret: "lsec" };
      const viaCma = await freshLinearToken(db, await grantFor(db, (await db.trackerIntegration.findUnique({ where: { appId: "cma" } }))!, "linear"), creds);
      const viaExt = await freshLinearToken(db, await grantFor(db, (await db.trackerIntegration.findUnique({ where: { appId: "ext" } }))!, "linear"), creds);
      eq("one grant: Linear too — the app that was a month stale files with the token another app just renewed", [linearRefreshes, viaCma, viaExt], [1, "lin-at-1", "lin-at-1"]);
    } finally {
      globalThis.fetch = realFetch;
    }

    // ── 4. the expand step ───────────────────────────────────────────────────
    // The previous release refreshes a row's own columns (it knows nothing else).
    await db.trackerIntegration.update({ where: { appId: "otp" }, data: { accessTokenEnc: enc("old-code"), refreshTokenEnc: enc("r-old-code"), tokenExpiresAt: new Date(Date.now() + 7200_000) } });
    const taken = await grantFor(db, (await db.trackerIntegration.findUnique({ where: { appId: "sec" } }))!, "jira");
    eq("expand: a row the previous release refreshed is taken back into the connection", decryptSecret(taken.accessTokenEnc), "old-code");
    eq("expand: …and mirrored onto the other rows, so the previous release reads it too", decryptSecret((await db.trackerIntegration.findUnique({ where: { appId: "sec" } }))!.accessTokenEnc), "old-code");
    // A row it created during the window: not linked yet.
    await db.trackerIntegration.create({ data: { appId: "ops", type: "jira", teamId: "OPS", externalOrg: "cloud-1", accessTokenEnc: enc("stale"), refreshTokenEnc: enc("r-stale"), tokenExpiresAt: new Date(Date.now() - 3600_000) } });
    const linked = await teamConnection(db, "tA", "jira");
    const ops = (await db.trackerIntegration.findUnique({ where: { appId: "ops" } }))!;
    eq("expand: a row the previous release created is linked on the next read", ops.connectionId, linked!.id);
    eq("expand: …and an older grant never overwrites the team's newer one", [decryptSecret(linked!.accessTokenEnc), decryptSecret(ops.accessTokenEnc)], ["old-code", "old-code"]);

    // ── 5. a reconnect keeps what it still reaches ───────────────────────────
    await db.trackerIntegration.create({ data: { appId: "web", type: "jira", teamId: "WEB", externalOrg: "cloud-2", externalUrl: "https://other.atlassian.net", accessTokenEnc: enc("x"), connectionId: linked!.id } });
    await db.issueLink.create({ data: { appId: "web", dedupKey: "k-web", externalIssueId: "WEB-1", status: "open" } });
    await db.issueLink.create({ data: { appId: "ops", dedupKey: "k-ops", externalIssueId: "OPS-1", status: "open" } });
    const narrower = fakeAtlassian();
    narrower.state.projects = { "cloud-1": [{ key: "SEC", name: "Securify" }, { key: "OTPPLUS", name: "OTP+" }] };
    eq("reconnect: from one app", await connectJira(db, { appId: "sec", code: "c", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, narrower.fetchImpl), "jira_connected");
    const byApp = async (appId: string) => (await db.trackerIntegration.findUnique({ where: { appId } }))!;
    eq("reconnect: the team's grant is the new one, on every row", [decryptSecret((await teamConnection(db, "tA", "jira"))!.accessTokenEnc), decryptSecret((await byApp("fresh")).accessTokenEnc)], ["at-1", "at-1"]);
    eq("reconnect: apps whose project the grant still reaches keep it", [(await byApp("sec")).teamId, (await byApp("otp")).teamId, (await byApp("fresh")).teamId], ["SEC", "OTPPLUS", "SEC"]);
    eq("reconnect: a project it does not reach files nowhere until chosen; its site and links stay", [(await byApp("ops")).teamId, (await byApp("ops")).externalOrg, (await db.issueLink.count({ where: { appId: "ops", status: "open" } }))], [null, "cloud-1", 1]);
    eq("reconnect: a site it does not reach is let go, with its links", [(await byApp("web")).teamId, (await byApp("web")).externalOrg, (await db.issueLink.count({ where: { appId: "web", status: "open" } }))], [null, null, 0]);

    // ── 6. disconnect is the team's ─────────────────────────────────────────
    const gone = await disconnectTeamTracker(db, "tA", "jira");
    eq("disconnect: names every app that stops filing", [...(gone ?? [])].sort(), ["fresh.test", "ops.test", "otp.test", "sec.test", "web.test"]);
    eq("disconnect: the grant and every row of it are gone", [await db.trackerConnection.count({ where: { teamId: "tA", type: "jira" } }), await db.trackerIntegration.count({ where: { type: "jira", app: { teamId: "tA" } } })], [0, 0]);
    eq("disconnect: in-flight links are retired to the ledger", [await db.issueLink.count({ where: { appId: "ops", status: "open" } }), await db.settledSignature.count({ where: { externalIssueId: "OPS-1", outcome: "superseded" } })], [0, 1]);
    check("disconnect: the team's Linear and the other team's Jira stay", (await teamConnection(db, "tA", "linear")) !== null && (await teamConnection(db, "tB", "jira")) !== null && (await byApp("b1")) !== null);
    eq("disconnect: nothing left to disconnect says so", await disconnectTeamTracker(db, "tA", "jira"), null);

    // ── 7. an app with no team ───────────────────────────────────────────────
    await db.trackerIntegration.create({ data: { appId: "lone", type: "linear", teamId: "x", accessTokenEnc: enc("own") } });
    const lone = await grantFor(db, (await byApp("lone"))!, "linear");
    eq("no team: an app that belongs to no team keeps its own grant", [lone.holder, decryptSecret(lone.accessTokenEnc)], ["integration", "own"]);
    check("connectionGrant: what a page passes is the connection itself", connectionGrant((await teamConnection(db, "tA", "linear"))!).holder === "connection");
  } finally {
    await real.dispose();
  }

  // ── 8. one place ───────────────────────────────────────────────────────────
  const walk = (dir: string): string[] =>
    readdirSync(path.join(repoRoot, dir)).flatMap((n) => {
      const rel = `${dir}/${n}`;
      if (rel === "src/generated") return [];
      return statSync(path.join(repoRoot, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
    });
  const src = walk("src");
  // Every file that decrypts an OAuth token, each with its reason. A new one —
  // a page or a job reading a tracker token on its own — fails here.
  const DECRYPTS: Record<string, string> = {
    "src/lib/tracker/token.ts": "the Linear grant, renewed",
    "src/lib/tracker/jira.ts": "the Jira grant, renewed",
    "src/lib/posthog/token.ts": "PostHog's own token, not a tracker's",
    "src/app/dashboard/actions.ts": "PostHog's tokens, revoked on disconnect",
  };
  const decrypts = src.filter((f) => /decryptSecret\([^)]*(accessTokenEnc|refreshTokenEnc)/.test(read(f)));
  const strays = decrypts.filter((f) => !(f in DECRYPTS));
  check("one place: a tracker token is decrypted only where it is renewed (token.ts, jira.ts)",
    strays.length === 0 && decrypts.length === Object.keys(DECRYPTS).length, strays.join(", ") || decrypts.join(", "));
  const rawWrites = src.filter((f) => f !== "src/lib/tracker/connection.ts" && /trackerIntegration\.(update|updateMany|upsert|create)\([\s\S]{0,400}?accessTokenEnc/.test(read(f)));
  check("one place: tracker tokens are written only by connection.ts", rawWrites.length === 0, rawWrites.join(", "));
  const filing = ["src/agent/autofile.ts", "src/agent/reconcile.ts", "src/app/api/findings/[id]/ticket/route.ts"];
  check("one place: filing, reconciling and Create Ticket reach a tracker only through trackerFor", filing.every((f) => /trackerFor\(/.test(read(f)) && !/freshLinearToken|freshJiraToken/.test(read(f))));
  check("one place: trackerFor takes the team's grant", /freshJiraToken\(db, await grantFor\(db, row, "jira"\)/.test(read("src/lib/tracker/factory.ts")) && /freshLinearToken\(db, await grantFor\(db, row, "linear"\)/.test(read("src/lib/tracker/factory.ts")));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
