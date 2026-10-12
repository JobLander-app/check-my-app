// CHE-438 verification: Jira as a tracker, against a fake Atlassian, on a real
// D1 (Miniflare).
//
//   1. consent: the authorize URL asks for the three scopes and the right audience;
//   2. callback: code → token → site → project, stored encrypted as the app's
//      integration of type "jira"; a reconnect keeps the chosen project;
//   3. refresh: an access token near expiry is refreshed and the rotated
//      refresh token stored; a refused refresh is "reconnect", not a crash;
//   4. JiraTracker: create (Bug, falling back to Task on 400), comment, and the
//      outcome map — open / done / canceled by resolution / missing on 404;
//      401 → reconnect;
//   5. the factory picks Jira for a jira row and Linear for a linear row.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-jira.ts

process.env.CREDENTIALS_SECRET ??= "verify-jira-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { JIRA_SCOPES, JiraAuthError, JiraTracker, buildJiraAuthorizeUrl, freshJiraToken } from "../src/lib/tracker/jira";
import { connectJira } from "../src/lib/tracker/jira-connect";
import { trackerFor } from "../src/lib/tracker/factory";
import { LinearTracker } from "../src/lib/tracker/linear";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

// The fake Atlassian: token endpoint, sites, projects, issues.
type Call = { url: string; method: string; body: unknown; auth: string | null };
function fakeAtlassian() {
  const calls: Call[] = [];
  const state = {
    tokenCount: 0,
    refuseRefresh: false,
    issues: new Map<string, { status: string; resolution: string | null }>(),
    noBug: false,
    unauthorized: false,
    projects: [{ key: "SEC", name: "Securify" }, { key: "OPS", name: "Ops" }],
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push({ url, method, body, auth });
    if (url === "https://auth.atlassian.com/oauth/token") {
      if (body.grant_type === "refresh_token" && state.refuseRefresh) return json(403, { error: "invalid_grant" });
      state.tokenCount++;
      return json(200, { access_token: `at-${state.tokenCount}`, refresh_token: `rt-${state.tokenCount}`, expires_in: 3600 });
    }
    if (state.unauthorized) return json(401, { message: "Unauthorized" });
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return json(200, [{ id: "cloud-1", url: "https://securify.atlassian.net/", name: "securify", scopes: ["read:jira-work", "write:jira-work"] }]);
    }
    const api = "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3";
    if (url.startsWith(`${api}/project/search`)) return json(200, { values: state.projects });
    if (url === `${api}/issue` && method === "POST") {
      if (state.noBug && body.fields.issuetype.name === "Bug") return json(400, { errors: { issuetype: "Specify a valid issue type" } });
      const key = `SEC-${state.issues.size + 1}`;
      state.issues.set(key, { status: "new", resolution: null });
      return json(201, { id: `${10000 + state.issues.size}`, key });
    }
    const commentMatch = url.match(/\/issue\/([A-Z]+-\d+)\/comment$/);
    if (commentMatch && method === "POST") return state.issues.has(commentMatch[1]) ? json(201, { id: "c1" }) : json(404, {});
    const issueMatch = url.match(/\/issue\/([A-Z]+-\d+)\?fields=/);
    if (issueMatch) {
      const issue = state.issues.get(issueMatch[1]);
      if (!issue) return json(404, { errorMessages: ["Issue does not exist"] });
      return json(200, { fields: { status: { statusCategory: { key: issue.status } }, resolution: issue.resolution ? { name: issue.resolution } : null } });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

async function main() {
  // 1.
  const url = new URL(buildJiraAuthorizeUrl({ clientId: "cid", redirectUri: "https://checkmyapp.dev/api/integrations/jira/callback", state: "s1" }));
  eq("consent: Atlassian's authorize endpoint with the API audience", [url.origin + url.pathname, url.searchParams.get("audience")], ["https://auth.atlassian.com/authorize", "api.atlassian.com"]);
  eq("consent: read, write and offline access — nothing more", url.searchParams.get("scope"), JIRA_SCOPES);
  check("consent: the state and redirect travel", url.searchParams.get("state") === "s1" && url.searchParams.get("redirect_uri")!.endsWith("/jira/callback"));

  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "u1", clerkUserId: "ck1", email: "admin@securify.test" } });
    await db.team.create({ data: { id: "t1", name: "Securify", plan: "business" } });
    await db.app.create({ data: { id: "a1", teamId: "t1", ownerId: "u1", appSlug: "shop.test", targetUrl: "https://shop.test", targetKind: "website" } });

    // 2.
    const atl = fakeAtlassian();
    const outcome = await connectJira(db, { appId: "a1", code: "code-1", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, atl.fetchImpl, Date.UTC(2026, 9, 12));
    const row = await db.trackerIntegration.findUnique({ where: { appId: "a1" } });
    eq("callback: connected", outcome, "jira_connected");
    eq("callback: stored as jira, first project, the site's cloudId and URL", [row?.type, row?.teamId, row?.externalOrg, row?.externalUrl], ["jira", "SEC", "cloud-1", "https://securify.atlassian.net"]);
    check("callback: tokens stored encrypted, never in clear", Boolean(row) && row!.accessTokenEnc !== "at-1" && decryptSecret(row!.accessTokenEnc) === "at-1" && decryptSecret(row!.refreshTokenEnc!) === "rt-1");
    check("callback: the code exchange sent the client secret to Atlassian only", atl.calls.filter((c) => JSON.stringify(c.body ?? "").includes("sec")).every((c) => c.url === "https://auth.atlassian.com/oauth/token"));

    await db.trackerIntegration.update({ where: { appId: "a1" }, data: { teamId: "OPS" } });
    await connectJira(db, { appId: "a1", code: "code-2", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, atl.fetchImpl);
    eq("callback: a reconnect keeps the project the team chose", (await db.trackerIntegration.findUnique({ where: { appId: "a1" } }))?.teamId, "OPS");
    const empty = fakeAtlassian();
    empty.state.projects = [];
    await db.app.create({ data: { id: "a2", teamId: "t1", ownerId: "u1", appSlug: "two.test", targetUrl: "https://two.test", targetKind: "website" } });
    eq("callback: a site with no project saves nothing and says so",
      [await connectJira(db, { appId: "a2", code: "c", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, empty.fetchImpl), await db.trackerIntegration.count({ where: { appId: "a2" } })],
      ["jira_no_project", 0]);

    // 3.
    const now = Date.UTC(2026, 9, 12, 12);
    await db.trackerIntegration.update({ where: { appId: "a1" }, data: { tokenExpiresAt: new Date(now + 2 * 60 * 1000) } });
    const near = (await db.trackerIntegration.findUnique({ where: { appId: "a1" } }))!;
    const before = atl.state.tokenCount;
    const fresh = await freshJiraToken(db, near, { clientId: "cid", clientSecret: "sec" }, atl.fetchImpl, now);
    const after = (await db.trackerIntegration.findUnique({ where: { appId: "a1" } }))!;
    check("refresh: a token about to expire is refreshed", fresh === `at-${before + 1}`, fresh);
    check("refresh: the rotated refresh token is stored", decryptSecret(after.refreshTokenEnc!) === `rt-${before + 1}`);
    const far = await freshJiraToken(db, after, { clientId: "cid", clientSecret: "sec" }, atl.fetchImpl, now);
    check("refresh: a token with time left is used as it is", far === fresh && atl.state.tokenCount === before + 1);
    atl.state.refuseRefresh = true;
    await db.trackerIntegration.update({ where: { appId: "a1" }, data: { tokenExpiresAt: new Date(now - 1000) } });
    const revoked = (await db.trackerIntegration.findUnique({ where: { appId: "a1" } }))!;
    const err = await freshJiraToken(db, revoked, { clientId: "cid", clientSecret: "sec" }, atl.fetchImpl, now).then(() => null, (e) => e);
    check("refresh: a refused refresh is a revoked grant (Reconnect Jira)", err instanceof JiraAuthError, String(err));
    atl.state.refuseRefresh = false;

    // 4.
    const tracker = new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl);
    const created = await tracker.createIssue({ title: "Checkout fails", description: "Line one\n\nLine two", labelNames: ["checkmyapp", "repo: shop"], stateName: "Backlog", priority: 2 });
    const post = atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).at(-1)!;
    const fields = (post.body as { fields: Record<string, unknown> }).fields;
    eq("create: in the project, as a Bug, with priority High", [(fields.project as { key: string }).key, (fields.issuetype as { name: string }).name, (fields.priority as { name: string }).name], ["SEC", "Bug", "High"]);
    eq("create: the description as ADF paragraphs, blank lines dropped", (fields.description as { content: unknown[] }).content.length, 2);
    eq("create: labels without spaces (Jira refuses them)", fields.labels, ["checkmyapp", "repo:-shop"]);
    eq("create: returns the key and a browse link", [created.identifier, created.url], ["SEC-1", "https://securify.atlassian.net/browse/SEC-1"]);
    check("create: the call carries the access token", post.auth === "Bearer at-x", String(post.auth));
    atl.state.noBug = true;
    const task = await tracker.createIssue({ title: "No bugs here", description: "x", labelNames: [], stateName: "Backlog", priority: 3 });
    const lastType = (atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).at(-1)!.body as { fields: { issuetype: { name: string } } }).fields.issuetype.name;
    eq("create: a project without Bug gets a Task", [task.identifier, lastType], ["SEC-2", "Task"]);

    await tracker.addComment("SEC-1", "Still present in run #4");
    check("comment: posted on the issue as ADF", atl.calls.some((c) => c.url.endsWith("/issue/SEC-1/comment") && (c.body as { body: { type: string } }).body.type === "doc"));

    eq("outcome: in progress is open", await tracker.getIssueOutcome("SEC-1"), "open");
    atl.state.issues.set("SEC-1", { status: "done", resolution: "Done" });
    eq("outcome: done with resolution Done is done", await tracker.getIssueOutcome("SEC-1"), "done");
    atl.state.issues.set("SEC-1", { status: "done", resolution: "Won't Do" });
    eq("outcome: done as Won't Do is canceled (not a bug)", await tracker.getIssueOutcome("SEC-1"), "canceled");
    atl.state.issues.set("SEC-1", { status: "done", resolution: "Cannot Reproduce" });
    eq("outcome: Cannot Reproduce is canceled", await tracker.getIssueOutcome("SEC-1"), "canceled");
    eq("outcome: a deleted issue is missing", await tracker.getIssueOutcome("SEC-99"), "missing");
    atl.state.unauthorized = true;
    const auth = await tracker.getIssueOutcome("SEC-1").then(() => null, (e) => e);
    check("outcome: 401 is a revoked grant (Reconnect Jira)", auth instanceof JiraAuthError, String(auth));
    atl.state.unauthorized = false;

    // 5.
    const jiraRow = (await db.trackerIntegration.findUnique({ where: { appId: "a1" } }))!;
    await db.trackerIntegration.update({ where: { appId: "a1" }, data: { tokenExpiresAt: new Date(Date.now() + 3600_000) } });
    const picked = await trackerFor(db, { ...jiraRow, tokenExpiresAt: new Date(Date.now() + 3600_000) }, { linear: {}, jira: { clientId: "cid", clientSecret: "sec" } }, atl.fetchImpl);
    check("factory: a jira integration files into Jira", picked instanceof JiraTracker);
    const linear = await trackerFor(
      db,
      { id: "l1", type: "linear", accessTokenEnc: encryptSecret("lin"), refreshTokenEnc: null, tokenExpiresAt: null, teamId: "team-uuid", externalOrg: "Eng" },
      { linear: {}, jira: {} },
    );
    check("factory: a linear integration stays Linear", linear instanceof LinearTracker);
    eq("factory: no project or team → nowhere to file", await trackerFor(db, { ...jiraRow, teamId: null }, { linear: {}, jira: {} }, atl.fetchImpl), null);
  } finally {
    await real.dispose();
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
