// The Release lens's data (CHE-367): every release of a team's apps, what the
// check of it found, and what it broke, fixed or left alone against the
// previous release of the same app and env.
//
// A release is a check we were told is a build: Run.deploySha, set by CI
// through POST /api/checks `deploy: {sha, env}` or MCP start_check (CHE-56,
// CHE-368). Nothing else is one. `ephemeral` alone is not: it is the caller's
// "don't make this an app", and on prod its only use so far was three checks
// of a Shopify store that is a build of nothing (#281–283). An ephemeral check
// WITH a sha is a PR preview and is a release in env "preview".
//
// The delta is release against release. Two findings are one problem by
// recurrence's rule (sameIssue, src/lib/recurring.ts, CHE-354), and "looked"
// is recurrence's second look (lookedAgainAt) — one definition for "is it
// still there" and for "did this release fix it":
//   broke     — seen in this release, not in the previous one, and the
//               previous one looked where it was seen;
//   fixed     — seen in the previous release, absent here, and THIS release
//               looked there again;
//   unchanged — seen in both;
//   notCompared — the other release did not look there (a partial check
//               carried the journey, or the walk skipped that step), or the
//               same page shows a problem whose wording no longer matches the
//               earlier one — so neither "broke" nor "fixed" is known.
// A finding anchored to a journey its own check carried is a restatement, not
// something that release saw (src/lib/recurring.ts), and is left out.
//
// Every item says who would have hit it — the owner's question, from the
// Goran call (2026-10-01, 24:45): «it's kinda tricky that it doesn't break for
// the existing customers». See audienceAt.
//
// Price only (Run.priceUsd), never what the check cost us (CLAUDE.md §10).

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { extensionReportPublished } from "@/lib/extension-target";
import { findingSignature, signatureKind, titleSimilarity } from "@/lib/finding-signature";
import { parseJson } from "@/lib/json";
import { lookedAgainAt, positionsSeen, sameIssue, type RecurrenceFinding, type RecurrenceJourney } from "@/lib/recurring";
import { teamOwned, teamRows } from "@/lib/tenant-db";

export type Audience = "existing_users" | "new_visitors" | "unknown";

interface StepInput {
  status: string;
  actions: string | null;
}

export interface ReleaseRunInput {
  publicId: string;
  runNumber: number;
  appId: string | null;
  appSlug: string;
  env: string;
  sha: string;
  status: string;
  verdict: string | null;
  priceUsd: number | null;
  completedAt: Date | null;
  // In journey order: Finding.anchor.stepRef indexes journeys and their steps.
  journeys: Array<{ identity: string; carried: boolean; steps: StepInput[] }>;
  findings: RecurrenceFinding[];
}

export interface ReleaseItem {
  signature: string;
  title: string;
  category: string;
  severity: string;
  audience: Audience;
}

type Counts = { broke: number; fixed: number; unchanged: number; notCompared: number };

export interface Release {
  publicId: string;
  runNumber: number;
  appId: string | null;
  appSlug: string;
  env: string;
  sha: string;
  status: string;
  verdict: string | null;
  priceUsd: number | null;
  completedAt: Date | null;
  // No earlier release of this app in this env: "first release we checked".
  firstRelease: boolean;
  previous: { publicId: string; runNumber: number; sha: string; completedAt: Date | null } | null;
  delta: { broke: ReleaseItem[]; fixed: ReleaseItem[]; unchanged: ReleaseItem[]; notCompared: ReleaseItem[] } | null;
  summary: Record<Audience, Counts>;
}

export function isRelease(run: { deploySha: string | null; ephemeral: boolean }): boolean {
  return Boolean(run.deploySha?.trim());
}

// deployEnv is the caller's own word (CHE-56). The three the lens knows are
// normalised; anything else is shown as the caller named it. A PR preview is
// "preview" whatever it says, and no env at all is a production deploy — the
// only kind CI had to name before previews existed.
export function releaseEnv(run: { deployEnv: string | null; ephemeral: boolean }): string {
  if (run.ephemeral) return "preview";
  const env = run.deployEnv?.trim() ?? "";
  const lower = env.toLowerCase();
  if (!env || ["production", "prod", "live"].includes(lower)) return "production";
  if (["staging", "stage"].includes(lower)) return "staging";
  if (["preview", "pr", "review"].includes(lower)) return "preview";
  return env;
}

// Who would have hit a problem seen on a given step: an existing, signed-in
// user, or a new visitor. Read from what the walk DID, not from what the model
// named the journey: on checkmyapp.dev the walker signs in during "signup" and
// "start-free-land" journeys too (#261, #264, #266), and AppJourney.surface is
// free text ("/public", "/authenticated", "app", "/both") or empty (every
// meetbashar.com journey but two). Each journey runs in a fresh browser
// (src/agent/workflow.ts), so a session is signed in only if this journey
// filled a test credential — and the walk records that fill as the
// {{TEST_EMAIL}} / {{TEST_EMAIL:<label>}} placeholder in Step.actions (CHE-129).
//   existing_users — a non-skipped step up to and including this one filled it;
//   new_visitors   — none did, and the journey recorded its actions;
//   unknown        — the journey recorded no actions at all (before CHE-129),
//                    so a sign-in could have happened unrecorded.
export function audienceAt(steps: StepInput[], index: number): Audience {
  const upTo = steps.slice(0, index + 1);
  if (upTo.some((s) => s.status !== "skipped" && /\{\{TEST_(EMAIL|PASSWORD)(:[^}]*)?\}\}/.test(s.actions ?? ""))) {
    return "existing_users";
  }
  return steps.some((s) => s.actions !== null) ? "new_visitors" : "unknown";
}

interface Seen {
  finding: RecurrenceFinding;
  journey: ReleaseRunInput["journeys"][number] | null;
  stepIndex: number;
}

// What one release saw, with each finding's signature. Restatements of carried
// journeys and our own leftover test records are not the release's.
function seenIn(run: ReleaseRunInput): Array<[string, Seen]> {
  const out: Array<[string, Seen]> = [];
  for (const finding of run.findings) {
    const ref = parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor)?.stepRef;
    const journey = typeof ref?.journeyIndex === "number" ? run.journeys[ref.journeyIndex] ?? null : null;
    if (journey?.carried) continue;
    const signature = finding.signature ?? findingSignature({ appSlug: run.appSlug, ...finding });
    if (signatureKind(signature) === "ours") continue;
    out.push([signature, { finding, journey, stepIndex: typeof ref?.stepIndex === "number" ? ref.stepIndex : -1 }]);
  }
  return out;
}

// Two findings are one problem by recurrence's own rule (sameIssue): one
// signature, and inside a "page" or "req" bucket a title that says the same
// thing — one /login holds many problems, and "X and Y before, only Y now"
// must read as Y unchanged and X fixed.
//
// One problem of one release: its signature, the finding it is shown as, and
// every place the release stated it. A check may state a problem twice, at two
// steps or in two journeys; it is one item of the delta, shown as its first
// finding (by id, so the order findings were stored in decides nothing), and
// "looked there again" must hold for every place it was seen.
interface Problem {
  signature: string;
  shown: Seen;
  places: Seen[];
}

const titleOf = (p: Problem) => p.shown.finding.title;
const same = (a: Problem, b: Problem) =>
  sameIssue({ signature: a.signature, title: titleOf(a) }, { signature: b.signature, title: titleOf(b) });

function problems(list: Array<[string, Seen]>): Problem[] {
  const out: Problem[] = [];
  const byId = [...list].sort((a, b) => a[1].finding.id.localeCompare(b[1].finding.id));
  for (const [signature, seen] of byId) {
    const p: Problem = { signature, shown: seen, places: [seen] };
    const kept = out.find((k) => same(k, p));
    if (kept) kept.places.push(seen);
    else out.push(p);
  }
  return out;
}

// Which earlier problem each current problem is. Every earlier problem answers
// for one current problem at most; as many pairs as can be made are made (a
// broadly worded title must not take the only twin a narrower one has), and
// among equals the closest wording wins. Both sides are in id order, so the
// answer does not depend on the order findings were stored in.
function twins(now: Problem[], before: Problem[]): Map<Problem, Problem> {
  const closeness = (a: Problem, b: Problem) => titleSimilarity(titleOf(a), titleOf(b));
  const candidates = new Map(
    now.map((n) => [n, before.filter((b) => same(b, n)).sort((a, b) => closeness(b, n) - closeness(a, n))]),
  );
  const heldBy = new Map<Problem, Problem>(); // earlier → current
  const place = (n: Problem, visited: Set<Problem>): boolean => {
    for (const b of candidates.get(n)!) {
      if (visited.has(b)) continue;
      visited.add(b);
      const holder = heldBy.get(b);
      if (!holder || place(holder, visited)) {
        heldBy.set(b, n);
        return true;
      }
    }
    return false;
  };
  for (const n of now) place(n, new Set());
  return new Map([...heldBy].map(([b, n]) => [n, b]));
}

const statuses = (j: ReleaseRunInput["journeys"][number]): RecurrenceJourney => ({
  identity: j.identity,
  carried: j.carried,
  steps: j.steps.map((s) => s.status),
});

// Did `other` look where `seen` (from `from`) was seen — by the rule
// recurrence calls a second look (lookedAgainAt), not "the journey is in the
// list": a walked journey can still skip the very step the problem was on.
// Anchored: its journey, executed through the steps its own walk executed up
// to the anchored one. Unanchored: every journey `from` walked, each executed
// through everything that walk executed (a release is a check from the time
// findings are anchored, so recurrence's stricter no-anchor rule applies).
function lookedAt(other: ReleaseRunInput, seen: Seen, from: ReleaseRunInput): boolean {
  const again = (identity: string, positions: number[]) =>
    positions.length > 0 && other.journeys.some((j) => j.identity === identity && lookedAgainAt(statuses(j), positions));
  if (seen.journey) {
    return again(seen.journey.identity, positionsSeen(statuses(seen.journey), seen.stepIndex >= 0 ? seen.stepIndex : null));
  }
  const walked = from.journeys.filter((j) => lookedAgainAt(statuses(j), "any"));
  return walked.length > 0 && walked.every((j) => again(j.identity, positionsSeen(statuses(j), null)));
}

// …at every place the problem was stated: a fix (or a break) is not inferred
// from the one place that happened to be looked at.
const looked = (other: ReleaseRunInput, p: Problem, from: ReleaseRunInput) => p.places.every((seen) => lookedAt(other, seen, from));

function item(p: Problem): ReleaseItem {
  const seen = p.shown;
  return {
    signature: p.signature,
    title: seen.finding.title,
    category: seen.finding.category,
    severity: seen.finding.severity,
    audience: seen.journey && seen.stepIndex >= 0 ? audienceAt(seen.journey.steps, seen.stepIndex) : "unknown",
  };
}

function delta(previous: ReleaseRunInput, current: ReleaseRunInput): NonNullable<Release["delta"]> {
  const before = problems(seenIn(previous));
  const now = problems(seenIn(current));
  const d: NonNullable<Release["delta"]> = { broke: [], fixed: [], unchanged: [], notCompared: [] };
  const twin = twins(now, before);
  const answered = new Set(twin.values());
  for (const n of now) {
    if (twin.has(n)) {
      d.unchanged.push(item(n));
      continue;
    }
    // What is left on both sides under one signature is, by construction, in a
    // bucket with titles that no longer match: the same problem reworded beyond
    // recognition, or one problem fixed and another broken on the same page. We
    // cannot tell which, so it is neither "broke" nor "fixed" (CLAUDE.md §8) —
    // the current one is listed as not compared and the earlier one is its pair.
    const pair = before.find((b) => b.signature === n.signature && !answered.has(b));
    if (pair) {
      answered.add(pair);
      d.notCompared.push(item(n));
    } else (looked(previous, n, current) ? d.broke : d.notCompared).push(item(n));
  }
  for (const b of before) {
    if (answered.has(b)) continue;
    (looked(current, b, previous) ? d.fixed : d.notCompared).push(item(b));
  }
  return d;
}

function summarise(d: Release["delta"]): Release["summary"] {
  const zero = (): Counts => ({ broke: 0, fixed: 0, unchanged: 0, notCompared: 0 });
  const s: Release["summary"] = { existing_users: zero(), new_visitors: zero(), unknown: zero() };
  if (!d) return s;
  for (const key of ["broke", "fixed", "unchanged", "notCompared"] as const) {
    for (const i of d[key]) s[i.audience][key]++;
  }
  return s;
}

// Pure: every release with its delta, newest first. `runs` are releases only;
// the previous release of one is the latest earlier release of the same app
// (appId, else the host) in the same env.
export function computeReleases(runs: ReleaseRunInput[]): Release[] {
  const ordered = [...runs].sort((a, b) => a.runNumber - b.runNumber);
  const lastOf = new Map<string, ReleaseRunInput>();
  const out: Release[] = [];
  for (const run of ordered) {
    const line = `${run.appId ?? run.appSlug}|${run.env}`;
    const previous = lastOf.get(line) ?? null;
    lastOf.set(line, run);
    const d = previous ? delta(previous, run) : null;
    out.push({
      publicId: run.publicId,
      runNumber: run.runNumber,
      appId: run.appId,
      appSlug: run.appSlug,
      env: run.env,
      sha: run.sha,
      status: run.status,
      verdict: run.verdict,
      priceUsd: run.priceUsd,
      completedAt: run.completedAt,
      firstRelease: previous === null,
      previous: previous
        ? { publicId: previous.publicId, runNumber: previous.runNumber, sha: previous.sha, completedAt: previous.completedAt }
        : null,
      delta: d,
      summary: summarise(d),
    });
  }
  return out.reverse();
}

const FINISHED = ["completed", "partial"];

// A team's releases completed in the last `days` (default 30) before `now`,
// newest first. Earlier releases are read too, as the "previous release" of the
// first ones in the window. A check with no App row belongs to the team's app
// of the same host when there is one (#155 on checkmyapp.dev predates the
// App link); a non-preview check of a host the team has no app for — our own
// experiment runs on strangers' sites in August — is not a release of the
// team's apps.
//
// Read flat: the release checks, then their journeys, steps and findings — one
// statement each, bound to the team, stitched here. The nested select this
// replaces (run → journeys → steps) is the shape that crashed the query engine
// on a real team's history when recurrence used it (src/lib/recurring.ts,
// 2026-10-02); the first page to read releases must not find that out again.
const releaseChecksOf = (team: string) =>
  Prisma.sql`r.teamId = ${team} AND r.deploySha IS NOT NULL AND r.status IN ('completed', 'partial')`;

export async function releasesByTeam(
  db: PrismaClient,
  teamId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<Release[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 30) * 86_400_000);
  const [apps, runs, journeys, steps, findings] = await Promise.all([
    db.app.findMany({ where: { ...teamOwned(teamId) }, select: { id: true, appSlug: true } }),
    db.run.findMany({
      where: { ...teamOwned(teamId), deploySha: { not: null }, status: { in: FINISHED } },
      orderBy: { runNumber: "asc" },
      select: {
        id: true, publicId: true, runNumber: true, appId: true, appSlug: true, targetKind: true, deploySha: true, deployEnv: true,
        ephemeral: true, status: true, verdict: true, priceUsd: true, completedAt: true,
      },
    }),
    db.$queryRaw<{ id: string; runId: string; appJourneyId: string | null; journeyKey: string | null; title: string; carriedFromRunId: string | null; status: string }[]>(
      Prisma.sql`SELECT j.id, j.runId, j.appJourneyId, j.journeyKey, j.title, j.carriedFromRunId, j.status
        FROM "Journey" j JOIN "Run" r ON r.id = j.runId WHERE ${releaseChecksOf(teamRows(teamId))} ORDER BY j.runId, j."order"`,
    ),
    db.$queryRaw<{ journeyId: string; status: string; actions: string | null }[]>(
      Prisma.sql`SELECT s.journeyId, s.status, s.actions
        FROM "Step" s JOIN "Journey" j ON j.id = s.journeyId JOIN "Run" r ON r.id = j.runId
        WHERE ${releaseChecksOf(teamRows(teamId))} ORDER BY s.journeyId, s."order"`,
    ),
    db.$queryRaw<(RecurrenceFinding & { runId: string })[]>(
      Prisma.sql`SELECT f.id, f.runId, f.title, f.category, f.severity, f.mark, f.detail, f.anchor, f.signature
        FROM "Finding" f JOIN "Run" r ON r.id = f.runId WHERE ${releaseChecksOf(teamRows(teamId))} ORDER BY f.runId, f.number`,
    ),
  ]);
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const stepsOf = new Map<string, StepInput[]>();
  for (const s of steps) push(stepsOf, s.journeyId, { status: s.status, actions: s.actions });
  const journeysOf = new Map<string, ReleaseRow["journeys"]>();
  for (const { id, runId, ...j } of journeys) push(journeysOf, runId, { ...j, steps: stepsOf.get(id) ?? [] });
  const findingsOf = new Map<string, RecurrenceFinding[]>();
  for (const { runId, ...f } of findings) push(findingsOf, runId, f);
  const rows: ReleaseRow[] = runs.map(({ id, ...r }) => ({ ...r, journeys: journeysOf.get(id) ?? [], findings: findingsOf.get(id) ?? [] }));
  return computeReleases(releaseInputs(rows, apps)).filter((r) => r.completedAt && r.completedAt >= since && r.completedAt <= now);
}

export interface ReleaseRow {
  publicId: string;
  runNumber: number;
  appId: string | null;
  appSlug: string;
  targetKind: string;
  deploySha: string | null;
  deployEnv: string | null;
  ephemeral: boolean;
  status: string;
  verdict: string | null;
  priceUsd: number | null;
  completedAt: Date | null;
  journeys: Array<{
    appJourneyId: string | null;
    journeyKey: string | null;
    title: string;
    carriedFromRunId: string | null;
    status: string;
    steps: StepInput[];
  }>;
  findings: RecurrenceFinding[];
}

// Rows as the loader reads them → the releases computeReleases takes. Shared
// with scripts/report-releases.ts so the read-only prod report runs the same
// rules as the product.
export function releaseInputs(runs: ReleaseRow[], apps: Array<{ id: string; appSlug: string }>): ReleaseRunInput[] {
  // A check with no App row is the app's only when that app is the team's only
  // one of the address — the rule every page that lists an app's checks uses
  // (appHealth). With two apps of one address it is neither's.
  const slugCount = new Map<string, number>();
  for (const a of apps) slugCount.set(a.appSlug, (slugCount.get(a.appSlug) ?? 0) + 1);
  const appBySlug = new Map(apps.filter((a) => slugCount.get(a.appSlug) === 1).map((a) => [a.appSlug, a.id]));
  const inputs: ReleaseRunInput[] = [];
  for (const r of runs) {
    if (!isRelease(r) || !extensionReportPublished(r)) continue;
    const appId = r.appId ?? appBySlug.get(r.appSlug) ?? null;
    if (!appId && !r.ephemeral) continue;
    inputs.push({
      publicId: r.publicId,
      runNumber: r.runNumber,
      appId,
      appSlug: r.appSlug,
      env: releaseEnv(r),
      sha: r.deploySha!,
      status: r.status,
      verdict: r.verdict,
      priceUsd: r.priceUsd,
      completedAt: r.completedAt,
      journeys: r.journeys.map((j) => ({
        identity: j.appJourneyId ?? j.journeyKey ?? j.title,
        carried: j.carriedFromRunId !== null,
        steps: j.steps,
      })),
      findings: r.findings,
    });
  }
  return inputs;
}
