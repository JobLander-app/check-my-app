import { answerFrom, type Tracker, type TicketDraft, type CreatedIssue, type IssueOutcome } from "./types";
import { linearAuthHeader } from "./linear-auth";

// Linear adapter over the GraphQL API (CHE-31). Multi-tenant SaaS auth = OAuth2
// access token (Bearer); a seeded personal API key goes in bare — see
// linearAuthHeader. The token comes from the owner's TrackerIntegration
// (decrypted at the call site) and is scoped to their workspace.
//
// Exercised against the live API 2026-08-22 (run #42 battle test): team
// workflow states are `team.states`; auth accepts OAuth tokens (Bearer) and
// personal lin_api_ keys (bare) — see linear-auth.ts.

const ENDPOINT = "https://api.linear.app/graphql";

export class LinearTracker implements Tracker {
  constructor(
    private readonly accessToken: string,
    private readonly teamId: string,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearAuthHeader(this.accessToken),
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      throw new Error(`Linear API: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (!json.data) throw new Error("Linear API: empty response");
    return json.data;
  }

  // Resolve label names → ids for this team, creating any that don't exist
  // (Contract v1: CheckMyApp creates its provenance label once).
  private async resolveLabelIds(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const data = await this.gql<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
      `query($id:String!){ team(id:$id){ labels{ nodes{ id name } } } }`,
      { id: this.teamId },
    );
    const byName = new Map(data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
    const ids: string[] = [];
    for (const name of names) {
      const existing = byName.get(name.toLowerCase());
      if (existing) {
        ids.push(existing);
        continue;
      }
      const created = await this.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        `mutation($input:IssueLabelCreateInput!){ issueLabelCreate(input:$input){ issueLabel{ id } } }`,
        { input: { name, teamId: this.teamId } },
      );
      ids.push(created.issueLabelCreate.issueLabel.id);
    }
    return ids;
  }

  private async resolveStateId(name: string): Promise<string | undefined> {
    // Team workflow states live under `team.states` (verified against the live
    // API 2026-08-22 — `workflowStates` does not exist and broke the first
    // battle-test of auto-filing, run #42).
    const data = await this.gql<{
      team: { states: { nodes: { id: string; name: string }[] } };
    }>(`query($id:String!){ team(id:$id){ states{ nodes{ id name } } } }`, {
      id: this.teamId,
    });
    return data.team.states.nodes.find((s) => s.name.toLowerCase() === name.toLowerCase())?.id;
  }

  async createIssue(draft: TicketDraft): Promise<CreatedIssue> {
    const [labelIds, stateId] = await Promise.all([
      this.resolveLabelIds(draft.labelNames),
      this.resolveStateId(draft.stateName),
    ]);
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
    }>(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }`,
      {
        input: {
          teamId: this.teamId,
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          stateId,
          labelIds,
        },
      },
    );
    if (!data.issueCreate.success) throw new Error("Linear issueCreate returned success=false");
    return data.issueCreate.issue;
  }

  // Linear accepts the shorthand identifier ("JOB-123") wherever an issue is
  // addressed by a top-level `id` argument, but CommentCreateInput.issueId is an
  // input field and wants the UUID. IssueLink stores the identifier (it is what
  // we show the owner), so resolve it here rather than storing both.
  private async issueUuid(idOrIdentifier: string): Promise<string> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrIdentifier)) {
      return idOrIdentifier;
    }
    const data = await this.gql<{ issue: { id: string } | null }>(
      `query($id:String!){ issue(id:$id){ id } }`,
      { id: idOrIdentifier },
    );
    if (!data.issue) throw new Error(`Linear: issue ${idOrIdentifier} not found`);
    return data.issue.id;
  }

  // Reverse sync (CHE-61): the ticket's workflow state carries the fixer's
  // verdict. Keyed on state TYPE, which Linear keeps canonical across custom
  // workflows (verified against the live workspace 2026-08-23: JOB-902 Done →
  // "completed", JOB-904 Canceled → "canceled"). `issue(id:)` accepts the
  // shorthand identifier IssueLink stores — same as issueUuid above.
  async getIssueOutcome(issueId: string): Promise<IssueOutcome> {
    const data = await this.gql<{ issue: { state: { type: string } } | null }>(
      `query($id:String!){ issue(id:$id){ state { type } } }`,
      { id: issueId },
    );
    if (!data.issue) return "missing";
    const type = data.issue.state.type;
    if (type === "completed") return "done";
    if (type === "canceled") return "canceled";
    return "open";
  }

  async latestAnswer(issueId: string): Promise<string | null> {
    const data = await this.gql<{ issue: { comments: { nodes: { body: string; createdAt: string }[] } } | null }>(
      `query($id:String!){ issue(id:$id){ comments(first: 100){ nodes { body createdAt } } } }`,
      { id: issueId },
    );
    return data.issue ? answerFrom(data.issue.comments.nodes) : null;
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }`,
      { input: { issueId: await this.issueUuid(issueId), body } },
    );
    if (!data.commentCreate.success) throw new Error("Linear commentCreate returned success=false");
  }
}
