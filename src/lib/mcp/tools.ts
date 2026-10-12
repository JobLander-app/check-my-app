// The CheckMyApp MCP tools, served at https://checkmyapp.dev/mcp (CHE-315).
//
// The agent is the product's primary interface; the dashboard is visited
// once. So every tool here is a door onto the SAME function the dashboard or
// the public API calls — createAppForTeam / updateAppForTeam
// (src/lib/app-settings.ts), startSavedApp and startCheck with the plan's
// balance (assertCanStartRun), enableWatchForApp / configureWatch with the
// Free trial's one watch, loadRunStatus / loadVerdict / loadReview for reading. A
// rule that lived only here would be a rule an agent could get around by using
// the dashboard, or the other way round.
//
// Everything is the key's TEAM's: an app or run of another team is "not
// found", never "forbidden" — a key must not be able to learn what exists
// elsewhere. Each tool asks the scope table (src/lib/scopes.ts) for its own
// action, so a reader key reads and never spends.
//
// A refusal is never thrown: it comes back as a tool result with `isError` and
// a stable `code`, so the calling agent can branch on it (quota → stop,
// not_found → wrong id) instead of parsing an exception string.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrismaClient } from "@/generated/prisma/client";
import type { captureServer } from "@/lib/analytics-server";
import { createActionFor, createAppForTeam, settingsActionFor, updateAppForTeam, type AppSettingsPatch, type CreateAppInput } from "@/lib/app-settings";
import { TERMINAL_RUN_STATUSES, type UserPlan, type WatchFrequency } from "@/lib/enums";
import { ephemeralExpiry, ephemeralGate } from "@/lib/ephemeral";
import { latestResults } from "@/lib/latest-results";
import { assertCanStartRun, watchTrialState } from "@/lib/plans";
import { releaseActionHint, teamRunsTheAction } from "@/lib/release-action";
import { loadReview } from "@/lib/review";
import { loadRunStatus, loadVerdict, type RunStatusPayload } from "@/lib/run-read";
import { TEAM_SCOPES, can, refusal, type TeamAction, type TeamScope } from "@/lib/scopes";
import { startCheck } from "@/lib/start-check";
import { startSavedApp } from "@/lib/start-saved-app";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema, normalizeTargetUrl } from "@/lib/validation";
import { EXTENSION_ON_DEMAND, configureWatch, enableWatchForApp } from "@/lib/watch-enable";
import { BALANCE_PATH, PRICING_PATH, appCanRun, loadPlanStatus } from "@/lib/plan-status";
import { explainRunPrice } from "@/lib/check-price";
import { appPriceRange, teamBalance } from "@/lib/plans";
import { captureBalanceExhausted, isBalanceExhausted } from "@/lib/balance-events";
import { teamOwned } from "@/lib/tenant-db";
import { recountOpenIssuesOfRun } from "@/lib/open-issues";
import { FINDING_MARKS } from "@/lib/validation";
import { DEFAULT_ACCOUNT_LABEL, MAX_EXTRA_ACCOUNTS, normalizeAccountLabel } from "@/lib/test-accounts";
import { MAX_ALLOWED_ORIGINS, parseAllowedOrigins } from "@/lib/allowed-origins";
import { hasFeature, type TeamFeature } from "@/lib/team-features";
import type { McpDoor } from "@/lib/started-via";
import { connectApp } from "@/lib/shopify-connect";
import { appOnStore, connectedShopifyAppOf, scenariosToCarry, shopifyAppOf, storesOf } from "@/lib/shopify-stores";
import { shopifyAdminUrl } from "@/lib/session-view";
import { MCP_CONNECT_COPY } from "@/lib/sign-in-copy";
import { appPath } from "@/lib/app-shell";
import { FEEDBACK_REASONS, FEEDBACK_TEXT_MAX, STATUS_LABEL, giveFeedback, listFeedback, type FeedbackTarget } from "@/lib/feedback";
import {
  DESCRIPTION_MAX as SCENARIO_DESCRIPTION_MAX,
  TITLE_MAX as SCENARIO_TITLE_MAX,
  addScenario,
  listScenarios,
  removeScenario,
  replaceScenario,
  updateScenario,
} from "@/lib/scenarios";

// CHE-322: an agent may send the default account as `test_email`/`test_password`
// (as before) or as the entry labelled "default" in `test_accounts` — the same
// account either way, since the App's own columns ARE the default. Split here,
// once; naming it both ways at once is refused rather than guessed.
function splitDefault<T extends { label: string; email?: string; password?: string }>(
  accounts: T[] | undefined,
  direct: { email?: string; password?: string },
): { error: string } | { email?: string; password?: string; named: T[] } {
  const all = accounts ?? [];
  const named = all.filter((a) => normalizeAccountLabel(a.label) !== DEFAULT_ACCOUNT_LABEL);
  const dflt = all.find((a) => normalizeAccountLabel(a.label) === DEFAULT_ACCOUNT_LABEL);
  if (!dflt) return { email: direct.email, password: direct.password, named };
  if (direct.email !== undefined || direct.password !== undefined) {
    return { error: 'Give the default account once: either test_email/test_password or the "default" entry of test_accounts.' };
  }
  return { email: dflt.email, password: dflt.password, named };
}

// Who is calling: the person who minted the key (attribution), the team the
// key acts for (tenancy, plan, quota) and the key's own scope (CHE-263); and
// the door, which a run it starts records as Run.startedVia (CHE-383).
export interface McpCaller {
  user: { id: string; email: string; name: string | null };
  // CHE-433: `features` decides which tools the team is shown at all.
  team: { id: string; name: string; plan: string; features: readonly TeamFeature[] };
  scope: TeamScope;
  door: McpDoor;
}

// Everything that touches the platform comes in here, so the whole server can
// be exercised in-process: no Workflow binding, no clock, no waiting.
export interface McpDeps {
  db: PrismaClient;
  // The origin links are built against — the one the request came to.
  origin: string;
  trigger: (runId: string) => Promise<void>;
  siteCap: () => number;
  ephemeralTtlDays: () => number;
  capture?: typeof captureServer;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// A Worker request is not a place to hold a 40-minute wait (the stdio server
// held one; a remote call cannot). wait_for_run answers within this budget
// and says `timed_out: true` — the agent calls again. 45s leaves room under the
// 60s most MCP clients allow a call before they give up on it.
export const WAIT_POLL_MS = 5_000;
export const WAIT_BUDGET_MS = 45_000;

const FINISHED = ["completed", "partial"];
const TERMINAL = TERMINAL_RUN_STATUSES as readonly string[];

const frequency = z.enum(["daily", "every_6h", "manual"]);
const runId = z.string().min(1).describe("Run id returned by start_check or latest_results");
const appId = z.string().min(1).describe("App id from list_apps or create_app");
// CHE-322: named test accounts. Shape is checked here; the label rules and the
// final set are checked once, in src/lib/test-accounts.ts, for every caller.
const accountLabel = z.string().min(1).max(40).describe('What this account is, e.g. "admin" or "free user"');
const testAccounts = z
  .array(
    z.object({
      label: accountLabel,
      email: z.string().email().describe("Its sign-in email"),
      password: z.string().min(1).max(500).describe("Its password. Stored encrypted and never returned"),
    }),
  )
  .max(MAX_EXTRA_ACCOUNTS);
// CHE-373: shape here; what counts as an allowed origin is decided once, in
// src/lib/allowed-origins.ts, for every caller.
const allowedOrigins = z
  .array(z.string().min(1).max(200))
  .max(MAX_ALLOWED_ORIGINS)
  .describe(
    "Other https origins the check may open and act on besides the app's own — for an app that runs inside another " +
      "product's page, e.g. ['https://admin.shopify.com', 'https://your-app.example.com'] for a Shopify embedded app",
  );

export const toolSchemas = {
  list_apps: {},
  create_app: {
    url: z.string().min(1).describe("The deployed app's address, e.g. https://your-app.com (or a Chrome Web Store link)"),
    scenarios: z
      .string()
      .max(2000)
      .optional()
      .describe("What must keep working, in plain words — checked on every run, e.g. 'Checkout must never break.'"),
    limits: z.string().max(2000).optional().describe("Where the check may not go, e.g. 'Do not touch /admin.'"),
    notes: z.string().max(2000).optional().describe("Context for every check, e.g. 'Do not delete the test account.'"),
    test_email: z.string().email().optional().describe("Sign-in email of a test account in the app (the \"default\" account)"),
    test_password: z.string().max(500).optional().describe("Its password. Stored encrypted and never returned"),
    test_accounts: testAccounts
      .optional()
      .describe(
        "More test accounts, each a different kind of user, e.g. [{label:'admin', …}, {label:'free user', …}]. " +
          "A scenario that names one ('As admin: refunds work') is checked signed in as it.",
      ),
    allowed_origins: allowedOrigins.optional(),
    store_password: z
      .string()
      .max(500)
      .optional()
      .describe("For a password-protected store (Shopify's 'Enter store password' page): the store password. Stored encrypted and never returned"),
    frequency: frequency.optional().describe("How often it is checked; default daily"),
  },
  connect_shopify_app: {
    app_url: z
      .string()
      .min(1)
      .max(500)
      .describe(MCP_CONNECT_COPY.appUrl),
  },
  update_app: {
    app_id: appId,
    scenarios: z.string().max(2000).optional().describe("Replaces the app's scenarios; \"\" clears them"),
    limits: z.string().max(2000).optional().describe("Replaces the limits; \"\" clears them"),
    notes: z.string().max(2000).optional().describe("Replaces the notes; \"\" clears them"),
    test_email: z.string().email().or(z.literal("")).optional().describe("Test account email; \"\" clears it"),
    test_password: z.string().max(500).optional().describe("New test password; \"\" removes the stored one"),
    test_accounts: z
      .array(
        z.object({
          label: accountLabel,
          email: z.string().email().optional().describe("Required for a new account; omitted keeps the stored one"),
          password: z.string().max(500).optional().describe("Required for a new account; omitted keeps the stored one"),
        }),
      )
      .max(MAX_EXTRA_ACCOUNTS)
      .optional()
      .describe("Adds each named account, or updates the one already stored under that label. Others are kept"),
    remove_test_accounts: z.array(accountLabel).max(MAX_EXTRA_ACCOUNTS).optional().describe("Labels of named accounts to delete"),
    allowed_origins: allowedOrigins.optional().describe("Replaces the app's allowed origins; [] clears them"),
    store_password: z
      .string()
      .max(500)
      .optional()
      .describe("New store password of a password-protected store. Stored encrypted and never returned; \"\" removes it"),
  },
  start_check: {
    app_id: z
      .string()
      .min(1)
      .optional()
      .describe("Check a saved app with its stored test login, scenarios and limits. Use this OR url"),
    url: z.string().url().optional().describe("Or: any deployed URL to check once, e.g. a PR preview"),
    notes: z.string().max(2000).optional().describe("What to focus on this run, e.g. 'PR #123 changed checkout'"),
    scope_hints: z.string().max(2000).optional().describe("With url only: hard limits for this run"),
    notify_email: z.string().email().optional().describe("With url only: email for the verdict-ready notice"),
    deploy_sha: z
      .string()
      .min(7)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional()
      .describe("Commit/build id this deploy shipped, e.g. $GITHUB_SHA — binds the verdict to it"),
    deploy_env: z.string().max(40).optional().describe("Environment the deploy landed in, e.g. production"),
    ephemeral: z
      .boolean()
      .optional()
      .describe("With url only: a throwaway hostname (PR preview) — private, no app kept, deleted after ~7 days"),
    scenarios: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("With app_id: team scenario ids (from list_scenarios) to check this time, besides the daily ones"),
    // CHE-451: a Shopify app on one of its stores, instead of app_id.
    shopify_app: z.string().min(1).optional().describe("Or: a connected Shopify app's handle (list_apps shopify_app), with store"),
    store: z.string().min(1).optional().describe("With shopify_app: which store to check it on, e.g. 'my-staging-store'"),
  },
  // CHE-435: the app's scenarios, edited by id.
  list_scenarios: { app_id: appId },
  add_scenario: {
    app_id: appId,
    title: z.string().min(3).max(SCENARIO_TITLE_MAX).describe("What the scenario is, as a person would name it, e.g. 'Block a country'"),
    description: z
      .string()
      .max(SCENARIO_DESCRIPTION_MAX)
      .optional()
      .describe("What a user does and what should happen, e.g. 'Add Germany in Block Countries; a German visitor sees the block page'"),
    daily: z.boolean().optional().describe("true (default): checked by every check of the app. false: only when a check names it"),
    replaces: z.string().min(1).optional().describe("scenario_id of a scenario the check found that is really this one; it is retired"),
    run_now: z.boolean().optional().describe("Also start a check of the app now that covers it (spends the team's balance)"),
    all_stores: z.boolean().optional().describe("For a Shopify app on several stores: add it on every store of that app, not only this one"),
  },
  update_scenario: {
    scenario_id: z.string().min(1).describe("From list_scenarios or get_review"),
    title: z.string().min(3).max(SCENARIO_TITLE_MAX).optional().describe("New title (team scenarios only)"),
    description: z.string().max(SCENARIO_DESCRIPTION_MAX).optional().describe("New description; \"\" clears it"),
    daily: z.boolean().optional().describe("Checked by every check (true) or only when named (false)"),
  },
  remove_scenario: { scenario_id: z.string().min(1).describe("A team scenario's id; it is retired, its history kept") },
  get_check_status: { run_id: runId },
  wait_for_run: { run_id: runId },
  wait_for_review: { run_id: runId },
  get_verdict: {
    domain_or_run_id: z.string().min(1).describe("Run id, or a domain/URL of one of your apps for its latest result"),
  },
  get_review: { run_id: runId },
  latest_results: {},
  enable_watch: {
    app_id: appId,
    frequency: frequency.default("daily").describe("daily, every_6h or manual"),
  },
  disable_watch: { app_id: appId },
  // CHE-451: another dev store of a Shopify app the team already checks.
  add_store: {
    shopify_app: z.string().min(1).describe("The app's handle, as list_apps shows it in shopify_app"),
    store: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .describe("The store's name as in admin.shopify.com/store/<name>, e.g. 'my-staging-store'"),
  },
  // CHE-434: scenario_id or run_id names where the check got it wrong.
  report_check_mistake: {
    run_id: z.string().min(1).optional().describe("The check (run id)"),
    finding: z.number().int().positive().optional().describe("With run_id: the finding's number, e.g. 3 for #003"),
    journey: z.number().int().positive().optional().describe("With run_id: the journey's position in get_review, 1-based"),
    step: z.number().int().positive().optional().describe("With run_id and journey: the step's position, 1-based"),
    scenario_id: z.string().min(1).optional().describe("Or a scenario of the app, by scenario_id from get_review"),
    reason: z
      .enum(FEEDBACK_REASONS)
      .describe(
        "not_checked: it was not really checked · wrong: the check got it wrong · " +
          "scenario_wrong: it is really a different scenario (scenarios only) · other",
      ),
    text: z.string().min(1).max(FEEDBACK_TEXT_MAX).describe("What really happened, or what the check should have done"),
  },
  // CHE-444: what the team decided about a finding, as the verdict page's buttons do.
  mark_finding: {
    run_id: runId,
    finding: z.number().int().positive().describe("The finding's number, e.g. 3 for #003"),
    mark: z
      .enum(FINDING_MARKS)
      .describe("known: fine as it is, not reported again · watch: check it first next time · fixed · false_positive: not a bug · none: clear the mark"),
  },
  list_check_mistakes: {
    app_id: z.string().min(1).optional().describe("Every report on any check or scenario of this app"),
    scenario_id: z.string().min(1).optional().describe("Or on this scenario"),
    run_id: z.string().min(1).optional().describe("Or on this check, its findings and its steps"),
  },
};

export type ToolName = keyof typeof toolSchemas;

function text(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError } : {}) };
}

export type FailureCode =
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "plan_limit"
  | "quota_anon"
  | "quota_free"
  | "quota_site"
  | "quota_balance"
  | "ephemeral_requires_owner";

// CHE-325: the refusals an upgrade answers carry `upgrade_url`, so the agent
// can hand the person the way forward in the same breath as the limit. CHE-327:
// the balance refusals also carry `buy_url` (a top-up). quota_site /
// quota_anon are the anonymous funnel's caps and never reach a
// key-authenticated team.
const UPGRADABLE: readonly FailureCode[] = ["quota_free", "quota_balance", "plan_limit"];
const TOP_UPPABLE: readonly FailureCode[] = ["quota_free", "quota_balance"];

const HINTS: Partial<Record<FailureCode, string>> = {
  quota_free:
    "The Free plan's credit is used. Give the user buy_url (top up) and upgrade_url. Do not retry.",
  quota_balance:
    "The team's balance is too low for another check. Give the user buy_url (top up) and upgrade_url. Do not retry.",
  plan_limit: "The team's plan does not allow this. Do not retry; tell the user what the plan allows and give them upgrade_url.",
  not_found: "Not one of this team's apps or runs. list_apps and latest_results show what exists.",
  forbidden: "This API key cannot do that. An admin of the team can issue a key with more access.",
};

// What a key of each scope can still do, said with every refusal (CHE-444) —
// naming only the tools this team is offered: the pilot's tools are registered
// for a team given `shopify` alone (registerRemoteTools), and a refusal must
// not send an agent to a call it does not have (CodeRabbit on #317).
export function memberToolsSentence(scope: TeamScope, pilot: boolean): string {
  if (scope === "reader") {
    return `It reads everything: list_apps, latest_results, get_review, get_verdict${pilot ? ", list_scenarios, list_check_mistakes" : ""}.`;
  }
  if (scope === "member") {
    return pilot
      ? "It reads everything and also starts checks (start_check), adds and edits scenarios, reports mistakes of the check and marks findings; " +
          "storing a login and connecting a Shopify store (connect_shopify_app) take an admin key."
      : "It reads everything and also starts checks (start_check); storing a login takes an admin key.";
  }
  return "";
}

// Least privilege first: a refusal names the smallest scope that would do.
const SCOPES_UP: readonly TeamScope[] = ["reader", "member", "admin"];

export function createRemoteTools(caller: McpCaller, deps: McpDeps) {
  const { db, origin } = deps;
  const team = caller.team;
  const plan = team.plan as UserPlan;

  const urls = (id: string) => ({ live_url: `${origin}/run/${id}`, verdict_url: `${origin}/verdict/${id}` });
  const upgradeUrl = `${origin}${PRICING_PATH}`;
  const buyUrl = `${origin}${BALANCE_PATH}`;

  function fail(code: FailureCode, error: string, hint?: string): ToolResult {
    return text(
      {
        ok: false,
        code,
        error,
        ...(hint ? { hint } : {}),
        ...(TOP_UPPABLE.includes(code) ? { buy_url: buyUrl } : {}),
        ...(UPGRADABLE.includes(code) ? { upgrade_url: upgradeUrl } : {}),
      },
      true,
    );
  }

  // CHE-327: what a finished run was priced at and why — the work it paid for,
  // against this app's usual. Null while the run is still going.
  // `price_usd`, the work summary agents budget with (journeys walked, steps),
  // and `price_explanation` — never alone, always with the work it paid for.
  async function priceFields(publicId: string) {
    const p = await explainRunPrice(db, team.id, publicId);
    if (!p) return { price_usd: null };
    return {
      price_usd: p.price_usd,
      journeys_walked: p.journeys_walked,
      steps_walked: p.steps_walked,
      price_explanation: { work: p.work, comparison: p.comparison, usual_price_usd: p.usual, parts: p.parts },
    };
  }

  // CHE-325: what the plan allows and what is left, next to the apps it bounds.
  const planStatus = () => loadPlanStatus(db, { id: team.id, plan }, origin, new Date(deps.now()));

  // CHE-444: a refusal says which key this is, which key would do, and what
  // this one still can — an agent told only "an admin can do that" cannot tell
  // whether start_check or add_scenario will be refused next (Securify's agent,
  // 2026-10-12, on connect_shopify_app).
  function deny(action: TeamAction): ToolResult | null {
    if (can(caller.scope, action)) return null;
    const needs = SCOPES_UP.find((s) => can(s, action)) ?? "admin";
    const canStill = memberToolsSentence(caller.scope, hasFeature(team.features, "shopify"));
    return text(
      {
        ok: false,
        code: "forbidden",
        error: refusal(caller.scope, action) ?? "Not allowed",
        key_scope: caller.scope,
        needs_scope: needs,
        hint:
          `This is a ${caller.scope} key; this call needs ${needs === "admin" ? "an admin" : `a ${needs}`} key. ` +
          `${canStill} An admin of the team mints keys at ${origin}/settings/api-keys.`,
      },
      true,
    );
  }

  // The team's run, or nothing. Reads below go through the shared loaders,
  // which address a run by its public id; this is what makes that the team's.
  async function ownRun(id: string) {
    return db.run.findFirst({ where: { ...teamOwned(team.id), publicId: id }, select: { publicId: true } });
  }

  const runNotFound = () => fail("not_found", "Run not found", HINTS.not_found);

  const failedRunHint = (status: string) =>
    status === "failed"
      ? {
          hint:
            "A failed run is CheckMyApp not finishing, not the app being broken. " +
            "No verdict was published; start another check.",
        }
      : {};

  // Poll until the run stops or the budget is spent. `done: false` carries
  // the answer to return as-is.
  async function pollToTerminal(
    id: string,
  ): Promise<{ done: true; run: RunStatusPayload } | { done: false; result: ToolResult }> {
    if (!(await ownRun(id))) return { done: false, result: runNotFound() };
    const startedAt = deps.now();
    let run = await loadRunStatus(db, id);
    while (run && !TERMINAL.includes(run.status) && deps.now() - startedAt + WAIT_POLL_MS <= WAIT_BUDGET_MS) {
      await deps.sleep(WAIT_POLL_MS);
      run = await loadRunStatus(db, id);
    }
    if (!run) return { done: false, result: runNotFound() };
    if (TERMINAL.includes(run.status)) return { done: true, run };
    return {
      done: false,
      result: text({
        ok: true,
        timed_out: true,
        waited_seconds: Math.round((deps.now() - startedAt) / 1000),
        status: run.status,
        hint:
          "Still running — call this tool again to keep waiting (each call waits up to 45 seconds). " +
          "A full check takes about 20–40 minutes.",
        live_url: urls(id).live_url,
      }),
    };
  }

  return {
    async list_apps(): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const apps = await db.app.findMany({
        where: { ...teamOwned(team.id) },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          appSlug: true,
          targetUrl: true,
          targetKind: true,
          focusAreas: true,
          scopeHints: true,
          userNotes: true,
          allowedOrigins: true,
          writeMode: true,
          testEmail: true,
          testPasswordEnc: true,
          // CHE-372: read only to say whether one is stored.
          storePasswordEnc: true,
          // CHE-322: label and email only. The password column is not selected,
          // so no later edit to the mapping below can leak it.
          testAccounts: { orderBy: { createdAt: "asc" }, select: { label: true, email: true } },
          watch: { select: { active: true, frequency: true, nextRunAt: true, trialEndsAt: true } },
          runs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { publicId: true, status: true, verdict: true, completedAt: true },
          },
        },
      });
      // CHE-327: per app, what a check usually costs and whether one can run
      // now — the gate's own decision, so "paused" here is what the scheduler
      // will do on the next tick.
      const balance = await teamBalance(db, { id: team.id, plan }, new Date(deps.now()));
      const perApp = new Map(
        await Promise.all(
          apps.map(async (a) => {
            const [range, can] = await Promise.all([
              appPriceRange(db, { id: team.id, plan }, a.appSlug),
              appCanRun(db, { id: team.id, plan }, balance, a.appSlug),
            ]);
            return [a.id, { range, can }] as const;
          }),
        ),
      );
      const byHandle = new Map<string, { appId: string; store: string }[]>();
      for (const a of apps) {
        // Only a connected store is another store of the app (a pending one has
        // not had its app confirmed yet).
        const of = connectedShopifyAppOf(a);
        if (of) byHandle.set(of.handle, [...(byHandle.get(of.handle) ?? []), { appId: a.id, store: of.store }]);
      }
      const shopifyFields = (id: string, slug: string, targetUrl: string) => {
        const of = shopifyAppOf({ appSlug: slug, targetUrl });
        if (!of) return {};
        const others = (byHandle.get(of.handle) ?? []).filter((s) => s.appId !== id).map((s) => ({ store: s.store, app_id: s.appId }));
        return { shopify_app: of.handle, store: of.store, other_stores: others };
      };
      return text({
        ok: true,
        team: team.name,
        plan: await planStatus(),
        apps: apps.map((a) => {
          const trial = watchTrialState(a.watch, plan, new Date(deps.now()));
          const last = a.runs[0];
          const money = perApp.get(a.id);
          return {
            app_id: a.id,
            app: a.appSlug,
            url: a.targetUrl,
            kind: a.targetKind,
            scenarios: a.focusAreas,
            limits: a.scopeHints,
            notes: a.userNotes,
            allowed_origins: parseAllowedOrigins(a.allowedOrigins),
            may_create_test_records: a.writeMode === "create_cleanup",
            // The password never leaves the database; whether one is stored
            // is all an agent needs to know.
            has_test_account: Boolean(a.testEmail && a.testPasswordEnc),
            test_email: a.testEmail,
            // CHE-322: every account a check can sign in as, the default first.
            test_accounts: [
              ...(a.testEmail ? [{ label: DEFAULT_ACCOUNT_LABEL, email: a.testEmail, has_password: Boolean(a.testPasswordEnc) }] : []),
              ...a.testAccounts.map((t) => ({ label: t.label, email: t.email, has_password: true })),
            ],
            // CHE-372: whether a store password is stored — never the password.
            has_store_password: Boolean(a.storePasswordEnc),
            // CHE-451: a Shopify app on several stores — which app and store
            // this is, and the same app's other stores in the team.
            ...shopifyFields(a.id, a.appSlug, a.targetUrl),
            // What a check of this app usually costs; null until it has a
            // history (plan.typical_check_price_usd covers it until then).
            usual_price_usd: money?.range ? { low: money.range.low, high: money.range.high } : null,
            can_check_now: money?.can.ok ?? true,
            watch: !a.watch
              ? { state: a.targetKind === "extension" ? "on_demand" : "off" }
              : {
                  state: !a.watch.active
                    ? "paused"
                    : trial.kind === "ended"
                      ? "trial_ended"
                      : money && !money.can.ok
                        ? "paused_balance"
                        : "active",
                  frequency: a.watch.frequency,
                  next_run_at: a.watch.active ? a.watch.nextRunAt : null,
                  trial_days_left: trial.kind === "active" ? trial.daysLeft : null,
                },
            last_run: last
              ? { run_id: last.publicId, status: last.status, verdict: last.verdict, finished_at: last.completedAt }
              : null,
          };
        }),
      });
    },

    // CHE-333: a Shopify app lives inside its store's admin, behind a sign-in
    // only the person may perform. So the agent passes the link to the app in
    // the admin and hands the person a page: they sign in there, the app is
    // picked up, and its first check starts from that page.
    async connect_shopify_app(args: { app_url: string }): Promise<ToolResult> {
      const denied = deny("app.credentials.write");
      if (denied) return denied;
      const result = await connectApp(db, { userId: caller.user.id, teamId: team.id, plan }, args.app_url);
      if ("error" in result) {
        const code = result.code === "duplicate" ? "invalid_input" : result.code;
        return fail(code, result.error, HINTS[code]);
      }
      if (result.connected) {
        return text({ ok: true, app_id: result.appId, store: result.store, app: result.handle, already_connected: true, hint: MCP_CONNECT_COPY.alreadyConnected });
      }
      // CHE-451: the same Shopify app on another store of the team — say so,
      // and how many of its scenarios this store gets once the app is picked.
      const siblings = (await storesOf(db, team.id, result.handle)).filter((s) => s.appId !== result.appId);
      const carry = siblings.length ? await scenariosToCarry(db, team.id, result.appId, result.handle) : 0;
      return text({
        ok: true,
        app_id: result.appId,
        store: result.store,
        app: result.handle,
        sign_in_url: `${deps.origin}${appPath.signIn(result.appId)}`,
        hint: MCP_CONNECT_COPY.signIn,
        ...(siblings.length
          ? {
              other_stores: siblings.map((s) => ({ store: s.store, app_id: s.appId })),
              scenarios_coming: carry,
              same_app_note: `${result.handle} is already connected on ${siblings.map((s) => s.store).join(", ")}; once the app is picked on this store, its ${carry} team scenario${carry === 1 ? "" : "s"} come${carry === 1 ? "s" : ""} with it.`,
            }
          : {}),
      });
    },

    // CHE-451: the same Shopify app on one more dev store. Named for what the
    // agent is doing — adding a store — not "connect an app", which it is not.
    async add_store(args: { shopify_app: string; store: string }): Promise<ToolResult> {
      const denied = deny("app.credentials.write");
      if (denied) return denied;
      const known = await storesOf(db, team.id, args.shopify_app);
      if (known.length === 0) {
        return fail(
          "not_found",
          `No Shopify app ${args.shopify_app} is connected in this team. connect_shopify_app with the link to the app in a store's admin connects it first.`,
          HINTS.not_found,
        );
      }
      const already = known.find((s) => s.store === args.store);
      if (already) return text({ ok: true, app_id: already.appId, store: args.store, app: args.shopify_app, already_connected: true, other_stores: known.filter((s) => s.store !== args.store).map((s) => ({ store: s.store, app_id: s.appId })) });
      return this.connect_shopify_app({ app_url: shopifyAdminUrl(args.store, args.shopify_app) });
    },

    async create_app(args: {
      url: string;
      scenarios?: string;
      limits?: string;
      notes?: string;
      test_email?: string;
      test_password?: string;
      test_accounts?: { label: string; email: string; password: string }[];
      allowed_origins?: string[];
      store_password?: string;
      frequency?: WatchFrequency;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const accounts = splitDefault(args.test_accounts, { email: args.test_email, password: args.test_password });
      if ("error" in accounts) return fail("invalid_input", accounts.error);
      const input: CreateAppInput = {
        targetUrl: args.url,
        focusAreas: args.scenarios,
        scopeHints: args.limits,
        userNotes: args.notes,
        testEmail: accounts.email,
        testPassword: accounts.password,
        testAccounts: accounts.named,
        allowedOrigins: args.allowed_origins,
        storePassword: args.store_password || null,
        frequency: args.frequency,
      };
      // A login is a credentials write — an admin's (src/lib/scopes.ts, CHE-417).
      const deniedLogin = deny(createActionFor(input));
      if (deniedLogin) return deniedLogin;
      const result = await createAppForTeam(db, { userId: caller.user.id, teamId: team.id, plan }, input);
      if ("error" in result) {
        return result.code === "duplicate"
          ? fail("invalid_input", result.error, "The app already exists — list_apps has its app_id; use update_app.")
          : fail(result.code, result.error, HINTS[result.code]);
      }
      const manual = args.frequency === "manual" || result.app.isExtension;
      if (manual) {
        return text({ ok: true, app_id: result.app.id, app: result.app.appSlug, hint: "Saved. Call start_check with this app_id to check it." });
      }
      // A recurring check spends the same balance as any other (CHE-327). When
      // the balance cannot cover one, "scheduled automatically" would be a
      // promise the scheduler then silently breaks — seen live 2026-09-28 on a
      // Free team with $0 left. Say what will happen and hand over both ways out.
      const balance = await teamBalance(db, { id: team.id, plan }, new Date(deps.now()));
      const can = await appCanRun(db, { id: team.id, plan }, balance, result.app.appSlug);
      if (!can.ok) {
        return text({
          ok: true,
          app_id: result.app.id,
          app: result.app.appSlug,
          hint:
            // balanceUsd is null only on an unlimited plan, which appCanRun never refuses.
            `Saved, with a recurring check — but the balance ($${(balance.balanceUsd ?? 0).toFixed(2)} left) does not cover a check ` +
            `of this app (about $${can.estimate_usd.toFixed(2)}), so it waits until a top-up` +
            // Free's credit is one-time; only a paid plan's credit comes back.
            (balance.renewsOn ? ` or the next credit on ${balance.renewsOn}. ` : ". ") +
            "Tell the user and give them buy_url and upgrade_url.",
          buy_url: buyUrl,
          upgrade_url: upgradeUrl,
        });
      }
      return text({
        ok: true,
        app_id: result.app.id,
        app: result.app.appSlug,
        hint:
          "Saved, with a recurring check. The first one is scheduled automatically — its result shows up in " +
          "latest_results; call start_check with this app_id only if you need it sooner.",
      });
    },

    async update_app(args: {
      app_id: string;
      scenarios?: string;
      limits?: string;
      notes?: string;
      test_email?: string;
      test_password?: string;
      test_accounts?: { label: string; email?: string; password?: string }[];
      remove_test_accounts?: string[];
      allowed_origins?: string[];
      store_password?: string;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const accounts = splitDefault(args.test_accounts, { email: args.test_email, password: args.test_password });
      if ("error" in accounts) return fail("invalid_input", accounts.error);
      if (args.remove_test_accounts?.some((l) => normalizeAccountLabel(l) === DEFAULT_ACCOUNT_LABEL)) {
        return fail("invalid_input", 'The default account is removed with test_email "" and test_password "".');
      }
      const patch: AppSettingsPatch = {
        focusAreas: args.scenarios,
        scopeHints: args.limits,
        userNotes: args.notes,
        testEmail: accounts.email,
        // "" removes the stored password — the one way to clear it (the
        // settings page's blank box keeps it).
        testPassword: accounts.password === undefined ? undefined : accounts.password || null,
        // CHE-322: keyed by label — an agent names the account, it has no ids.
        testAccounts: {
          set: accounts.named.map((a) => ({ match: { label: a.label }, ...a })),
          remove: args.remove_test_accounts,
        },
        allowedOrigins: args.allowed_origins,
        // CHE-372: like test_password — "" removes it from the app and its watch.
        storePassword: args.store_password === undefined ? undefined : args.store_password || null,
      };
      // A login is a credentials write — an admin's (src/lib/scopes.ts); the
      // settings page asks the same of the same patch (CHE-417).
      const deniedLogin = deny(settingsActionFor(patch));
      if (deniedLogin) return deniedLogin;
      const result = await updateAppForTeam(db, { userId: caller.user.id, teamId: team.id, plan }, args.app_id, patch);
      if ("error" in result) {
        return result.code === "not_found"
          ? fail("not_found", "App not found", HINTS.not_found)
          : result.code === "plan_limit"
            ? fail("plan_limit", result.error, HINTS.plan_limit)
            : fail("invalid_input", result.error);
      }
      return text({ ok: true, app_id: result.app.id, app: result.app.appSlug });
    },

    async start_check(args: {
      app_id?: string;
      url?: string;
      notes?: string;
      scope_hints?: string;
      notify_email?: string;
      deploy_sha?: string;
      deploy_env?: string;
      ephemeral?: boolean;
      scenarios?: string[];
      shopify_app?: string;
      store?: string;
    }): Promise<ToolResult> {
      const denied = deny("run.start");
      if (denied) return denied;
      // CHE-451: `shopify_app` + `store` names the same saved app as its app_id.
      if (args.shopify_app || args.store) {
        if (args.app_id || args.url) return fail("invalid_input", "Name the app one way: app_id, or shopify_app with store, or url.");
        if (!args.shopify_app || !args.store) {
          const stores = args.shopify_app ? (await storesOf(db, team.id, args.shopify_app)).map((s) => s.store) : [];
          return fail("invalid_input", `shopify_app goes with store${stores.length ? `: ${args.shopify_app} is connected on ${stores.join(", ")}` : ""}.`);
        }
        const appId = await appOnStore(db, team.id, args.shopify_app, args.store);
        if (!appId) {
          const stores = (await storesOf(db, team.id, args.shopify_app)).map((s) => s.store);
          return fail(
            "not_found",
            stores.length
              ? `${args.shopify_app} is not connected on ${args.store}; it is on ${stores.join(", ")}. add_store adds ${args.store}.`
              : `No Shopify app ${args.shopify_app} is connected in this team. connect_shopify_app adds one.`,
            HINTS.not_found,
          );
        }
        args = { ...args, app_id: appId, shopify_app: undefined, store: undefined };
      }
      if (Boolean(args.app_id) === Boolean(args.url)) {
        return fail("invalid_input", "Pass app_id (a saved app) or url (a one-off check), not both and not neither.");
      }
      // CHE-435: scenarios named for this check must be the app's own.
      if (args.scenarios?.length) {
        if (!args.app_id) return fail("invalid_input", "scenarios go with app_id: they are a saved app's scenarios.");
        const known = new Set(((await listScenarios(db, team.id, args.app_id)) ?? []).filter((s) => s.source === "team").map((s) => s.id));
        const unknown = args.scenarios.filter((id) => !known.has(id));
        if (unknown.length) return fail("not_found", `Not a team scenario of this app: ${unknown.join(", ")}. list_scenarios shows them.`);
      }
      const deploy = args.deploy_sha ? { sha: args.deploy_sha, env: args.deploy_env ?? null } : null;
      // CHE-370: a deploy named by hand is the moment to say it can be automatic.
      const releaseAction = releaseActionHint({
        deploySha: args.deploy_sha,
        teamRunsAction: args.deploy_sha ? await teamRunsTheAction(db, team.id) : false,
      });

      if (args.app_id) {
        if (args.ephemeral || args.scope_hints || args.notify_email) {
          return fail(
            "invalid_input",
            "ephemeral, scope_hints and notify_email apply to a url check. A saved app uses its own settings — its limits change with update_app; its verdicts go to the team members chosen in its settings on the site.",
          );
        }
        const started = await startSavedApp(
          db,
          { id: caller.user.id, teamId: team.id, plan },
          args.app_id,
          { trigger: deps.trigger, siteCap: deps.siteCap, capture: deps.capture, source: caller.door },
          { notes: args.notes, deploy: args.deploy_sha ? { sha: args.deploy_sha, env: args.deploy_env } : undefined, scenarios: args.scenarios },
        );
        if ("error" in started) {
          if (started.error === "App not found.") return fail("not_found", "App not found", HINTS.not_found);
          return fail(started.code ?? "plan_limit", started.error, HINTS[started.code ?? "plan_limit"]);
        }
        return text({
          ok: true,
          run_id: started.publicId,
          app_id: args.app_id,
          already_running: started.alreadyRunning === true,
          // A run that was already going is not bound to the build just named.
          deploy: started.alreadyRunning ? null : deploy,
          ...urls(started.publicId),
          hint: started.alreadyRunning
            ? "A check of this app was already running; this is that run. It is not bound to your deploy_sha."
            : "Call wait_for_run (or wait_for_review) until it finishes, or poll get_check_status.",
          ...(releaseAction ? { every_release: releaseAction } : {}),
        });
      }

      const parsed = createCheckSchema.safeParse({
        url: args.url,
        userNotes: args.notes,
        scopeHints: args.scope_hints,
        notifyEmail: args.notify_email,
        deploy: args.deploy_sha ? { sha: args.deploy_sha, env: args.deploy_env } : undefined,
        ephemeral: args.ephemeral,
      });
      if (!parsed.success) return fail("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
      const input = parsed.data;
      // The same three gates POST /api/checks applies to a key-authenticated
      // caller, in the same order: ephemeral, the team's run quota, then start.
      const ephemeral = ephemeralGate(input.ephemeral, caller.user);
      if (!ephemeral.ok) return fail(ephemeral.code, ephemeral.reason);
      const gate = await assertCanStartRun(db, { id: team.id, plan }, null, {
        siteCap: deps.siteCap(),
        appSlug: appSlugFromUrl(input.url),
      });
      if (!gate.ok) {
        if (isBalanceExhausted(gate.code)) {
          await captureBalanceExhausted(deps.capture, { distinctId: caller.user.id, teamId: team.id, plan, source: caller.door });
        }
        return fail(gate.code, gate.reason, HINTS[gate.code]);
      }
      const expiresAt = ephemeral.ephemeral ? ephemeralExpiry(new Date(deps.now()), deps.ephemeralTtlDays()) : null;
      const run = await startCheck(
        db,
        {
          input,
          ownerId: caller.user.id,
          teamId: team.id,
          startedVia: caller.door,
          anonKeyHash: null,
          ephemeral: expiresAt ? { expiresAt } : undefined,
          distinctId: null,
        },
        { trigger: deps.trigger, capture: deps.capture },
      );
      return text({
        ok: true,
        run_id: run.publicId,
        reused: false,
        deploy,
        ephemeral: Boolean(expiresAt),
        expires_at: expiresAt,
        ...urls(run.publicId),
        hint: "Call wait_for_run (or wait_for_review) until it finishes, or poll get_check_status.",
        ...(releaseAction ? { every_release: releaseAction } : {}),
      });
    },

    async get_check_status(args: { run_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      if (!(await ownRun(args.run_id))) return runNotFound();
      const run = await loadRunStatus(db, args.run_id);
      if (!run) return runNotFound();
      const terminal = TERMINAL.includes(run.status);
      return text({
        ok: true,
        run_id: run.publicId,
        status: run.status,
        terminal,
        verdict: run.verdict,
        error: run.errorMessage ?? null,
        recent_events: (run.events ?? []).slice(-5).map((e) => e.text),
        live_url: urls(run.publicId).live_url,
        verdict_url: terminal ? urls(run.publicId).verdict_url : null,
      });
    },

    async wait_for_run(args: { run_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const outcome = await pollToTerminal(args.run_id);
      if (!outcome.done) return outcome.result;
      const run = outcome.run;
      const verdict = await loadVerdict(db, args.run_id);
      const findings = verdict?.findings ?? [];
      const bySeverity: Record<string, number> = {};
      for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      return text({
        ok: true,
        run_id: args.run_id,
        status: run.status,
        verdict: verdict?.verdict ?? run.verdict,
        // Which build this verdict is about — null when the run named none,
        // so a CI gate can refuse to pass on someone else's run.
        deploy: verdict && "deploy" in verdict ? verdict.deploy : null,
        bottom_line: verdict?.bottom_line ?? null,
        findings_by_severity: bySeverity,
        findings: findings.map((f) => `[${f.severity}/${f.category}] ${f.title}`),
        error: run.errorMessage ?? null,
        verdict_url: urls(args.run_id).verdict_url,
        ...(await priceFields(args.run_id)),
        ...failedRunHint(run.status),
      });
    },

    async wait_for_review(args: { run_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const outcome = await pollToTerminal(args.run_id);
      if (!outcome.done) return outcome.result;
      const run = outcome.run;
      const review = await loadReview(db, args.run_id, origin);
      if (!review) return runNotFound();
      const bySeverity: Record<string, number> = {};
      for (const f of review.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      // A head first — verdict, how many findings and of what weight, how many
      // next actions — so a client that reads only the top of a long result
      // still knows whether to act. `review` is the payload untouched.
      return text({
        ok: true,
        run_id: args.run_id,
        status: run.status,
        verdict: review.run.verdict ?? run.verdict,
        findings_by_severity: bySeverity,
        next_actions_count: review.next_actions.length,
        error: run.errorMessage ?? null,
        ...(await priceFields(args.run_id)),
        review,
        ...failedRunHint(run.status),
      });
    },

    async get_verdict(args: { domain_or_run_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const s = args.domain_or_run_id.trim();
      let id: string;
      // Run ids are cuids (no dots); anything with a dot or a slash is a domain.
      if (s.includes(".") || s.includes("/")) {
        const latest = await db.run.findFirst({
          where: { ...teamOwned(team.id), appSlug: appSlugFromUrl(normalizeTargetUrl(s)), status: { in: FINISHED } },
          orderBy: { completedAt: "desc" },
          select: { publicId: true },
        });
        if (!latest) {
          return fail("not_found", `No finished check of "${s}" for this team.`, "Start one with start_check.");
        }
        id = latest.publicId;
      } else {
        if (!(await ownRun(s))) return runNotFound();
        id = s;
      }
      const verdict = await loadVerdict(db, id);
      if (!verdict) return runNotFound();
      return text({ ok: true, run_id: id, ...verdict, verdict_url: urls(id).verdict_url });
    },

    // The review, whole. Nothing is summarised or dropped on the way through:
    // an agent that is going to fix something needs each finding's where /
    // what we tried / what happened / evidence, every step as walked, and what
    // was not covered — the fields the verdict deliberately leaves out.
    async get_review(args: { run_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      if (!(await ownRun(args.run_id))) return runNotFound();
      const review = await loadReview(db, args.run_id, origin);
      if (!review) return runNotFound();
      return text({ ok: true, ...review, ...(await priceFields(args.run_id)) });
    },

    async latest_results(): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const results = await latestResults(db, team.id);
      return text({
        ok: true,
        plan: await planStatus(),
        apps: await Promise.all(
          results.apps.map(async (a) => ({
            ...a,
            verdict_url: a.latest_run ? urls(a.latest_run.run_id).verdict_url : null,
            // CHE-327: what the latest check was priced at, and the work it paid for.
            ...(a.latest_run ? await priceFields(a.latest_run.run_id) : {}),
          })),
        ),
        in_flight: results.in_flight.map((r) => ({ ...r, live_url: urls(r.run_id).live_url })),
      });
    },

    async enable_watch(args: { app_id: string; frequency: WatchFrequency }): Promise<ToolResult> {
      const denied = deny("watch.configure");
      if (denied) return denied;
      const result = await enableWatchForApp(
        db,
        { id: caller.user.id, teamId: team.id, plan },
        args.app_id,
        { frequency: args.frequency, now: new Date(deps.now()) },
      );
      switch (result.kind) {
        case "ok":
          return text({ ok: true, app_id: args.app_id, app: result.slug, watch: { state: "active", frequency: args.frequency } });
        case "gated":
          // An extension is checked on demand on every plan: no upgrade
          // changes that, so it is not a plan refusal and carries no link.
          return result.reason === EXTENSION_ON_DEMAND
            ? fail("invalid_input", result.reason, "Use start_check with this app_id to check it.")
            : fail("plan_limit", result.reason, HINTS.plan_limit);
        default:
          return fail("not_found", "App not found", HINTS.not_found);
      }
    },

    async disable_watch(args: { app_id: string }): Promise<ToolResult> {
      const denied = deny("watch.configure");
      if (denied) return denied;
      // CHE-417: the team's app, whoever added it — the scope gate above decided.
      const app = await db.app.findFirst({
        where: { ...teamOwned(team.id), id: args.app_id },
        select: { id: true, appSlug: true, watch: { select: { id: true, active: true, frequency: true } } },
      });
      if (!app) return fail("not_found", "App not found", HINTS.not_found);
      // Paused, not deleted: the history, the credentials the watch carries
      // and its trial clock stay, and enable_watch resumes it.
      if (app.watch?.active) {
        const result = await configureWatch(db, { teamId: team.id, plan }, app.watch, { active: false });
        if (!result.ok) return fail("plan_limit", result.reason);
      }
      return text({ ok: true, app_id: app.id, app: app.appSlug, watch: { state: app.watch ? "paused" : "off" } });
    },

    async report_check_mistake(args: ReportArgs): Promise<ToolResult> {
      const target = reportTarget(args);
      if ("error" in target) return fail("invalid_input", target.error);
      const result = await giveFeedback(
        db,
        { userId: caller.user.id, teamId: team.id, scope: caller.scope, features: team.features },
        { target, reason: args.reason, text: args.text },
      );
      if (!result.ok) return fail(result.code, result.error, result.code === "not_found" ? HINTS.not_found : undefined);
      return text({ ok: true, report_id: result.id, about: result.kind, status: STATUS_LABEL.open });
    },

    async mark_finding(args: { run_id: string; finding: number; mark: (typeof FINDING_MARKS)[number] }): Promise<ToolResult> {
      const denied = deny("finding.mark");
      if (denied) return denied;
      const run = await db.run.findFirst({
        where: { ...teamOwned(team.id), publicId: args.run_id },
        select: { id: true, appId: true, teamId: true, appSlug: true },
      });
      if (!run) return runNotFound();
      const finding = await db.finding.findFirst({ where: { runId: run.id, number: args.finding }, select: { id: true } });
      if (!finding) return fail("not_found", `Check ${args.run_id} has no finding #${String(args.finding).padStart(3, "0")}.`, HINTS.not_found);
      await db.finding.update({ where: { id: finding.id }, data: { mark: args.mark } });
      // The same follow-up as the verdict page's buttons: Issues counts what is open.
      await recountOpenIssuesOfRun(db, run);
      return text({ ok: true, run_id: args.run_id, finding: args.finding, mark: args.mark });
    },

    async list_check_mistakes(args: { app_id?: string; scenario_id?: string; run_id?: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const named = [args.app_id, args.scenario_id, args.run_id].filter(Boolean).length;
      if (named !== 1) return fail("invalid_input", "Name exactly one of app_id, scenario_id or run_id.");
      const target: FeedbackTarget = args.app_id ? { app_id: args.app_id } : args.scenario_id ? { scenario_id: args.scenario_id } : { run_id: args.run_id! };
      const items = await listFeedback(db, team.id, target);
      if (!items) return fail("not_found", "Not found in this team.", HINTS.not_found);
      return text({
        ok: true,
        reports: items.map((c) => ({
          report_id: c.id,
          about: c.kind,
          run_id: c.runPublicId,
          scenario_id: c.scenarioId,
          ...(c.findingNumber !== null ? { finding: c.findingNumber } : {}),
          ...(c.stepLabel ? { step: c.stepLabel } : {}),
          reason: c.reason,
          text: c.text,
          author: c.author,
          at: c.at,
          status: STATUS_LABEL[c.status] ?? c.status,
        })),
      });
    },

    async list_scenarios(args: { app_id: string }): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const list = await listScenarios(db, team.id, args.app_id);
      if (!list) return fail("not_found", "App not found", HINTS.not_found);
      return text({
        ok: true,
        app_id: args.app_id,
        scenarios: list.map((s) => ({
          scenario_id: s.id,
          title: s.title,
          description: s.description,
          written_by: s.source === "team" ? "team" : "the check",
          daily: s.daily,
          last_result: s.status,
          last_checked_at: s.lastWalkedAt,
        })),
      });
    },

    async add_scenario(args: { app_id: string; title: string; description?: string; daily?: boolean; replaces?: string; run_now?: boolean; all_stores?: boolean }): Promise<ToolResult> {
      if (args.run_now) {
        const denied = deny("run.start");
        if (denied) return denied;
      }
      const input = { title: args.title, description: args.description, daily: args.daily };
      if (args.replaces && !((await listScenarios(db, team.id, args.app_id)) ?? []).some((s) => s.id === args.replaces)) {
        return fail("not_found", "replaces is not a scenario of this app. list_scenarios shows them.", HINTS.not_found);
      }
      const added = args.replaces
        ? await replaceScenario(db, actor(), args.replaces, input)
        : await addScenario(db, actor(), { appId: args.app_id, ...input });
      if (!added.ok) return fail(added.code, added.error, added.code === "not_found" ? HINTS.not_found : undefined);
      // CHE-451: the same scenario on the app's other stores, once per store.
      const alsoOn: { store: string; scenario_id: string }[] = [];
      if (args.all_stores) {
        const own = await db.app.findFirst({ where: { ...teamOwned(team.id), id: args.app_id }, select: { appSlug: true, targetUrl: true } });
        const of = own ? shopifyAppOf(own) : null;
        if (of) {
          for (const s of (await storesOf(db, team.id, of.handle)).filter((x) => x.appId !== args.app_id)) {
            const has = ((await listScenarios(db, team.id, s.appId)) ?? []).some((x) => x.title.trim().toLowerCase() === args.title.trim().toLowerCase());
            if (has) continue;
            const copy = await addScenario(db, actor(), { appId: s.appId, ...input });
            if (copy.ok) alsoOn.push({ store: s.store, scenario_id: copy.id });
          }
        }
      }
      const stores = alsoOn.length ? { also_on: alsoOn } : {};
      if (!args.run_now) return text({ ok: true, scenario_id: added.id, daily: args.daily ?? true, ...stores });
      const started = await startSavedApp(
        db,
        { id: caller.user.id, teamId: team.id, plan },
        args.app_id,
        { trigger: deps.trigger, siteCap: deps.siteCap, capture: deps.capture, source: caller.door },
        { scenarios: [added.id] },
      );
      if ("error" in started) {
        return text({ ok: true, scenario_id: added.id, ...stores, check: { started: false, error: started.error, code: started.code ?? null } });
      }
      // A check that was already running was planned before this scenario
      // existed: it is that run, and it does not cover the new one.
      if (started.alreadyRunning) {
        return text({
          ok: true,
          scenario_id: added.id,
          ...stores,
          check: { started: false, run_id: started.publicId, already_running: true, covers_this_scenario: false, ...urls(started.publicId) },
          hint: `A check of this app was already running and does not cover this scenario. When it ends, call start_check with app_id and scenarios: ["${added.id}"].`,
        });
      }
      return text({ ok: true, scenario_id: added.id, ...stores, check: { started: true, run_id: started.publicId, covers_this_scenario: true, ...urls(started.publicId) } });
    },

    async update_scenario(args: { scenario_id: string; title?: string; description?: string; daily?: boolean }): Promise<ToolResult> {
      const result = await updateScenario(db, actor(), args.scenario_id, { title: args.title, description: args.description, daily: args.daily });
      if (!result.ok) return fail(result.code, result.error, result.code === "not_found" ? HINTS.not_found : undefined);
      return text({ ok: true, scenario_id: args.scenario_id });
    },

    async remove_scenario(args: { scenario_id: string }): Promise<ToolResult> {
      const result = await removeScenario(db, actor(), args.scenario_id);
      if (!result.ok) return fail(result.code, result.error, result.code === "not_found" ? HINTS.not_found : undefined);
      return text({ ok: true, scenario_id: args.scenario_id, removed: true });
    },
  };

  function actor() {
    return { userId: caller.user.id, teamId: team.id, scope: caller.scope, features: team.features };
  }
}

type ReportArgs = {
  scenario_id?: string;
  run_id?: string;
  finding?: number;
  journey?: number;
  step?: number;
  reason: (typeof FEEDBACK_REASONS)[number];
  text: string;
};

// Exactly one of scenario_id / run_id; the positions only with a run.
function reportTarget(a: ReportArgs): FeedbackTarget | { error: string } {
  const named = [a.scenario_id, a.run_id].filter(Boolean).length;
  if (named !== 1) return { error: "Name exactly one of run_id or scenario_id." };
  if (!a.run_id && (a.finding !== undefined || a.journey !== undefined || a.step !== undefined)) {
    return { error: "finding, journey and step go with run_id." };
  }
  if (a.scenario_id) return { scenario_id: a.scenario_id };
  if (a.finding !== undefined && (a.journey !== undefined || a.step !== undefined)) return { error: "Give a finding or a journey, not both." };
  if (a.step !== undefined && a.journey === undefined) return { error: "A step is named with its journey." };
  return { run_id: a.run_id!, finding: a.finding, journey: a.journey, step: a.step };
}

export type RemoteTools = ReturnType<typeof createRemoteTools>;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_apps:
    "The team's apps: id, address, scenarios (what must keep working), limits, notes, allowed origins, the test accounts a check " +
    "signs in as (label and email — never a password), whether a store password is stored (has_store_password), " +
    "recurring-check state, what a check of it usually costs " +
    "(usual_price_usd) and whether one can run now, and the last run; plus `plan`: the team's balance, what a check " +
    "typically costs, watched apps, trial, buy_url (top up) and upgrade_url. A Shopify app also carries shopify_app (its " +
    "handle), store, and other_stores: the same app connected on the team's other stores. Start here.",
  create_app:
    "Add an app. Pass its URL; scenarios, limits, notes and test logins are optional and can be changed later " +
    "with update_app. test_email/test_password is the default account; test_accounts adds named ones (\"admin\", " +
    "\"free user\"), and a scenario that names one (\"As admin: refunds work\") is checked signed in as it. An app " +
    "that runs inside another product's page (a Shopify embedded app) needs allowed_origins: the host page's origin " +
    "and the app's own. For a " +
    "password-protected store (Shopify's \"Enter store password\" page), pass store_password and every check enters " +
    "it. A " +
    "website gets a recurring check (daily by default) within the team's plan; each check spends the team's " +
    "balance, so the first one runs automatically when the balance covers it and otherwise waits for a top-up " +
    "(or, on a paid plan, the next monthly credit) " +
    "(the result's hint says which, with buy_url and upgrade_url). isError with code plan_limit when the plan does " +
    "not allow it.",
  connect_shopify_app: MCP_CONNECT_COPY.description,
  add_store:
    "Add one more dev store to a Shopify app the team already checks — staging, production, a store with the data a " +
    "feature needs. Pass shopify_app (list_apps) and the store's name. The person opens the returned page and confirms " +
    "the app on that store (signing in only if the account cannot open it); the app's team scenarios come with it. " +
    "Then start_check with shopify_app and store checks the app there.",
  update_app:
    "Change a saved app: scenarios, limits, notes, test logins, store password, allowed origins, verdict email. Only the fields you " +
    "pass change; \"\" clears a field (for test_password and store_password: removes the stored password). " +
    "test_accounts adds or updates named accounts by label; remove_test_accounts deletes them. When a verdict says " +
    "the store password is needed or was not accepted, set it here.",
  start_check:
    "Start a check. With app_id: checks a saved app using its stored test logins, scenarios and limits — the usual " +
    "call after a deploy (add deploy_sha and deploy_env so the verdict names the build, and notes for what just " +
    "shipped). A Shopify app on several stores can be named by shopify_app and store instead of app_id. " +
    "With url: a one-off check of any address; set ephemeral: true for a PR preview. A check takes about " +
    "20–40 minutes and spends the team's balance (its price is on wait_for_run / get_review when it finishes); " +
    "follow it with wait_for_run or get_check_status. Refusals carry a stable code (quota_balance, quota_free, " +
    "quota_site, plan_limit, not_found, forbidden, invalid_input) — do not retry a quota refusal; quota_balance and " +
    "quota_free carry buy_url and upgrade_url for the user.",
  get_check_status:
    "Status of a run: phase (queued/connecting/surface_scan/discovery/walking/anatomy/writing), terminal state " +
    "(completed/partial/failed), verdict when done, and the latest progress events.",
  wait_for_run:
    "Wait for a run to finish, then return its verdict (bottom line, findings by severity, verdict URL) and its " +
    "price with the work it paid for (price_usd, journeys_walked, steps_walked, price_explanation). Each call " +
    "waits up to 45 seconds; if the run is still going it returns timed_out: true with the status — call it again. " +
    "A `failed` status is CheckMyApp not finishing, not the app being broken.",
  wait_for_review:
    "wait_for_run's contract, answering with get_review's payload once the run finishes: the one call for " +
    "'check this deploy and give me something I can work from'. Returns timed_out: true after 45 seconds; call again.",
  get_verdict:
    "Verdict of a finished run: bottom line, per-journey outcomes, findings (title/category/severity) and the " +
    "deploy it was bound to. Accepts a run id or the domain of one of the team's apps (its latest result). " +
    "all_good / mostly_ok = healthy; needs_attention / broken = act; unverified = the check walked nothing.",
  get_review:
    "The run's result in the shape you act on — call this when you are going to fix what the check found. Every " +
    "finding in full (where it happens, what was tried, what happened, why it matters, evidence URLs), every " +
    "journey step as walked, what was not covered, and per finding the sentence that says when it counts as gone " +
    "(`next_actions`). It names symptoms and evidence, never files or fixes — what to change is your call.",
  latest_results:
    "For every app of the team: the latest finished run, its verdict, findings by severity, and the findings that " +
    "are NEW since the app's previous finished run, and that run's price with the work it paid for; plus the checks " +
    "still running and `plan` (as in list_apps). " +
    "Use at the start of a session.",
  enable_watch:
    "Turn on (or resume) an app's recurring check at the given frequency, within the team's plan. isError with " +
    "code plan_limit when the plan does not allow it.",
  disable_watch:
    "Pause an app's recurring check. Its history and settings stay; enable_watch resumes it.",
  report_check_mistake:
    "Report where CheckMyApp got a check wrong, so the checker is fixed: something it says it checked but did not " +
    "(not_checked), a finding or step it got wrong (wrong), a scenario that is really a different one " +
    "(scenario_wrong), or another mistake of the check (other). Name it by run_id — optionally with a finding number, " +
    "or a journey position and step position as get_review lists them — or by scenario_id from get_review. The words " +
    "go to the CheckMyApp team as they are; list_check_mistakes shows what happened to each.",
  mark_finding:
    "Record what the team decided about a finding, as the verdict page's buttons do: known (fine as it is — not " +
    "reported again), watch (checked first next time), fixed, false_positive (not a bug), or none to clear it. " +
    "Name it by run_id and the finding's number.",
  list_check_mistakes:
    "Every reported mistake of the check on an app, a scenario or a check — who reported it, what, and its status " +
    "(received, with the CheckMyApp team, being fixed, fixed, not a mistake of the check).",
  list_scenarios:
    "The app's scenarios — what its checks look at: each with scenario_id, title, description, who wrote it (the team " +
    "or the check), whether it is checked every time (daily) and its last result.",
  add_scenario:
    "Add a scenario to an app, in the team's words: a title and what a user does and what should happen. daily: true " +
    "(default) puts it in every check of the app; daily: false keeps it for the checks that name it (start_check " +
    "scenarios). run_now also starts a check now that covers it. If a scenario the check found is really a different " +
    "one, pass its scenario_id as replaces. For a Shopify app on several stores, all_stores: true adds it on every " +
    "store of that app (a store connected later gets the app's scenarios too).",
  update_scenario:
    "Change a scenario by id: a team scenario's title and description; any scenario's description and whether it is " +
    "checked every time (daily).",
  remove_scenario: "Remove a scenario the team wrote; its past checks stay. A scenario the check found is replaced, not removed.",
};

// CHE-433: the tools a team is shown follow what it has been given — a team
// without the "shopify" feature is not offered a Shopify tool it would only be
// refused by.
export function registerRemoteTools(server: McpServer, tools: RemoteTools, features: readonly TeamFeature[] = []): void {
  server.registerTool("list_apps", { description: DESCRIPTIONS.list_apps, inputSchema: toolSchemas.list_apps }, () =>
    tools.list_apps(),
  );
  server.registerTool("create_app", { description: DESCRIPTIONS.create_app, inputSchema: toolSchemas.create_app }, (a) =>
    tools.create_app(a),
  );
  if (hasFeature(features, "shopify")) {
    server.registerTool(
      "connect_shopify_app",
      { description: DESCRIPTIONS.connect_shopify_app, inputSchema: toolSchemas.connect_shopify_app },
      (a) => tools.connect_shopify_app(a),
    );
    server.registerTool("add_store", { description: DESCRIPTIONS.add_store, inputSchema: toolSchemas.add_store }, (a) => tools.add_store(a));
  }
  server.registerTool("update_app", { description: DESCRIPTIONS.update_app, inputSchema: toolSchemas.update_app }, (a) =>
    tools.update_app(a),
  );
  server.registerTool("start_check", { description: DESCRIPTIONS.start_check, inputSchema: toolSchemas.start_check }, (a) =>
    tools.start_check(a),
  );
  server.registerTool(
    "get_check_status",
    { description: DESCRIPTIONS.get_check_status, inputSchema: toolSchemas.get_check_status },
    (a) => tools.get_check_status(a),
  );
  server.registerTool("wait_for_run", { description: DESCRIPTIONS.wait_for_run, inputSchema: toolSchemas.wait_for_run }, (a) =>
    tools.wait_for_run(a),
  );
  server.registerTool(
    "wait_for_review",
    { description: DESCRIPTIONS.wait_for_review, inputSchema: toolSchemas.wait_for_review },
    (a) => tools.wait_for_review(a),
  );
  server.registerTool("get_verdict", { description: DESCRIPTIONS.get_verdict, inputSchema: toolSchemas.get_verdict }, (a) =>
    tools.get_verdict(a),
  );
  server.registerTool("get_review", { description: DESCRIPTIONS.get_review, inputSchema: toolSchemas.get_review }, (a) =>
    tools.get_review(a),
  );
  server.registerTool(
    "latest_results",
    { description: DESCRIPTIONS.latest_results, inputSchema: toolSchemas.latest_results },
    () => tools.latest_results(),
  );
  server.registerTool("enable_watch", { description: DESCRIPTIONS.enable_watch, inputSchema: toolSchemas.enable_watch }, (a) =>
    tools.enable_watch(a),
  );
  server.registerTool(
    "disable_watch",
    { description: DESCRIPTIONS.disable_watch, inputSchema: toolSchemas.disable_watch },
    (a) => tools.disable_watch(a),
  );
  if (hasFeature(features, "shopify")) {
    server.registerTool(
      "report_check_mistake",
      { description: DESCRIPTIONS.report_check_mistake, inputSchema: toolSchemas.report_check_mistake },
      (a) => tools.report_check_mistake(a),
    );
    server.registerTool(
      "list_check_mistakes",
      { description: DESCRIPTIONS.list_check_mistakes, inputSchema: toolSchemas.list_check_mistakes },
      (a) => tools.list_check_mistakes(a),
    );
    server.registerTool("mark_finding", { description: DESCRIPTIONS.mark_finding, inputSchema: toolSchemas.mark_finding }, (a) =>
      tools.mark_finding(a),
    );
    server.registerTool("list_scenarios", { description: DESCRIPTIONS.list_scenarios, inputSchema: toolSchemas.list_scenarios }, (a) =>
      tools.list_scenarios(a),
    );
    server.registerTool("add_scenario", { description: DESCRIPTIONS.add_scenario, inputSchema: toolSchemas.add_scenario }, (a) =>
      tools.add_scenario(a),
    );
    server.registerTool("update_scenario", { description: DESCRIPTIONS.update_scenario, inputSchema: toolSchemas.update_scenario }, (a) =>
      tools.update_scenario(a),
    );
    server.registerTool("remove_scenario", { description: DESCRIPTIONS.remove_scenario, inputSchema: toolSchemas.remove_scenario }, (a) =>
      tools.remove_scenario(a),
    );
  }
}
