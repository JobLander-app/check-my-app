// CHE-438 verification: Jira as a tracker, against a fake Atlassian, on a real
// D1 (Miniflare).
//
//   1. consent: the authorize URL asks for the three scopes and the right audience;
//   2. callback: code → token → site → project, stored encrypted as the app's
//      integration of type "jira"; a reconnect keeps the chosen project;
//   3. refresh: an access token near expiry is refreshed and the rotated
//      refresh token stored; a refused refresh is "reconnect", not a crash;
//   4. JiraTracker: create (Bug, falling back to Task on 400), comment, label, and the
//      outcome map — open / done / canceled by resolution / missing on 404;
//      401 → reconnect;
//   5. the factory picks Jira for a jira row and Linear for a linear row;
//   6. switching trackers: an issue key means nothing in another tracker, so
//      Linear → Jira, Jira → Linear and a move to another Jira site retire the
//      in-flight links (ledger "superseded", then removed) and keep suppressed
//      and resolved ones; a reconnect to the same site keeps them; a Linear
//      grant on a Jira row becomes a Linear row with a Linear team;
//   7. the project picker lists every project on every site, and a choice is
//      checked against the grant, never taken as sent.
//
// Usage: npm run verify:jira

process.env.CREDENTIALS_SECRET ??= "verify-jira-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { JIRA_SCOPES, JiraAuthError, JiraTracker, buildJiraAuthorizeUrl, freshJiraToken, jiraProjects, pickIssueType, unfillableFields } from "../src/lib/tracker/jira";
import { chooseJiraProject, connectJira, jiraChoices } from "../src/lib/tracker/jira-connect";
import { saveLinearGrant } from "../src/lib/tracker/linear-connect";
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
    projects: [{ key: "SEC", name: "Securify" }],
    sites: [{ id: "cloud-1", url: "https://securify.atlassian.net/", name: "securify", scopes: ["read:jira-work", "write:jira-work"] }],
    projectsBySite: {} as Record<string, { key: string; name: string }[]>,
    // createmeta: what a project offers to create; null = Jira refuses to say.
    issueTypes: [
      { id: "1", name: "Bug", subtask: false, hierarchyLevel: 0 },
      { id: "2", name: "Task", subtask: false, hierarchyLevel: 0 },
      { id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
    ] as { id: string; name: string; subtask: boolean; hierarchyLevel: number }[] | null,
    // createmeta per type: the create screen; null = Jira refuses to say.
    fields: [
      { fieldId: "summary", name: "Summary", required: true },
      { fieldId: "project", name: "Project", required: true },
      { fieldId: "issuetype", name: "Issue Type", required: true },
      { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: false },
      { fieldId: "description", name: "Description", required: false },
      { fieldId: "labels", name: "Labels", required: false },
      { fieldId: "priority", name: "Priority", required: false },
    ] as { fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean }[] | null,
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
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(200, state.sites);
    const projectSearch = url.match(/^https:\/\/api\.atlassian\.com\/ex\/jira\/([^/]+)\/rest\/api\/3\/project\/search/);
    if (projectSearch) {
      // Pages of at most 100, as Atlassian serves them.
      const all = state.projectsBySite[projectSearch[1]] ?? state.projects;
      const q = new URL(url).searchParams;
      const startAt = Number(q.get("startAt") ?? 0);
      const max = Math.min(Number(q.get("maxResults") ?? 50), 100);
      return json(200, { values: all.slice(startAt, startAt + max), startAt, isLast: startAt + max >= all.length });
    }
    const api = "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3";
    if (/\/issue\/createmeta\/[^/]+\/issuetypes\/[^/?]+/.test(url)) {
      if (!state.fields) return json(500, {});
      return json(200, { fields: state.fields, total: state.fields.length, startAt: 0 });
    }
    if (url.startsWith(`${api}/issue/createmeta/`)) {
      if (!state.issueTypes) return json(500, {});
      return json(200, { issueTypes: state.issueTypes, total: state.issueTypes.length, startAt: 0 });
    }
    if (url === `${api}/issue` && method === "POST") {
      if (state.noBug && body.fields.issuetype.name === "Bug") return json(400, { errors: { issuetype: "Specify a valid issue type" } });
      const key = `SEC-${state.issues.size + 1}`;
      state.issues.set(key, { status: "new", resolution: null });
      return json(201, { id: `${10000 + state.issues.size}`, key });
    }
    const commentMatch = url.match(/\/issue\/([A-Z]+-\d+)\/comment$/);
    if (commentMatch && method === "POST") return state.issues.has(commentMatch[1]) ? json(201, { id: "c1" }) : json(404, {});
    const editMatch = url.match(/\/issue\/([A-Z]+-\d+)$/);
    if (editMatch && method === "PUT") return state.issues.has(editMatch[1]) ? new Response(null, { status: 204 }) : json(404, {});
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
    eq("callback: one project the grant reaches is the one filed into, with the site's cloudId and URL", [row?.type, row?.teamId, row?.externalOrg, row?.externalUrl], ["jira", "SEC", "cloud-1", "https://securify.atlassian.net"]);
    check("callback: tokens stored encrypted, never in clear", Boolean(row) && row!.accessTokenEnc !== "at-1" && decryptSecret(row!.accessTokenEnc) === "at-1" && decryptSecret(row!.refreshTokenEnc!) === "rt-1");
    check("callback: the code exchange sent the client secret to Atlassian only", atl.calls.filter((c) => JSON.stringify(c.body ?? "").includes("sec")).every((c) => c.url === "https://auth.atlassian.com/oauth/token"));
    check("callback: projects are those the grant may create issues in", atl.calls.some((c) => c.url.includes("/project/search?action=create")));

    // Several projects: nothing is guessed, nothing is filed until the team picks.
    const several = fakeAtlassian();
    several.state.projects = [{ key: "SEC", name: "Securify" }, { key: "HR", name: "People" }];
    await db.app.create({ data: { id: "a4", teamId: "t1", ownerId: "u1", appSlug: "four.test", targetUrl: "https://four.test", targetKind: "website" } });
    eq("callback: a grant reaching several projects asks the team to choose", await connectJira(db, { appId: "a4", code: "c", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, several.fetchImpl), "jira_choose_project");
    const unchosen = (await db.trackerIntegration.findUnique({ where: { appId: "a4" } }))!;
    eq("callback: …the grant is kept, with no project", [unchosen.type, unchosen.teamId, unchosen.externalOrg], ["jira", null, null]);
    eq("callback: …and nothing is filed until one is chosen", await trackerFor(db, unchosen, { linear: {}, jira: { clientId: "cid", clientSecret: "sec" } }, several.fetchImpl), null);

    // A site with more than a page of projects is read to the end.
    const big = fakeAtlassian();
    big.state.projects = Array.from({ length: 150 }, (_, i) => ({ key: `P${i}`, name: `Project ${i}` }));
    eq("projects: every page is read (150 projects, pages of 100)", (await jiraProjects("at", "cloud-1", big.fetchImpl)).length, 150);

    atl.state.projects = [{ key: "SEC", name: "Securify" }, { key: "OPS", name: "Ops" }];
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
    eq("create: in the project, as the project's Bug type (by id), with priority High", [(fields.project as { key: string }).key, (fields.issuetype as { id: string }).id, (fields.priority as { name: string }).name], ["SEC", "1", "High"]);
    eq("create: the description as ADF paragraphs, blank lines dropped", (fields.description as { content: unknown[] }).content.length, 2);
    eq("create: labels without spaces (Jira refuses them)", fields.labels, ["checkmyapp", "repo:-shop"]);
    eq("create: returns the key and a browse link", [created.identifier, created.url], ["SEC-1", "https://securify.atlassian.net/browse/SEC-1"]);
    check("create: the call carries the access token", post.auth === "Bearer at-x", String(post.auth));
    const lastPostedType = () => (atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).at(-1)!.body as { fields: { issuetype: { id?: string; name?: string } } }).fields.issuetype;

    // A scheme with neither Bug nor Task, in another language: its standard type.
    atl.state.issueTypes = [
      { id: "20", name: "Эпик", subtask: false, hierarchyLevel: 1 },
      { id: "21", name: "Задача", subtask: false, hierarchyLevel: 0 },
      { id: "22", name: "Подзадача", subtask: true, hierarchyLevel: -1 },
    ];
    const localized = new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl);
    await localized.createIssue({ title: "Localized", description: "x", labelNames: [], stateName: "Backlog", priority: 3 });
    eq("create: a scheme without Bug or Task files as its standard type, never a sub-task", lastPostedType(), { id: "21" });
    eq("create: the type picker prefers Task to anything else when there is no Bug", pickIssueType([{ id: "a", name: "Story" }, { id: "b", name: "task" }])?.id, "b");

    // When Jira will not say what the project offers: Bug, then Task, by name.
    atl.state.issueTypes = null;
    atl.state.noBug = true;
    const blind = new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl);
    const task = await blind.createIssue({ title: "No bugs here", description: "x", labelNames: [], stateName: "Backlog", priority: 3 });
    eq("create: without the project's types, a project without Bug gets a Task", [task.identifier, lastPostedType().name], ["SEC-3", "Task"]);
    atl.state.noBug = false;
    atl.state.issueTypes = [{ id: "1", name: "Bug", subtask: false, hierarchyLevel: 0 }];

    // The create screen decides what is sent.
    const lastPostedFields = () => (atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).at(-1)!.body as { fields: Record<string, unknown> }).fields;
    const defaultFields = atl.state.fields!;
    atl.state.fields = defaultFields.filter((f) => f.fieldId !== "labels" && f.fieldId !== "priority");
    await new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl).createIssue({ title: "Plain screen", description: "x", labelNames: ["checkmyapp"], stateName: "Backlog", priority: 2 });
    eq("create: labels and priority are left out when the create screen has no such fields", ["labels" in lastPostedFields(), "priority" in lastPostedFields(), "description" in lastPostedFields()], [false, false, true]);

    atl.state.fields = [...defaultFields, { fieldId: "customfield_10010", name: "Team", required: true, hasDefaultValue: false }];
    const postsBefore = atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).length;
    const blocked = new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl);
    const refused = await blocked.createIssue({ title: "Needs a team", description: "x", labelNames: [], stateName: "Backlog", priority: 3 }).then(() => null, (e) => e);
    check("create: a required field we cannot fill is named, and no ticket is sent to fail", refused instanceof Error && /Team/.test(refused.message) && atl.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).length === postsBefore, String(refused));
    eq("create: …the same field is what the card shows", await blocked.blockers(), ["Team"]);
    atl.state.fields = [...defaultFields, { fieldId: "customfield_10010", name: "Team", required: true, hasDefaultValue: true }];
    eq("create: a required field with a default is Jira's to fill", await new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl).blockers(), []);
    eq("create: the reporter, required on many screens, is Jira's to fill", unfillableFields([{ fieldId: "reporter", name: "Reporter", required: true }]), []);
    atl.state.fields = null;
    await new JiraTracker("at-x", "cloud-1", "SEC", "https://securify.atlassian.net", atl.fetchImpl).createIssue({ title: "Screen unknown", description: "x", labelNames: ["checkmyapp"], stateName: "Backlog", priority: 2 });
    check("create: when Jira will not show the screen, labels and priority are sent as before", "labels" in lastPostedFields() && "priority" in lastPostedFields());
    atl.state.fields = defaultFields;

    await tracker.addComment("SEC-1", "Still present in run #4");
    check("comment: posted on the issue as ADF", atl.calls.some((c) => c.url.endsWith("/issue/SEC-1/comment") && (c.body as { body: { type: string } }).body.type === "doc"));

    await tracker.addLabel("SEC-1", "checkmyapp mender");
    const edit = atl.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/issue/SEC-1")).at(-1);
    eq("label: added to the existing issue, spaces made dashes", edit?.body, { update: { labels: [{ add: "checkmyapp-mender" }] } });
    const gone = await tracker.addLabel("SEC-99", "x").then(() => null, (e) => e);
    check("label: an issue that is gone is an error, not a silent pass", gone instanceof Error && !(gone instanceof JiraAuthError), String(gone));

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

    // 6. An app on Linear with links in every state.
    await db.app.create({ data: { id: "a3", teamId: "t1", ownerId: "u1", appSlug: "three.test", targetUrl: "https://three.test", targetKind: "website" } });
    await db.trackerIntegration.create({ data: { appId: "a3", type: "linear", accessTokenEnc: encryptSecret("lin"), teamId: "lin-team-uuid", externalOrg: "Eng" } });
    const seed = async (key: string, status: string) =>
      db.issueLink.create({ data: { appId: "a3", dedupKey: `k-${key}`, externalIssueId: key, status } });
    await seed("JOB-1", "open");
    await seed("JOB-2", "fixed");
    await seed("JOB-3", "suppressed");
    await seed("JOB-4", "resolved");
    const links = async () => (await db.issueLink.findMany({ where: { appId: "a3" }, orderBy: { externalIssueId: "asc" } })).map((l) => `${l.externalIssueId}:${l.status}`);
    const superseded = async () =>
      (await db.settledSignature.findMany({ where: { appSlug: "three.test", outcome: "superseded" }, orderBy: { externalIssueId: "asc" } })).map((s) => s.externalIssueId);

    const sw = fakeAtlassian();
    eq("switch: Linear → Jira connects", await connectJira(db, { appId: "a3", code: "c", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, sw.fetchImpl), "jira_connected");
    eq("switch: Linear's open and fixed links are retired; suppressed and resolved stay", await links(), ["JOB-3:suppressed", "JOB-4:resolved"]);
    eq("switch: the retired keys are kept in the ledger as superseded", await superseded(), ["JOB-1", "JOB-2"]);

    await db.issueLink.create({ data: { appId: "a3", dedupKey: "k-SEC-9", externalIssueId: "SEC-9", status: "open" } });
    await connectJira(db, { appId: "a3", code: "c2", redirectUri: "r", clientId: "cid", clientSecret: "sec" }, sw.fetchImpl);
    check("switch: a reconnect to the same Jira site keeps its links", (await links()).includes("SEC-9:open"));

    // 7. Two sites, the second with its own projects.
    sw.state.sites = [...sw.state.sites, { id: "cloud-2", url: "https://other.atlassian.net", name: "other", scopes: ["read:jira-work", "write:jira-work"] }];
    sw.state.projectsBySite["cloud-2"] = [{ key: "WEB", name: "Website" }];
    sw.state.projects = [{ key: "SEC", name: "Securify" }, { key: "OPS", name: "Ops" }];
    const a3 = (await db.trackerIntegration.findUnique({ where: { appId: "a3" } }))!;
    await db.trackerIntegration.update({ where: { appId: "a3" }, data: { tokenExpiresAt: new Date(Date.now() + 3600_000) } });
    const choices = await jiraChoices(db, { ...a3, tokenExpiresAt: new Date(Date.now() + 3600_000) }, { clientId: "cid", clientSecret: "sec" }, sw.fetchImpl);
    eq("picker: every project on every site, the site named when there are two", choices.map((c) => c.value), ["cloud-1/SEC", "cloud-1/OPS", "cloud-2/WEB"]);
    check("picker: labels say which site", choices.every((c) => c.label.includes("atlassian.net")), choices.map((c) => c.label).join(" | "));

    eq("picker: a value the grant does not reach is refused", await chooseJiraProject(db, "a3", "cloud-9/NOPE", { clientId: "cid", clientSecret: "sec" }, sw.fetchImpl), "unknown_choice");
    eq("picker: …and changes nothing", (await db.trackerIntegration.findUnique({ where: { appId: "a3" } }))?.teamId, "SEC");
    eq("picker: another project on the same site", await chooseJiraProject(db, "a3", "cloud-1/OPS", { clientId: "cid", clientSecret: "sec" }, sw.fetchImpl), "chosen");
    check("picker: the same site keeps its links", (await links()).includes("SEC-9:open"));
    eq("picker: another site", await chooseJiraProject(db, "a3", "cloud-2/WEB", { clientId: "cid", clientSecret: "sec" }, sw.fetchImpl), "chosen");
    const moved = await db.trackerIntegration.findUnique({ where: { appId: "a3" } });
    eq("picker: the row points at the new site and project", [moved?.externalOrg, moved?.teamId, moved?.externalUrl], ["cloud-2", "WEB", "https://other.atlassian.net"]);
    check("picker: another site retires the old site's links", !(await links()).includes("SEC-9:open"));
    eq("picker: not a Jira row → refused", await chooseJiraProject(db, "a1x", "cloud-1/SEC", { clientId: "cid", clientSecret: "sec" }, sw.fetchImpl), "not_jira");

    // 6, back: Jira → Linear.
    await db.issueLink.create({ data: { appId: "a3", dedupKey: "k-WEB-1", externalIssueId: "WEB-1", status: "open" } });
    const appRow = { id: "a3", teamId: "t1", ownerId: "u1", appSlug: "three.test" };
    let firstTeamCalls = 0;
    await saveLinearGrant(db, appRow, { access_token: "lin-2", expires_in: 86400 }, async () => (firstTeamCalls++, { id: "lin-first", name: "First" }));
    const back = await db.trackerIntegration.findUnique({ where: { appId: "a3" } });
    eq("switch back: the row is Linear again, with a Linear team, not the Jira project key", [back?.type, back?.teamId, back?.externalOrg, back?.externalUrl], ["linear", "lin-first", "First", null]);
    check("switch back: the Linear token is the one stored", decryptSecret(back!.accessTokenEnc) === "lin-2");
    check("switch back: Jira's links are retired", !(await links()).includes("WEB-1:open") && (await superseded()).includes("WEB-1"));
    await db.trackerIntegration.update({ where: { appId: "a3" }, data: { teamId: "lin-chosen", externalOrg: "Chosen" } });
    await saveLinearGrant(db, appRow, { access_token: "lin-3" }, async () => (firstTeamCalls++, { id: "lin-first", name: "First" }));
    eq("reconnect: a Linear reconnect keeps the team the owner chose", [(await db.trackerIntegration.findUnique({ where: { appId: "a3" } }))?.teamId, firstTeamCalls], ["lin-chosen", 1]);
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
