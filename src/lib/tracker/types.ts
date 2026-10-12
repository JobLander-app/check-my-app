// Tracker abstraction (CHE-31). Linear is the only implementation now; Jira /
// GitHub Issues can implement the same interface later. The producer side
// (watch-diff → ticket) never imports a concrete tracker — only this interface.

export interface TicketDraft {
  title: string;
  description: string;
  // Human label names; the adapter resolves them to tracker ids (creating any
  // that don't exist — e.g. the provenance label, per Contract v1).
  labelNames: string[];
  // Workflow state name, e.g. "Backlog" — adapter resolves to a state id.
  stateName: string;
  // Linear priority scale: 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
  priority: number;
}

export interface CreatedIssue {
  id: string;
  identifier: string; // e.g. "JOB-123"
  url: string;
}

// Where a filed ticket ended up, projected onto a tracker-agnostic contract
// (CHE-61 reverse sync): "done" = fixed and shipped, "canceled" = ruled
// not-a-bug, "open" = anything still in flight (including triage/backlog),
// "missing" = the ticket no longer exists. Adapters map from workflow state
// TYPE, not state name — a custom "Deployed" column still reads as done.
export type IssueOutcome = "open" | "done" | "canceled" | "missing";

export interface Tracker {
  createIssue(draft: TicketDraft): Promise<CreatedIssue>;
  addComment(issueId: string, body: string): Promise<void>;
  getIssueOutcome(issueId: string): Promise<IssueOutcome>;
  // CHE-441: the latest comment on the ticket that starts with "Answer:", its
  // text after the prefix, or null. How whoever settled a pilot report says, in
  // words its author will read, what was found. Optional: only our own board's
  // tracker needs it.
  latestAnswer?(issueId: string): Promise<string | null>;
}

export const ANSWER_PREFIX = /^\s*answer:\s*/i;

/** The text of the newest comment that starts with "Answer:", or null. */
export function answerFrom(comments: { body: string; createdAt: string }[]): string | null {
  const answers = comments
    .filter((c) => ANSWER_PREFIX.test(c.body))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const text = answers[0]?.body.replace(ANSWER_PREFIX, "").trim();
  return text ? text : null;
}
