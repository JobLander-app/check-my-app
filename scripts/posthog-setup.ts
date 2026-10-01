// PostHog project setup for the launch (owner, 2026-09-05). Creates, in
// project 595090 (US cloud), exactly what src/lib/analytics.ts expects and
// nothing that already exists:
//
//   1. the multivariate feature flag `landing-variant` (A/B, 50/50, active);
//   2. the experiment "Landing headline A/B" on that flag, as a draft — the
//      primary metric is the funnel $pageview(/check) → check_submitted,
//      secondaries $pageview(/check) → sign_in_clicked and → checkout_opened.
//      Launching it is a deliberate act for when variant B ships (phase 2):
//      pass --launch to set start_date now;
//   3. three saved insights: the landing→checkout funnel, check_submitted by
//      landing_variant, and the quota/one-check trend;
//   4. the boolean flags the server reads, as declared in
//      scripts/posthog-flags.ts: `home-extension-check` (CHE-320) and the
//      redesign's lenses `lens-product` (CHE-352) and `lens-release`
//      (CHE-367) on for the owner's e-mail only, `lens-marketing` (CHE-352)
//      off for everyone. src/lib/viewer-flags.ts sends every property a
//      condition reads as an override, so the match does not wait for PostHog
//      to learn it and no stored value can decide it (CHE-380). Test accounts
//      are answered "off" before PostHog is asked (CHE-334).
//
// Idempotent: looks each object up by key (flag) or exact name (experiment,
// insights) before creating it, and prints ids and URLs either way. The flags
// in 4 are also brought back to their declaration when they drifted. Reads
// POSTHOG_PERSONAL_API_KEY from the environment (.env via dotenv) — never
// commit it, never ship it to a browser. Not part of CI: it mutates a shared
// PostHog project and is run by a person, on purpose.
//
// API shapes come from the project's OpenAPI schema
// (https://us.posthog.com/api/schema/) as of 2026-09-05: experiments carry
// `metrics` / `metrics_secondary` as ExperimentMetric objects and link to a
// pre-existing flag by `feature_flag_key`; insights carry a `query`
// (InsightVizNode → FunnelsQuery | TrendsQuery).
//
// Usage: npm run posthog:setup [-- --launch]

import "dotenv/config";
import { DECLARED_FLAGS, reconcileFlag } from "./posthog-flags";

const PROJECT_ID = 595090;
const APP_HOST = "https://us.posthog.com";
const API = `${APP_HOST}/api/projects/${PROJECT_ID}`;
const FLAG_KEY = "landing-variant";
const EXPERIMENT_NAME = "Landing headline A/B";
const LAUNCH = process.argv.includes("--launch");

const key = process.env.POSTHOG_PERSONAL_API_KEY;
if (!key) {
  console.error("POSTHOG_PERSONAL_API_KEY is not set (put it in .env; it is gitignored).");
  process.exit(2);
}

async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

type Listed<T> = { results: T[] };

// ─── 1. Feature flag ────────────────────────────────────────────────────────

type Flag = { id: number; key: string; active: boolean; filters: { multivariate?: { variants: { key: string; rollout_percentage: number }[] } } };

async function ensureFlag(): Promise<Flag> {
  const found = (await api<Listed<Flag>>("GET", `/feature_flags/?search=${FLAG_KEY}&limit=50`)).results.find((f) => f.key === FLAG_KEY);
  if (found) {
    console.log(`flag        exists  id=${found.id} key=${found.key} active=${found.active} variants=${JSON.stringify(found.filters.multivariate?.variants ?? [])}`);
    return found;
  }
  const created = await api<Flag>("POST", "/feature_flags/", {
    key: FLAG_KEY,
    name: "Landing page variant (A = current headline, B = first-time-visitor headline). Read by useLandingVariant() in src/lib/analytics.ts.",
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100 }],
      multivariate: {
        variants: [
          { key: "A", name: "Current headline", rollout_percentage: 50 },
          { key: "B", name: "First-time-visitor headline", rollout_percentage: 50 },
        ],
      },
    },
  });
  console.log(`flag        created id=${created.id} key=${created.key} active=${created.active}`);
  return created;
}

// ─── 1b. Server-read boolean flags (CHE-320, CHE-352, CHE-367, CHE-380/381) ─
//
// Declared in scripts/posthog-flags.ts and written by its reconcileFlag, the
// same code scripts/verify-lens-flags.ts runs against a fake PostHog. Unlike
// the objects above, these are reconciled, not only created, and read back
// after the write. Create-only is how the is_test_account condition CHE-334
// removed in code stayed live on `home-extension-check` until CHE-380 — a
// condition on a property anyone can set for themselves with the public token.

// ─── 2. Experiment ──────────────────────────────────────────────────────────

type Experiment = { id: number; name: string; start_date: string | null; feature_flag_key: string };

const onCheckPage = {
  kind: "EventsNode",
  event: "$pageview",
  name: "$pageview",
  // The form is the home page (owner, 2026-09-17; it was /check before, and
  // the live experiment 461342 was patched to "/" the same day).
  custom_name: "Landing (/) viewed",
  properties: [{ key: "$pathname", value: "/", operator: "exact", type: "event" }],
};

function funnelMetric(name: string, event: string): unknown {
  return {
    kind: "ExperimentMetric",
    metric_type: "funnel",
    name,
    series: [onCheckPage, { kind: "EventsNode", event, name: event }],
    conversion_window: 14,
    conversion_window_unit: "day",
  };
}

async function ensureExperiment(): Promise<Experiment> {
  const found = (await api<Listed<Experiment>>("GET", `/experiments/?search=${encodeURIComponent(EXPERIMENT_NAME)}&limit=50`)).results.find(
    (e) => e.name === EXPERIMENT_NAME,
  );
  if (found) {
    console.log(`experiment  exists  id=${found.id} flag=${found.feature_flag_key} start_date=${found.start_date ?? "draft"}`);
    if (LAUNCH && !found.start_date) {
      const launched = await api<Experiment>("PATCH", `/experiments/${found.id}/`, { start_date: new Date().toISOString() });
      console.log(`experiment  launched start_date=${launched.start_date}`);
      return launched;
    }
    return found;
  }
  const created = await api<Experiment>("POST", "/experiments/", {
    name: EXPERIMENT_NAME,
    description:
      "Two landing headlines, bucketed by the landing-variant flag. A keeps the current headline; B reads: Paste a link. We'll show you what a first-time visitor hits. Goal: more visitors submit a check.",
    feature_flag_key: FLAG_KEY,
    // "web" means PostHog's no-code web experiments (toolbar-edited, need a
    // variant keyed "control"); ours is code-driven, which PostHog calls
    // "product".
    type: "product",
    start_date: LAUNCH ? new Date().toISOString() : null,
    metrics: [funnelMetric("Landing → check submitted", "check_submitted")],
    metrics_secondary: [
      funnelMetric("Landing → sign-in clicked", "sign_in_clicked"),
      funnelMetric("Landing → checkout opened", "checkout_opened"),
    ],
    exposure_criteria: { filterTestAccounts: true },
    // Needed on 2026-09-05 because the metric events were not ingested yet
    // (the owner named them for this experiment). Phase 2 wired the calls;
    // once check_submitted, sign_in_clicked and checkout_opened show up in
    // the project's event list this line can go — PostHog then validates the
    // names for us, which is the better default.
    allow_unknown_events: true,
  });
  console.log(`experiment  created id=${created.id} flag=${created.feature_flag_key} start_date=${created.start_date ?? "draft"}`);
  return created;
}

// ─── 3. Insights ────────────────────────────────────────────────────────────

type Insight = { id: number; short_id: string; name: string };

const dateRange = { date_from: "-30d", explicitDate: false };
const ev = (event: string, custom_name?: string) => ({ kind: "EventsNode", event, name: event, ...(custom_name ? { custom_name } : {}) });

const INSIGHTS: { name: string; description: string; source: unknown }[] = [
  {
    name: "Landing → Submit → Run → Verdict → Sign-in → Checkout",
    description: "The launch funnel end to end. run_created is a server event; the rest are browser events.",
    source: {
      kind: "FunnelsQuery",
      series: [
        ev("$pageview", "Landing viewed"),
        ev("check_submitted", "Check submitted"),
        ev("run_created", "Run created"),
        ev("verdict_viewed", "Verdict viewed"),
        ev("sign_in_clicked", "Sign-in clicked"),
        ev("checkout_opened", "Checkout opened"),
      ],
      dateRange,
      interval: "day",
      funnelsFilter: { funnelVizType: "steps", funnelOrderType: "ordered", funnelWindowInterval: 14, funnelWindowIntervalUnit: "day", layout: "horizontal" },
      filterTestAccounts: true,
      version: 2,
    },
  },
  {
    name: "check_submitted by landing_variant",
    description: "Checks submitted per day, split by the landing-variant bucket every event carries.",
    source: {
      kind: "TrendsQuery",
      series: [{ ...ev("check_submitted"), math: "total" }],
      breakdownFilter: { breakdown: "landing_variant", breakdown_type: "event" },
      dateRange,
      interval: "day",
      trendsFilter: { display: "ActionsLineGraph" },
      filterTestAccounts: true,
      version: 2,
    },
  },
  {
    name: "Quota hit → one check clicked → one check paid",
    description: "How often the site-wide cap is shown, how often the $1 check is clicked, how often it is paid (server event).",
    source: {
      kind: "TrendsQuery",
      series: [
        { ...ev("quota_site_hit", "Quota panel shown"), math: "total" },
        { ...ev("one_check_clicked", "One check clicked"), math: "total" },
        { ...ev("one_check_paid", "One check paid"), math: "total" },
      ],
      dateRange,
      interval: "day",
      trendsFilter: { display: "ActionsLineGraph" },
      filterTestAccounts: true,
      version: 2,
    },
  },
];

function insightUrl(i: Insight): string {
  return `${APP_HOST}/project/${PROJECT_ID}/insights/${i.short_id}`;
}

async function ensureInsight(spec: (typeof INSIGHTS)[number]): Promise<Insight> {
  const found = (await api<Listed<Insight>>("GET", `/insights/?search=${encodeURIComponent(spec.name)}&saved=true&limit=50`)).results.find(
    (i) => i.name === spec.name,
  );
  if (found) {
    console.log(`insight     exists  id=${found.id} ${insightUrl(found)}  ${found.name}`);
    return found;
  }
  const created = await api<Insight>("POST", "/insights/", {
    name: spec.name,
    description: spec.description,
    saved: true,
    query: { kind: "InsightVizNode", source: spec.source },
  });
  console.log(`insight     created id=${created.id} ${insightUrl(created)}  ${created.name}`);
  return created;
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main() {
  const flag = await ensureFlag();
  const serverFlags: { id: number; key: string }[] = [];
  for (const declared of DECLARED_FLAGS) serverFlags.push(await reconcileFlag(api, declared));
  const experiment = await ensureExperiment();
  const insights: Insight[] = [];
  for (const spec of INSIGHTS) insights.push(await ensureInsight(spec));

  console.log("\nsummary");
  console.log(`  flag        ${flag.id}  ${APP_HOST}/project/${PROJECT_ID}/feature_flags/${flag.id}`);
  for (const f of serverFlags) console.log(`  flag        ${f.id}  ${APP_HOST}/project/${PROJECT_ID}/feature_flags/${f.id}  (${f.key})`);
  console.log(
    `  experiment  ${experiment.id}  ${APP_HOST}/project/${PROJECT_ID}/experiments/${experiment.id}  (${experiment.start_date ? "running" : "draft — run with --launch when variant B ships"})`,
  );
  for (const i of insights) console.log(`  insight     ${i.id}  ${insightUrl(i)}  ${i.name}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
