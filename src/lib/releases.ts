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
// The delta is release against release, matched by finding signature (CHE-354,
// src/lib/finding-signature.ts), with the same caution recurrence takes:
//   broke     — seen in this release, not in the previous one, and the
//               previous one walked the journey it was seen on;
//   fixed     — seen in the previous release, absent here, and THIS release
//               walked its journey again;
//   unchanged — seen in both;
//   notCompared — the other release did not walk that journey (a partial
//               check carried it), so neither "broke" nor "fixed" is known.
// A finding anchored to a journey its own check carried is a restatement, not
// something that release saw (src/lib/recurring.ts), and is left out.
//
// Every item says who would have hit it — the owner's question, from the
// Goran call (2026-10-01, 24:45): «it's kinda tricky that it doesn't break for
// the existing customers». See audienceAt.
//
// Price only (Run.priceUsd), never what the check cost us (CLAUDE.md §10).

import type { PrismaClient } from "@/generated/prisma/client";
import { extensionReportPublished } from "@/lib/extension-target";
import { findingSignature, signatureKind } from "@/lib/finding-signature";
import { parseJson } from "@/lib/json";
import type { RecurrenceFinding } from "@/lib/recurring";
import { teamOwned } from "@/lib/tenant-db";

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
  journeys: Array<{ identity: string; carried: boolean; walked: boolean; steps: StepInput[] }>;
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

// What one release saw, by signature. Restatements of carried journeys and our
// own leftover test records are not the release's.
function seenIn(run: ReleaseRunInput): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const finding of run.findings) {
    const ref = parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor)?.stepRef;
    const journey = typeof ref?.journeyIndex === "number" ? run.journeys[ref.journeyIndex] ?? null : null;
    if (journey?.carried) continue;
    const signature = finding.signature ?? findingSignature({ appSlug: run.appSlug, ...finding });
    if (signatureKind(signature) === "ours" || out.has(signature)) continue;
    out.set(signature, { finding, journey, stepIndex: typeof ref?.stepIndex === "number" ? ref.stepIndex : -1 });
  }
  return out;
}

const walkedBy = (run: ReleaseRunInput) => new Set(run.journeys.filter((j) => j.walked).map((j) => j.identity));

// Did `other` walk where `seen` (from `from`) was seen? Anchored: its journey.
// Unanchored: every journey `from` walked, since it came from one of them.
function looked(other: ReleaseRunInput, seen: Seen, from: ReleaseRunInput): boolean {
  const walked = walkedBy(other);
  const where = seen.journey ? [seen.journey.identity] : [...walkedBy(from)];
  return where.length > 0 && where.every((j) => walked.has(j));
}

function item(signature: string, seen: Seen): ReleaseItem {
  return {
    signature,
    title: seen.finding.title,
    category: seen.finding.category,
    severity: seen.finding.severity,
    audience: seen.journey && seen.stepIndex >= 0 ? audienceAt(seen.journey.steps, seen.stepIndex) : "unknown",
  };
}

function delta(previous: ReleaseRunInput, current: ReleaseRunInput): NonNullable<Release["delta"]> {
  const before = seenIn(previous);
  const now = seenIn(current);
  const d: NonNullable<Release["delta"]> = { broke: [], fixed: [], unchanged: [], notCompared: [] };
  for (const [sig, seen] of now) {
    if (before.has(sig)) d.unchanged.push(item(sig, seen));
    else (looked(previous, seen, current) ? d.broke : d.notCompared).push(item(sig, seen));
  }
  for (const [sig, seen] of before) {
    if (now.has(sig)) continue;
    (looked(current, seen, previous) ? d.fixed : d.notCompared).push(item(sig, seen));
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
export async function releasesByTeam(
  db: PrismaClient,
  teamId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<Release[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 30) * 86_400_000);
  const [apps, runs] = await Promise.all([
    db.app.findMany({ where: { ...teamOwned(teamId) }, select: { id: true, appSlug: true } }),
    db.run.findMany({
      where: { ...teamOwned(teamId), deploySha: { not: null }, status: { in: FINISHED } },
      orderBy: { runNumber: "asc" },
      select: {
        publicId: true,
        runNumber: true,
        appId: true,
        appSlug: true,
        targetKind: true,
        deploySha: true,
        deployEnv: true,
        ephemeral: true,
        status: true,
        verdict: true,
        priceUsd: true,
        completedAt: true,
        journeys: {
          orderBy: { order: "asc" },
          select: {
            appJourneyId: true,
            journeyKey: true,
            title: true,
            carriedFromRunId: true,
            status: true,
            steps: { orderBy: { order: "asc" }, select: { status: true, actions: true } },
          },
        },
        findings: {
          orderBy: { number: "asc" },
          select: { id: true, title: true, category: true, severity: true, mark: true, detail: true, anchor: true, signature: true },
        },
      },
    }),
  ]);
  return computeReleases(releaseInputs(runs, apps)).filter((r) => r.completedAt && r.completedAt >= since && r.completedAt <= now);
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
  const appBySlug = new Map(apps.map((a) => [a.appSlug, a.id]));
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
        walked: j.carriedFromRunId === null && j.status !== "skipped",
        steps: j.steps,
      })),
      findings: r.findings,
    });
  }
  return inputs;
}
