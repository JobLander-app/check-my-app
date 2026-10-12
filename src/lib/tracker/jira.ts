// Jira Cloud as a tracker (CHE-438), connected like Linear: OAuth 2.0 (3LO),
// no API token pasted anywhere. Bugs in a team's product go to the team's own
// Jira; mistakes of our checker stay on our board.
//
//   authorize  https://auth.atlassian.com/authorize (audience api.atlassian.com)
//   token      POST https://auth.atlassian.com/oauth/token (JSON; rotating refresh)
//   sites      GET https://api.atlassian.com/oauth/token/accessible-resources
//   REST v3    https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…
//
// Free of Next imports on purpose — this compiles into the agent worker as
// well as the web app. `fetchImpl` is for the guard (scripts/verify-jira.ts),
// which plays Atlassian.

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { CreatedIssue, IssueOutcome, TicketDraft, Tracker } from "./types";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const API = (cloudId: string) => `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;

// Read and write issues, and stay connected (a refresh token).
export const JIRA_SCOPES = "read:jira-work write:jira-work offline_access";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

type Fetch = typeof fetch;

/** A grant that Atlassian no longer honours: the only cure is Reconnect Jira. */
export class JiraAuthError extends Error {}

export function buildJiraAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: opts.clientId,
    scope: JIRA_SCOPES,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface JiraToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(body: Record<string, string>, fetchImpl: Fetch): Promise<JiraToken> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new JiraAuthError(`Jira refused the grant: ${res.status}`);
  if (!res.ok) throw new Error(`Jira token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as JiraToken;
}

export function exchangeJiraCode(
  opts: { code: string; redirectUri: string; clientId: string; clientSecret: string },
  fetchImpl: Fetch = fetch,
): Promise<JiraToken> {
  return tokenRequest(
    { grant_type: "authorization_code", client_id: opts.clientId, client_secret: opts.clientSecret, code: opts.code, redirect_uri: opts.redirectUri },
    fetchImpl,
  );
}

export interface JiraSite {
  cloudId: string;
  url: string;
  name: string;
}

/** The Jira sites this grant reaches. */
export async function jiraSites(accessToken: string, fetchImpl: Fetch = fetch): Promise<JiraSite[]> {
  const res = await fetchImpl(RESOURCES_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (res.status === 401) throw new JiraAuthError("Jira refused the access token");
  if (!res.ok) throw new Error(`Jira sites: ${res.status}`);
  const list = (await res.json()) as { id: string; url: string; name: string; scopes?: string[] }[];
  return list
    .filter((s) => !s.scopes || s.scopes.includes("write:jira-work"))
    .map((s) => ({ cloudId: s.id, url: s.url.replace(/\/+$/, ""), name: s.name }));
}

// project/search pages at 100 at most; a site with more is read page by page,
// up to this many pages, so a broken `isLast` cannot loop forever.
const MAX_PROJECT_PAGES = 50;

/**
 * The site's projects the grant may file into (key + name), every page of
 * them, for the picker. `action=create`: a project we could only look at is
 * not a place to send tickets.
 */
export async function jiraProjects(accessToken: string, cloudId: string, fetchImpl: Fetch = fetch): Promise<{ key: string; name: string }[]> {
  const out: { key: string; name: string }[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const res = await fetchImpl(`${API(cloudId)}/project/search?action=create&orderBy=name&maxResults=100&startAt=${startAt}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (res.status === 401) throw new JiraAuthError("Jira refused the access token");
    if (!res.ok) throw new Error(`Jira projects: ${res.status}`);
    const body = (await res.json()) as { values?: { key: string; name: string }[]; isLast?: boolean };
    const values = body.values ?? [];
    out.push(...values.map((p) => ({ key: p.key, name: p.name })));
    if (body.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

/**
 * The issue type a finding is filed as, from what the project offers: Bug, then
 * Task, then the project's first standard (level 0) type, then any type that is
 * not a sub-task. Names differ by scheme and language, so the project is asked.
 */
export function pickIssueType(types: JiraIssueType[]): JiraIssueType | null {
  const usable = types.filter((t) => !t.subtask);
  return (
    usable.find((t) => /^bug$/i.test(t.name.trim())) ??
    usable.find((t) => /^task$/i.test(t.name.trim())) ??
    usable.find((t) => t.hierarchyLevel === 0) ??
    usable[0] ??
    null
  );
}

export interface JiraCreds {
  clientId?: string;
  clientSecret?: string;
}

export interface JiraTokenRow {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}

/**
 * A usable access token, refreshed ahead of expiry. Atlassian rotates refresh
 * tokens, so the new one is stored every time. A refresh Atlassian refuses is
 * a revoked grant: JiraAuthError, which the pages show as Reconnect Jira.
 */
export async function freshJiraToken(db: PrismaClient, row: JiraTokenRow, creds: JiraCreds, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string> {
  const current = decryptSecret(row.accessTokenEnc);
  const expiresAt = row.tokenExpiresAt?.getTime();
  if (!expiresAt || expiresAt - now > REFRESH_MARGIN_MS) return current;
  if (!row.refreshTokenEnc || !creds.clientId || !creds.clientSecret) {
    if (expiresAt <= now) throw new JiraAuthError("the Jira token has expired and cannot be refreshed");
    return current;
  }
  const token = await tokenRequest(
    { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: decryptSecret(row.refreshTokenEnc) },
    fetchImpl,
  );
  await db.trackerIntegration.update({
    where: { id: row.id },
    data: {
      accessTokenEnc: encryptSecret(token.access_token),
      ...(token.refresh_token ? { refreshTokenEnc: encryptSecret(token.refresh_token) } : {}),
      tokenExpiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
    },
  });
  return token.access_token;
}

// Atlassian Document Format: one paragraph per line, blank lines dropped.
export function toAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

// Linear's scale (1 Urgent … 4 Low) onto Jira's default priority names.
const PRIORITY_NAMES: Record<number, string> = { 1: "Highest", 2: "High", 3: "Medium", 4: "Low" };

// Jira labels cannot contain spaces.
const jiraLabel = (name: string) => name.replace(/\s+/g, "-");

// A resolution that means "this is not a bug", read as Canceled (Contract v2).
const NOT_A_BUG = /won.?t do|won.?t fix|duplicate|cannot reproduce|declined|not a bug/i;

export class JiraTracker implements Tracker {
  constructor(
    private readonly accessToken: string,
    private readonly cloudId: string,
    private readonly projectKey: string,
    private readonly siteUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${API(this.cloudId)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (res.status === 401) throw new JiraAuthError("Jira refused the access token");
    return res;
  }

  // The project's issue types, read once per tracker: undefined = not asked
  // yet, null = Jira would not say (the filer then tries Bug and Task by name).
  private issueType: JiraIssueType | null | undefined;

  private async projectIssueType(): Promise<JiraIssueType | null> {
    if (this.issueType !== undefined) return this.issueType;
    const types: JiraIssueType[] = [];
    let startAt = 0;
    for (let page = 0; page < 10; page++) {
      const res = await this.call(`/issue/createmeta/${encodeURIComponent(this.projectKey)}/issuetypes?startAt=${startAt}&maxResults=100`);
      if (!res.ok) {
        this.issueType = null;
        return null;
      }
      const body = (await res.json()) as { issueTypes?: JiraIssueType[]; total?: number };
      const got = body.issueTypes ?? [];
      types.push(...got);
      startAt += got.length;
      if (got.length === 0 || (body.total ?? 0) <= startAt) break;
    }
    this.issueType = pickIssueType(types);
    return this.issueType;
  }

  async createIssue(draft: TicketDraft): Promise<CreatedIssue> {
    const base = {
      project: { key: this.projectKey },
      summary: draft.title.slice(0, 250),
      description: toAdf(draft.description),
      labels: draft.labelNames.map(jiraLabel),
    };
    const priority = { name: PRIORITY_NAMES[draft.priority] ?? "Medium" };
    // The type the project offers (projectIssueType); when Jira would not say,
    // Bug and then Task by name. A priority the project does not have is
    // dropped rather than failing the ticket.
    const type = await this.projectIssueType();
    const attempts = type
      ? [
          { ...base, issuetype: { id: type.id }, priority },
          { ...base, issuetype: { id: type.id } },
        ]
      : [
          { ...base, issuetype: { name: "Bug" }, priority },
          { ...base, issuetype: { name: "Bug" } },
          { ...base, issuetype: { name: "Task" } },
        ];
    let last = "";
    for (const fields of attempts) {
      const res = await this.call("/issue", { method: "POST", body: JSON.stringify({ fields }) });
      if (res.ok) {
        const body = (await res.json()) as { id: string; key: string };
        return { id: body.id, identifier: body.key, url: `${this.siteUrl}/browse/${body.key}` };
      }
      last = `${res.status} ${await res.text()}`;
      if (res.status !== 400) break;
    }
    throw new Error(`Jira createIssue failed: ${last}`);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const res = await this.call(`/issue/${encodeURIComponent(issueId)}/comment`, { method: "POST", body: JSON.stringify({ body: toAdf(body) }) });
    if (!res.ok) throw new Error(`Jira addComment failed: ${res.status} ${await res.text()}`);
  }

  // A Jira label needs no creating, and adding one the issue has is a no-op.
  async addLabel(issueId: string, labelName: string): Promise<void> {
    const res = await this.call(`/issue/${encodeURIComponent(issueId)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [{ add: jiraLabel(labelName) }] } }),
    });
    if (!res.ok) throw new Error(`Jira addLabel failed: ${res.status} ${await res.text()}`);
  }

  async getIssueOutcome(issueId: string): Promise<IssueOutcome> {
    const res = await this.call(`/issue/${encodeURIComponent(issueId)}?fields=status,resolution`);
    if (res.status === 404) return "missing";
    if (!res.ok) throw new Error(`Jira getIssue failed: ${res.status}`);
    const issue = (await res.json()) as { fields?: { status?: { statusCategory?: { key?: string } }; resolution?: { name?: string } | null } };
    if (issue.fields?.status?.statusCategory?.key !== "done") return "open";
    return NOT_A_BUG.test(issue.fields?.resolution?.name ?? "") ? "canceled" : "done";
  }
}
