// The review: a run's result in the shape a coding agent acts on (CHE-201).
//
// /api/runs/{id}/verdict answers "is the deploy fine?" — a verdict, a bottom
// line, finding titles. An agent that is going to fix things needs the rest:
// each finding's where / what we tried / what happened / evidence, every
// journey step as walked, what was NOT covered, and for each finding the
// sentence that says when it counts as gone. That last part is derived here,
// deterministically, from the finding's own fields — no model in the loop.
//
// Rules that shape every string in this payload:
//   §1  nothing about our machinery, no homework for the reader — the
//       verdict-language gate runs over the sentences this file composes
//       (findings, summaries and steps were gated when they were written);
//   §9  a next action names the symptom, the evidence and how to know it is
//       gone. Never a file, a cause or a fix: what to change is the fixer's
//       call, ours is to say precisely what a user runs into and what the next
//       check must show instead.
//
// The verdict page renders evidence by relative path (/api/evidence/…) and the
// browser resolves it against the page; an agent gets no such page, so every
// URL here is absolute against the origin the review was fetched from. The
// evidence route has no session gate — the unguessable run id is the
// capability, same as the verdict page.

import type { PrismaClient } from "@/generated/prisma/client";
import { extensionReportPublished } from "@/lib/extension-target";
import { normalizeAnatomy } from "@/lib/anatomy";
import { unreachedPages } from "@/lib/coverage";
import { parseJson } from "@/lib/json";
import type { FindingDetail } from "@/lib/types";
import { productName, productProse, splitSentences } from "@/lib/verdict-language";
import { publicRow } from "@/lib/tenant-db";

// ─── Shape ───────────────────────────────────────────────────────────────────

export interface ReviewStep {
  order: number;
  label: string;
  attempted: string | null;
  observed: string | null;
  status: string;
  unverified_reason: string | null;
}

export interface ReviewJourney {
  title: string;
  status: string;
  summary: string | null;
  // CHE-331: not walked by this run — shown as an earlier run walked it.
  carried: boolean;
  steps: ReviewStep[];
}

export interface ReviewEvidence {
  kind: string;
  url: string;
}

export interface ReviewFinding {
  number: number;
  title: string;
  category: string;
  severity: string;
  mark: string;
  where: string | null;
  what_we_tried: string[];
  what_happened: string | null;
  why_it_matters: string | null;
  evidence: ReviewEvidence[];
}

export interface ReviewNextAction {
  finding: number;
  symptom: string;
  how_to_know_it_is_gone: string;
}

export interface ReviewUnverified {
  journey: string;
  step: string;
  reason: string | null;
}

export interface Review {
  run: {
    id: string;
    status: string;
    verdict: string | null;
    deploy: { sha: string; env: string | null } | null;
    startedAt: Date;
    completedAt: Date | null;
    appSlug: string;
  };
  bottom_line: string | null;
  journeys: ReviewJourney[];
  findings: ReviewFinding[];
  // Reserved for the plan-driven check (CHE-204); nothing produces one yet.
  plan_results: never[];
  next_actions: ReviewNextAction[];
  coverage: {
    pages_not_opened: string[];
    unverified: ReviewUnverified[];
  };
  urls: { verdict: string; live: string };
}

// ─── Source rows ─────────────────────────────────────────────────────────────
//
// A structural subset of the Run graph, so the verify script can hand in a
// fixture and the route can hand in a Prisma result without either knowing
// about the other.

export interface ReviewSourceStep {
  order: number;
  label: string;
  status: string;
  attempted: string | null;
  observed: string | null;
  unverifiedReason: string | null;
  networkLog: string | null;
}

export interface ReviewSourceJourney {
  title: string;
  status: string;
  summary: string | null;
  carriedFromRunId?: string | null;
  steps: ReviewSourceStep[];
}

export interface ReviewSourceFinding {
  number: number;
  title: string;
  category: string;
  severity: string;
  mark: string;
  detail: string | null;
  evidence: { type: string; storageUrl: string }[];
}

export interface ReviewSource {
  publicId: string;
  appSlug: string;
  status: string;
  verdict: string | null;
  bottomLine: string | null;
  anatomy: string | null;
  deploySha: string | null;
  deployEnv: string | null;
  startedAt: Date;
  completedAt: Date | null;
  journeys: ReviewSourceJourney[];
  findings: ReviewSourceFinding[];
}

// The one query behind the route. `select` rather than `include` so the
// payload carries nothing it does not show — no credentials columns, no cost,
// no transcript (those are ours; CHE-108).
export const REVIEW_SELECT = {
  targetKind: true,
  publicId: true,
  appSlug: true,
  status: true,
  verdict: true,
  bottomLine: true,
  anatomy: true,
  deploySha: true,
  deployEnv: true,
  startedAt: true,
  completedAt: true,
  journeys: {
    orderBy: { order: "asc" as const },
    select: {
      title: true,
      status: true,
      summary: true,
      carriedFromRunId: true,
      steps: {
        orderBy: { order: "asc" as const },
        select: {
          order: true,
          label: true,
          status: true,
          attempted: true,
          observed: true,
          unverifiedReason: true,
          networkLog: true,
        },
      },
    },
  },
  findings: {
    orderBy: { number: "asc" as const },
    select: {
      number: true,
      title: true,
      category: true,
      severity: true,
      mark: true,
      detail: true,
      evidence: { select: { type: true, storageUrl: true } },
    },
  },
};

export async function loadReview(
  prisma: PrismaClient,
  publicId: string,
  origin: string,
): Promise<Review | null> {
  const run = await prisma.run.findUnique({ ...publicRow(), where: { publicId }, select: REVIEW_SELECT });
  if (run && !extensionReportPublished(run)) return buildReview({ ...run, verdict: null, bottomLine: null, anatomy: null, journeys: [], findings: [] }, origin);
  return run ? buildReview(run, origin) : null;
}

// ─── Building ────────────────────────────────────────────────────────────────

// What the next check must show for a finding of this category to count as
// gone. Category-level on purpose: the symptom is the finding's own words, the
// expectation is the user's, and neither says how to get there (§9).
const EXPECTED_BY_CATEGORY: Record<string, string> = {
  broken: "the action going through as a user would expect",
  risky: "behaviour a user can rely on",
  confusing: "an outcome a user can read at a glance",
  polish: "a finished, consistent state",
  exposed: "nothing shown that the visitor is not entitled to",
};
const EXPECTED_DEFAULT = "what a user would expect";

export function absoluteUrl(origin: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${origin.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

// The symptom in one line: the first line and first sentence of what
// happened. A finding's "what happened" may go on to read the evidence
// ("looks like a cold start") — that reading is diagnosis, and diagnosis is
// the fixer's (§9); the first sentence is what a user saw.
function firstSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const s = splitSentences(line)[0]?.trim() ?? "";
  return s.replace(/[.!?]+$/, "").trim() || null;
}

// The gate for a string this file composes. Labels and one-liners are short
// by design, so the fragment floor is off; what does not survive falls back
// to what the caller passes — never to an empty string.
function gated(text: string | null | undefined, fallback: string): string {
  if (!text) return fallback;
  return productProse(text, 0) ?? fallback;
}

export function nextActionFor(
  finding: Pick<ReviewSourceFinding, "number" | "title" | "category" | "detail">,
  appSlug: string,
): ReviewNextAction {
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  const title = gated(finding.title, `Finding #${finding.number}`);
  const where = detail.where?.trim() || null;
  const observed = gated(firstSentence(detail.whatHappened), title);
  const place = where ?? appSlug;
  const expected = EXPECTED_BY_CATEGORY[finding.category] ?? EXPECTED_DEFAULT;

  const symptom = gated(where ? `${observed} (${where})` : observed, title);
  const gone = gated(
    `The next check of ${place} shows ${expected} instead of "${observed}".`,
    `The next check of ${place} shows ${expected}.`,
  );
  return { finding: finding.number, symptom, how_to_know_it_is_gone: gone };
}

export function buildReview(run: ReviewSource, origin: string): Review {
  const base = origin.replace(/\/+$/, "");

  const journeys: ReviewJourney[] = run.journeys.map((j) => ({
    title: j.title,
    status: j.status,
    summary: j.summary,
    carried: Boolean(j.carriedFromRunId),
    steps: j.steps.map((s) => ({
      order: s.order,
      label: s.label,
      attempted: s.attempted,
      observed: s.observed,
      status: s.status,
      unverified_reason: s.unverifiedReason,
    })),
  }));

  const findings: ReviewFinding[] = run.findings.map((f) => {
    const detail = parseJson<FindingDetail>(f.detail) ?? {};
    return {
      number: f.number,
      title: f.title,
      category: f.category,
      severity: f.severity,
      mark: f.mark,
      where: detail.where ?? null,
      what_we_tried: detail.whatWeTried ?? [],
      what_happened: detail.whatHappened ?? null,
      why_it_matters: detail.whyItMatters ?? null,
      evidence: f.evidence.map((e) => ({ kind: e.type, url: absoluteUrl(base, e.storageUrl) })),
    };
  });

  const next_actions = run.findings.map((f) => nextActionFor(f, run.appSlug));

  // Coverage, the same arithmetic the bottom line's coverage sentence uses
  // (CHE-107): pages discovery wrote down, minus pages any step reached. Only
  // this run's walks count (CHE-331): a carried journey reached its pages on
  // an earlier day, and its skipped steps are that day's gaps, not this run's.
  const pages = (normalizeAnatomy(parseJson<unknown>(run.anatomy))?.pages ?? []).filter(Boolean);
  const walkedHere = run.journeys.filter((j) => !j.carriedFromRunId);
  const steps = walkedHere.flatMap((j) => j.steps);
  const pages_not_opened = unreachedPages(
    pages,
    steps.flatMap((s) => [s.networkLog ?? "", s.observed ?? ""]),
  ).map((p) => p.path);

  const unverified: ReviewUnverified[] = walkedHere.flatMap((j) =>
    j.steps
      .filter((s) => s.status === "skipped")
      .map((s) => ({
        // Names, not prose (CHE-396): "Connect a coding agent…" is what the
        // journey is called, and came out as "A journey" through the word list.
        journey: productName(j.title) ?? "A journey",
        step: productName(s.label) ?? "A step",
        reason: s.unverifiedReason,
      })),
  );

  return {
    run: {
      id: run.publicId,
      status: run.status,
      verdict: run.verdict,
      deploy: run.deploySha ? { sha: run.deploySha, env: run.deployEnv } : null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      appSlug: run.appSlug,
    },
    bottom_line: run.bottomLine,
    journeys,
    findings,
    plan_results: [],
    next_actions,
    coverage: { pages_not_opened, unverified },
    urls: { verdict: `${base}/verdict/${run.publicId}`, live: `${base}/run/${run.publicId}` },
  };
}
