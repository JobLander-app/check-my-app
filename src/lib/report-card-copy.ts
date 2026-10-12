// CHE-434 place 9: every sentence the admin card says about the team's reports,
// built here — a pure module, so the language guards read the whole output, not
// fragments of rendered markup (docs/CODE_STANDARDS.md R18; Codex on #320).

import { REASON_LABEL, STATUS_LABEL, type FeedbackItem, type FeedbackReason } from "@/lib/feedback";

export const REPORTS_HEADING = "What your team reported the check got wrong.";

const QUOTE_MAX = 140;

/** What a report is about, said beside its reason: a finding, a step, or a scenario. */
export function reportTarget(r: Pick<FeedbackItem, "findingNumber" | "stepLabel" | "scenarioTitle">): string {
  if (r.findingNumber !== null) return ` · finding #${String(r.findingNumber).padStart(3, "0")}`;
  if (r.stepLabel) return ` · “${r.stepLabel}”`;
  if (r.scenarioTitle) return ` · scenario “${r.scenarioTitle}”`;
  return "";
}

/** The first line: the reason and what it is about. */
export function reportLine(r: Pick<FeedbackItem, "reason" | "findingNumber" | "stepLabel" | "scenarioTitle">): string {
  return `${REASON_LABEL[r.reason as FeedbackReason] ?? r.reason}${reportTarget(r)}`;
}

/** The second line: what was said, and by whom. */
export function reportQuote(r: Pick<FeedbackItem, "text" | "author">): string {
  // By characters (code points), so an emoji at the cut is kept whole (Codex on #320).
  const chars = [...r.text];
  const text = chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX).join("")}…` : r.text;
  return `“${text}” — ${r.author}`;
}

/** Where it stands. */
export function reportStatus(r: Pick<FeedbackItem, "status">): string {
  return STATUS_LABEL[r.status] ?? r.status;
}

/** Where the link goes and what it says: the check it was said on, else the scenario. */
export function reportLink(r: Pick<FeedbackItem, "runPublicId" | "scenarioId">, appScenariosHref: string): { href: string; text: string } | null {
  if (r.runPublicId) return { href: `/verdict/${r.runPublicId}`, text: "the check" };
  if (r.scenarioId) return { href: appScenariosHref, text: "the scenario" };
  return null;
}
