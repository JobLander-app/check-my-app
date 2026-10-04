// Replay-first daily checks (CHE-51).
//
// A full agent run costs ~$0.53. A Daily Watch that has already been walked
// end-to-end doesn't need that every 24h — most days nothing changed. This
// module is the cheap pre-check the workflow runs first: if it comes back
// green, the run completes carrying the baseline's verdict forward and the
// LLM phases never start.
//
// WHAT THIS IS NOT: it is not a replay of the agent-written Playwright specs.
// Those are standard @playwright/test files (test.describe / expect /
// getByRole) and need the Playwright test runner — which cannot run on
// workerd. scripts/replay.ts does that job on Node, offline. Nor can we replay
// the recorded Steps: they store prose (label / attempted / observed), not
// machine-executable actions.
//
// So the honest contract is a SMOKE check, and it is labelled that way
// everywhere the owner can see it (events, bottom line, verdict page):
//   1. load the homepage in a real browser (Browser Rendering, one session),
//   2. re-visit the URLs the recorded specs navigate to — extracted statically
//      from GeneratedTest.content — plus the paths in the baseline's anatomy,
//   3. every one of them must answer below HTTP 500; a page that does not
//      answer at all is `unreached` — trouble only when it is the homepage or
//      one of the pages a journey depends on (CHE-179, smoke.ts),
//   4. no uncaught JS exceptions, no console-error burst.
// It proves the app is up and its known pages still serve. It proves nothing
// about whether the journeys still work — that's what a full run is for, and
// since CHE-132 a full run is forced when the page survey says the app
// changed, not on a weekly calendar.
//
// Bias on every uncertainty: fall through to the full run. A false alarm costs
// $0.53; a missed regression costs the owner's trust. The one uncertainty that
// is NOT a full run is a page the survey merely saw serve going quiet: on
// 2026-09-04 that sent every watched app full for +$0.6–0.75 apiece, and
// silence is not evidence (rule 3).
//
// CHE-213, 2026-09-07: "the app did not change" now decides the mode instead
// of merely failing to force one. Three of this module's refusals were written
// before the survey existed and each of them sent an app the survey had just
// re-crawled page by page to a full walk anyway — no recorded specs, nothing
// beyond the homepage, and a console burst on a page whose structure had not
// moved since a walk that judged it fine. When two comparable snapshots agree
// none of the three applies: the survey's own re-visit is the coverage they
// were standing in for. An HTTP 5xx, a silent core page, an uncaught exception
// and a console line saying their server answered with an error are live
// signals and still send the run full — the survey compares markup, so a
// backend that started failing leaves the pages identical and only those say
// so. What the survey's answer does let us set aside is said out loud in the
// feed (consoleSetAsideLine), never swallowed.

import type { Browser, Page } from "@cloudflare/playwright";
import type { Verdict } from "@/lib/enums";
import type { AppAnatomy } from "@/lib/types";
import { normalizeAnatomy } from "@/lib/anatomy";
import { parseJson } from "@/lib/json";
import { applyNameShim, launchAgentBrowser, newAgentContext } from "./browser";
import { putScreenshot, type AgentEnv } from "./env";
import { storeAccessFor } from "./credentials";
import { onStoreGate, storeRefused, unlockStoreGate, type StoreAccess, type UnlockPage } from "./store-password";
import {
  MAX_SMOKE_PAGES,
  probeTargets,
  splitSmokeTargets,
  type PageProbe,
  type ProbeOutcome,
  type SmokeTargetSets,
} from "./smoke";
import {
  fullRunGate,
  gateInputFrom,
  smokeTargetsFromSnapshot,
  surveySaysUnchanged,
  type SurveyOutcome,
} from "./snapshot";

// workflow.ts reads these off the replay module; the pure half lives in smoke.ts
// so scripts/verify-smoke-gate.ts can drive it without Browser Rendering.
export { consoleSetAsideLine, quickCheckBottomLine, shortLabel, smokeOutcomeLine, type PageProbe } from "./smoke";

// Browser-time only — no tokens are spent on a smoke pass. Recorded so a run's
// cost column is never a lie by omission and the ledger still sums correctly.
// CHE-327: the number lives with the prices it sets (src/lib/plans.ts).
export { SMOKE_COST_USD } from "@/lib/plans";

// The fuse (CHE-132). Until 2026-09-03 this was the calendar: once the last
// real walk was this old, the next watch run was a full one no matter how
// healthy the pages looked. The owner's decision is that a full walk happens
// when the app CHANGED, and the page survey (survey.ts / snapshot.ts) now
// answers that from a plain fetch — so this bound applies only when two
// snapshots cannot be compared: the first snapshot of an app, a blocked
// homepage, a survey that errored. Still shared with the partial mode
// (CHE-57), which carries journeys forward off the same evidence and must
// expire on the same clock — one drift bound for the whole ladder, not two
// that can disagree.
export const FULL_RUN_MAX_AGE_DAYS = 7;
// How far back to look for that last real walk. Comfortably more than
// FULL_RUN_MAX_AGE_DAYS of daily runs, so the search never ends early on a
// watch that is behaving normally.
const FULL_RUN_LOOKBACK = 12;

// A verdict we're willing to carry forward without re-walking. Anything worse
// means the owner is waiting on a fix confirmation, and "the pages still load"
// is not that. "unverified" is excluded too — a baseline that verified nothing
// is not a baseline.
const REPLAYABLE_VERDICTS: Verdict[] = ["all_good", "mostly_ok"];

export interface SmokeRun {
  id: string;
  appSlug: string;
  targetUrl: string;
  watchId: string | null;
  baselineRunId: string | null;
  // CHE-372: a password-protected store's password, so the pass probes the
  // store's pages and not its /password page thirty times.
  storePasswordEnc?: string | null;
}

/** The smoke check wasn't attempted; the caller runs the full agent check. */
export interface SmokeSkipped {
  taken: false;
  reason: string;
}

/** The smoke check ran. `ok` decides whether the full phases are skipped. */
export interface SmokeReport {
  taken: true;
  ok: boolean;
  /** Baseline verdict, carried onto this run when ok. */
  verdict: Verdict;
  /** Run the verdict came from (the watch's previous run). */
  baselineRunNumber: number;
  /** Run that last actually walked this app — what "nothing changed since" means. */
  fullRunNumber: number;
  /** Lens/anatomy JSON copied from that full run so the verdict page still describes the app. */
  appLens: string | null;
  anatomy: string | null;
  probes: PageProbe[];
  /** Pages that answered — what "N pages healthy" counts (CHE-179). */
  healthy: number;
  /** Pages that did not answer on either attempt (CHE-179). Listed, never healthy. */
  unreached: string[];
  /** Known pages left unvisited because the probe budget ran out (CHE-132). */
  skipped: number;
  failures: string[];
  /** Counted console errors across every page — a fact; the rule is per page (CHE-187). */
  consoleErrors: number;
  /** Pages whose burst was recorded and not counted because the app stood still (CHE-213). */
  consoleBurstsSetAside: string[];
  pageErrors: number;
  screenshotUrl: string | null;
}

export type SmokeResult = SmokeSkipped | SmokeReport;

/**
 * The browser half, injectable so scripts/verify-survey.ts can drive the real
 * decision without Browser Rendering. Production passes probePages.
 */
export type ProbeRunner = (
  env: AgentEnv,
  targetUrl: string,
  targets: SmokeTargetSets,
  opts: { consoleBurstIsTrouble: boolean; store?: StoreAccess },
) => Promise<ProbeOutcome>;

// ─── Decision + execution ────────────────────────────────────────────────────

export async function smokeReplay(
  env: AgentEnv,
  run: SmokeRun,
  survey?: SurveyOutcome | null,
  now: Date = new Date(),
  probe: ProbeRunner = probePages,
): Promise<SmokeResult> {
  if (!run.watchId) return { taken: false, reason: "one-off check — nothing to replay against" };
  if (!run.baselineRunId) {
    return { taken: false, reason: "first run of this watch — no baseline to replay against" };
  }

  const baseline = await env.db.run.findUnique({
    where: { id: run.baselineRunId },
    select: { runNumber: true, status: true, verdict: true },
  });
  if (!baseline || baseline.status !== "completed") {
    return { taken: false, reason: "the previous run didn't complete" };
  }
  const verdict = baseline.verdict as Verdict | null;
  if (!verdict || !REPLAYABLE_VERDICTS.includes(verdict)) {
    return {
      taken: false,
      reason: `last verdict was "${verdict ?? "none"}" — that needs a real check, not a smoke test`,
    };
  }

  const full = await findLastWalkedRun(env, run.watchId);
  if (!full?.completedAt) {
    return { taken: false, reason: "no recent full agent check to carry forward" };
  }
  // CHE-132: the survey decides. A changed app gets a full walk whatever its
  // age; an unchanged one never gets one for age alone; with no comparison
  // the seven-day fuse holds as it always did.
  const ageDays = (now.getTime() - full.completedAt.getTime()) / 86_400_000;
  const gate = fullRunGate(gateInputFrom(survey, ageDays, FULL_RUN_MAX_AGE_DAYS));
  if (gate.force) return { taken: false, reason: gate.reason };

  // CHE-213: the survey's answer is what decides how much this day costs. Two
  // comparable snapshots that agree mean every page the survey knows was
  // re-visited this run and came back identical — which is more coverage than
  // the two refusals below were ever standing in for. So they apply only when
  // the survey could not answer.
  const unchanged = surveySaysUnchanged(survey);

  // "Specs missing → full run": with nothing recorded there is nothing to
  // re-visit, and a homepage-only smoke pass would be worth less than its
  // reassurance. Written before CHE-132 gave the pass the survey's pages.
  const specs = await env.db.generatedTest.findMany({
    where: { appSlug: run.appSlug },
    orderBy: [{ title: "asc" }, { version: "desc" }],
    distinct: ["title"],
    select: { content: true },
  });
  if (specs.length === 0 && !unchanged) {
    return { taken: false, reason: "no recorded specs for this app yet" };
  }

  // Specs and anatomy say where the journeys went; the survey says what else
  // serves. Two sets, not one (CHE-179): the first CORE_SMOKE_PAGES of the
  // spec/anatomy list are the pre-CHE-132 smoke pass — the pages a journey
  // depends on, where a silence is trouble. Everything else (the rest of that
  // list and whatever the survey saw) is probed after them and a silence there
  // is `unreached`, not a reason to spend on a full run.
  const targets = splitSmokeTargets(
    smokeTargets(run.targetUrl, specs.map((s) => s.content), normalizeAnatomy(parseJson<unknown>(full.anatomy))),
    smokeTargetsFromSnapshot(survey?.snapshot, run.targetUrl),
  );
  // Specs that navigate nowhere we can pin down (and an anatomy we couldn't
  // read paths out of) leave only the homepage. Same reasoning as no specs at
  // all: "the front door opens" is not enough to skip a day's check on —
  // unless the survey already re-checked the pages and found them identical.
  if (targets.core.length + targets.extra.length === 0 && !unchanged) {
    return { taken: false, reason: "nothing beyond the homepage to re-check" };
  }

  const outcome = await probe(env, run.targetUrl, targets, {
    consoleBurstIsTrouble: !unchanged,
    ...(run.storePasswordEnc ? { store: await storeAccessFor(env, run) } : {}),
  });
  return {
    taken: true,
    ok: outcome.failures.length === 0,
    verdict,
    baselineRunNumber: baseline.runNumber,
    fullRunNumber: full.runNumber,
    appLens: full.appLens,
    anatomy: full.anatomy,
    ...outcome,
  };
}

// ─── "When did anyone last actually walk this app?" ──────────────────────────

export interface WalkedRun {
  id: string;
  runNumber: number;
  completedAt: Date | null;
  appLens: string | null;
  anatomy: string | null;
}

// The verdict chain runs through smoke passes, so "the previous run" is not
// necessarily the last time anyone walked this app. Journeys are the tell: a
// smoke run writes none. Walked backwards with a count() per candidate rather
// than a `journeys: { some: {} }` relation filter — every query shape here is one
// this codebase already runs in production. The window is generous
// (FULL_RUN_MAX_AGE_DAYS of daily runs fits inside it) and running off the end
// just means a full run, which is the safe direction.
//
// Both cheap modes hang off this: smoke carries its verdict forward, partial
// (CHE-57) carries its healthy journeys forward.
export async function findLastWalkedRun(
  env: AgentEnv,
  watchId: string,
): Promise<WalkedRun | null> {
  const recent = await env.db.run.findMany({
    where: { watchId, status: "completed" },
    orderBy: { completedAt: "desc" },
    take: FULL_RUN_LOOKBACK,
    select: { id: true, runNumber: true, completedAt: true, appLens: true, anatomy: true },
  });
  for (const candidate of recent) {
    if ((await env.db.journey.count({ where: { runId: candidate.id } })) > 0) {
      return candidate;
    }
  }
  return null;
}

// ─── Target extraction ───────────────────────────────────────────────────────
// The recorded specs are the best record we have of where the journeys go:
// their goto() calls are literal URLs, no interpretation needed. Anatomy paths
// fill in the rest of the map. Everything is rebased onto this run's origin —
// the specs run against process.env.TARGET_URL, so their hardcoded fallback
// host is meaningless.

const GOTO_PATTERNS: RegExp[] = [
  // goto('/check') · goto("https://app.example/check")
  /\.goto\(\s*['"]([^'"]+)['"]/g,
  // goto(BASE_URL + '/check')
  /\.goto\(\s*[A-Za-z_$][\w$]*\s*\+\s*['"]([^'"]+)['"]/g,
  // goto(`${BASE_URL}/check`)
  /\.goto\(\s*`\$\{[A-Za-z_$][\w$]*\}([^`]*)`/g,
];

export function smokeTargets(
  targetUrl: string,
  specs: string[],
  anatomy: AppAnatomy | null,
): string[] {
  let origin: string;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    return [];
  }

  const out = new Set<string>();
  const home = new URL(targetUrl).toString();
  for (const spec of specs) {
    for (const pattern of GOTO_PATTERNS) {
      // Each RegExp is module-level and /g, so reset lastIndex per use.
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(spec)) !== null) {
        const url = rebase(m[1], origin);
        if (url && url !== home) out.add(url);
      }
    }
  }
  for (const entry of anatomy?.pages ?? []) {
    const path = anatomyPath(entry);
    if (!path) continue;
    const url = rebase(path, origin);
    if (url && url !== home) out.add(url);
  }
  return [...out].slice(0, MAX_SMOKE_PAGES);
}

// Anatomy pages are LLM-written labels, not URLs. The shapes actually stored
// (checked against real runs): "/tutorials/mirror-mode", "/login  (Log In
// page)", and "/ login  (Log In page)" — a path, optionally followed by a
// description, occasionally with a stray space inside the path itself. Take the
// leading token, drop the description, and discard anything still ambiguous
// rather than repairing it: probing an invented URL would pad "N pages healthy"
// with a page that never existed.
function anatomyPath(entry: string): string | null {
  const path = entry.split(/\s{2,}|\s+\(/)[0].trim();
  return /^\/\S*$/.test(path) ? path : null;
}

// Any literal → an absolute URL on the target's origin, or null if it isn't a
// plain http(s) path we can safely visit.
function rebase(raw: string, origin: string): string | null {
  const trimmed = raw.trim();
  // An unresolved template expression ("/app/${id}") isn't a real URL.
  if (!trimmed || trimmed.includes("${") || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed, origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return new URL(parsed.pathname + parsed.search, origin).toString();
  } catch {
    return null;
  }
}

// ─── The browser pass ────────────────────────────────────────────────────────
// One Browser Rendering session around smoke.ts's probeTargets; the rules
// live there so they can be checked without a browser.

async function probePages(
  env: AgentEnv,
  targetUrl: string,
  targets: SmokeTargetSets,
  opts: { consoleBurstIsTrouble: boolean; store?: StoreAccess },
): Promise<ProbeOutcome> {
  const browser: Browser = await launchAgentBrowser(env);
  // CHE-193: on our own hosts the context announces itself on the requests the
  // web half guards, and on nothing else (CHE-212; self-hosts.ts).
  const context = await newAgentContext(browser, targetUrl, env.bindings);
  try {
    const page: Page = await context.newPage();
    await applyNameShim(page);
    const locked = await smokeStoreGate(page, targetUrl, opts.store);
    if (locked) return locked;
    return await probeTargets(page, targetUrl, targets, {
      consoleBurstIsTrouble: opts.consoleBurstIsTrouble,
      saveScreenshot: async () =>
        (await putScreenshot(env, await page.screenshot({ fullPage: false }))).storageUrl,
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// The feed reads "Smoke found trouble: <this> — running the full check": an
// access fact about their store, never about our pass.
export const STORE_LOCKED_SMOKE_FAILURE = "the store password was not accepted, so the store's pages could not be reached";
export const STORE_GATED_SMOKE_FAILURE =
  "every page of the store leads to its password page, so the store's pages could not be reached";

/**
 * CHE-372: a locked store unlocks once per context; its cookie carries the
 * rest of the pass. A store that stays locked — its password turned away, or
 * none held at all (an owner who cleared it, a store that was public at the
 * last full walk) — cannot be probed: every page would be its password page
 * answering 200, which is exactly the "all healthy" a carried-forward verdict
 * must not rest on. So the pass fails with the reason and the run goes on to
 * the full check, whose verdict asks for the store password. Checked on every
 * pass, password or not, for that reason. Null = probe as usual.
 */
export async function smokeStoreGate(
  page: UnlockPage & Pick<Page, "goto">,
  targetUrl: string,
  store: StoreAccess | undefined,
): Promise<ProbeOutcome | null> {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  const outcome = await unlockStoreGate(page, targetUrl, store ?? {});
  if (storeRefused(outcome)) return storeLockedOutcome(STORE_LOCKED_SMOKE_FAILURE);
  if (await onStoreGate(page, targetUrl)) return storeLockedOutcome(STORE_GATED_SMOKE_FAILURE);
  return null;
}

function storeLockedOutcome(failure: string): ProbeOutcome {
  return {
    probes: [],
    healthy: 0,
    unreached: [],
    skipped: 0,
    failures: [failure],
    consoleErrors: 0,
    consoleBurstsSetAside: [],
    pageErrors: 0,
    screenshotUrl: null,
  };
}
