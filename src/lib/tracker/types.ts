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
  // CHE-443: put a label on an issue that already exists (creating it on the
  // team when it does not). Adding one the issue has is not an error.
  addLabel(issueId: string, labelName: string): Promise<void>;
  getIssueOutcome(issueId: string): Promise<IssueOutcome>;
}
