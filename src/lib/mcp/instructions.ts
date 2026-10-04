// The first thing an agent reads when it connects (MCP `instructions`,
// CHE-315): which apps this team has, how each one stood at its latest check,
// and how many problems are new since the check before — then what to do with
// that; and the team's plan with what is left of it (CHE-325).
//
// Computed per connection from the key's team, so it is always today's answer.
// Every sentence here reaches the person through their agent, so CLAUDE.md §1
// applies as it does to a verdict: it describes their apps, never how we check
// them, and never gives them homework.
//
// Bounded (MAX_CHARS) because clients put it into the model's context on every
// session: a team with fifty apps gets the ones with news first and a count of
// the rest, never a page of text.

import type { LatestResults } from "@/lib/latest-results";
import type { PlanStatus } from "@/lib/plan-status";
import { planLabel, usd } from "@/lib/plans";
import { RELEASE_ACTION_INSTRUCTION } from "@/lib/release-action";

// 1800 since CHE-370: the sentence that offers the GitHub Action took the room
// the app lines had under 1500.
export const MAX_INSTRUCTIONS_CHARS = 1800;

const VERDICT_WORDS: Record<string, string> = {
  all_good: "all good",
  mostly_ok: "mostly OK",
  needs_attention: "needs attention",
  broken: "broken",
  unverified: "no result",
};

// CHE-325: the plan and what is left of it, one line — so the agent knows
// before it spends, not from a refusal. Numbers come from loadPlanStatus
// (src/lib/plan-status.ts), which reads them through the gates' own counts.
function planLine(s: PlanStatus): string {
  const parts = [`Plan: ${planLabel(s.plan)}.`];
  const b = s.balance;
  parts.push(
    b.usd === null
      ? "Balance: unlimited."
      : `Balance: ${usd(b.usd)}` +
          (b.renews_on ? ` (the plan adds ${usd(b.plan_credit_usd ?? 0)} on ${b.renews_on}).` : " (the free credit does not renew)."),
  );
  const t = s.typical_check_price_usd;
  parts.push(
    `Every check has its own price, typically ${usd(t.low)}–${usd(t.high)}; one that finds nothing changed costs a few cents. ` +
      "list_apps shows each app's usual price.",
  );
  const trial = s.watch_trial
    ? ` (${s.watch_trial.app}: ${s.watch_trial.ended ? "trial ended, not running" : `trial, ${s.watch_trial.days_left} day${s.watch_trial.days_left === 1 ? "" : "s"} left`})`
    : "";
  parts.push(`Watched apps: ${s.watches.active}${s.watches.limit === null ? "" : ` of ${s.watches.limit}`}${trial}.`);
  parts.push(`Top up: ${s.buy_url} · Upgrade: ${s.upgrade_url}`);
  return parts.join(" ");
}

// What the agent does with that line. The warning exists because the last of
// a balance spent in silence is how a person meets the limit: as a refusal on
// the next deploy.
function planRule(s: PlanStatus): string {
  const refusal =
    "Every balance refusal carries buy_url and upgrade_url: say what is left and give the user both links.";
  if (s.balance.usd === null) return refusal;
  return (
    "Before starting a check the balance may not cover — or if it is used up — tell the user first and give " +
    `them the top-up and upgrade links; never let a limit surprise them. ${refusal}`
  );
}

// CHE-370: `runsReleaseAction` is whether this team's checks already arrive
// from the GitHub Action — a team that has it is not offered it again.
export function buildInstructions(
  teamName: string,
  results: LatestResults,
  plan: PlanStatus,
  runsReleaseAction: boolean,
): string {
  const head =
    `CheckMyApp checks the deployed apps of team "${teamName}" the way a real user would and reports what is broken. ` +
    "The person you work with manages CheckMyApp entirely through these tools — they should not need to open its dashboard.";

  const withNews = results.apps.filter((a) => a.new_findings.length > 0);
  const lines: string[] = [];
  // Apps with new findings first: those are the ones the person needs to hear about.
  const ordered = [...withNews, ...results.apps.filter((a) => a.new_findings.length === 0)];
  for (const a of ordered) {
    const verdict = a.latest_run ? VERDICT_WORDS[a.latest_run.verdict ?? ""] ?? a.latest_run.status : "not checked yet";
    const news = a.new_findings.length ? `, ${a.new_findings.length} new finding${a.new_findings.length === 1 ? "" : "s"}` : "";
    lines.push(`- ${a.app}: ${verdict}${news}`);
  }

  const running = results.in_flight.length
    ? `Checks in progress: ${results.in_flight.length}.`
    : "";

  const what = withNews.length
    ? "There are new findings since the previous check. At the start of this session, tell the user which apps have them " +
      "and offer to fix them: call get_review with the run id from latest_results — it lists every finding with where it " +
      "happens, what was tried, what happened, and how to know it is gone."
    : results.apps.length
      ? "Nothing new since the previous check. Call latest_results for details."
      : "No apps yet. Offer to add one with create_app (its URL; test login and scenarios optional).";

  const tail =
    "Use start_check after a deploy (pass app_id, deploy_sha), wait_for_run or get_check_status to follow it, " +
    "and enable_watch / disable_watch for daily checks." +
    (runsReleaseAction ? "" : ` ${RELEASE_ACTION_INSTRUCTION}`);

  const planText = `${planLine(plan)}\n${planRule(plan)}`;

  const fixed = [head, what, running, tail, planText].filter(Boolean);
  const fixedLength = fixed.join("\n").length + "\nApps:\n".length;
  const budget = MAX_INSTRUCTIONS_CHARS - fixedLength;

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i;
    const more = `- and ${rest} more (latest_results lists all)`;
    if (used + lines[i].length + 1 + (rest > 1 ? more.length + 1 : 0) > budget) {
      kept.push(more);
      break;
    }
    kept.push(lines[i]);
    used += lines[i].length + 1;
  }

  return [head, ...(kept.length ? ["Apps:", ...kept] : []), what, running, tail, planText].filter(Boolean).join("\n");
}
