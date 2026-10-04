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
import { createAppForTeam, updateAppForTeam } from "@/lib/app-settings";
import { TERMINAL_RUN_STATUSES, type UserPlan, type WatchFrequency } from "@/lib/enums";
import { ephemeralExpiry, ephemeralGate } from "@/lib/ephemeral";
import { latestResults } from "@/lib/latest-results";
import { assertCanStartRun, watchTrialState } from "@/lib/plans";
import { releaseActionHint, teamRunsTheAction } from "@/lib/release-action";
import { loadReview } from "@/lib/review";
import { loadRunStatus, loadVerdict, type RunStatusPayload } from "@/lib/run-read";
import { can, refusal, type TeamAction, type TeamScope } from "@/lib/scopes";
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
import { DEFAULT_ACCOUNT_LABEL, MAX_EXTRA_ACCOUNTS, normalizeAccountLabel } from "@/lib/test-accounts";
import { MAX_ALLOWED_ORIGINS, parseAllowedOrigins } from "@/lib/allowed-origins";
import type { McpDoor } from "@/lib/started-via";

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
  team: { id: string; name: string; plan: string };
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
    notify_email: z.string().email().optional().describe("Where verdict emails go"),
    frequency: frequency.optional().describe("How often it is checked; default daily"),
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
    notify_email: z.string().email().or(z.literal("")).optional().describe("Verdict email; \"\" clears it"),
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
  },
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

  function deny(action: TeamAction): ToolResult | null {
    if (can(caller.scope, action)) return null;
    return fail("forbidden", refusal(caller.scope, action) ?? "Not allowed", HINTS.forbidden);
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
      notify_email?: string;
      frequency?: WatchFrequency;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const accounts = splitDefault(args.test_accounts, { email: args.test_email, password: args.test_password });
      if ("error" in accounts) return fail("invalid_input", accounts.error);
      const result = await createAppForTeam(
        db,
        { userId: caller.user.id, teamId: team.id, plan },
        {
          targetUrl: args.url,
          focusAreas: args.scenarios,
          scopeHints: args.limits,
          userNotes: args.notes,
          testEmail: accounts.email,
          testPassword: accounts.password,
          testAccounts: accounts.named,
          allowedOrigins: args.allowed_origins,
          storePassword: args.store_password || null,
          notifyEmail: args.notify_email,
          frequency: args.frequency,
        },
      );
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
      notify_email?: string;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const accounts = splitDefault(args.test_accounts, { email: args.test_email, password: args.test_password });
      if ("error" in accounts) return fail("invalid_input", accounts.error);
      if (args.remove_test_accounts?.some((l) => normalizeAccountLabel(l) === DEFAULT_ACCOUNT_LABEL)) {
        return fail("invalid_input", 'The default account is removed with test_email "" and test_password "".');
      }
      const result = await updateAppForTeam(db, { userId: caller.user.id, teamId: team.id, plan }, args.app_id, {
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
        notifyEmail: args.notify_email,
      });
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
    }): Promise<ToolResult> {
      const denied = deny("run.start");
      if (denied) return denied;
      if (Boolean(args.app_id) === Boolean(args.url)) {
        return fail("invalid_input", "Pass app_id (a saved app) or url (a one-off check), not both and not neither.");
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
            "ephemeral, scope_hints and notify_email apply to a url check. A saved app uses its own settings — change them with update_app.",
          );
        }
        const started = await startSavedApp(
          db,
          { id: caller.user.id, teamId: team.id, plan },
          args.app_id,
          { trigger: deps.trigger, siteCap: deps.siteCap, capture: deps.capture, source: caller.door },
          { notes: args.notes, deploy: args.deploy_sha ? { sha: args.deploy_sha, env: args.deploy_env } : undefined },
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
      const app = await db.app.findFirst({
        where: { ...teamOwned(team.id), id: args.app_id, ownerId: caller.user.id },
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
  };
}

export type RemoteTools = ReturnType<typeof createRemoteTools>;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_apps:
    "The team's apps: id, address, scenarios (what must keep working), limits, notes, allowed origins, the test accounts a check " +
    "signs in as (label and email — never a password), whether a store password is stored (has_store_password), " +
    "recurring-check state, what a check of it usually costs " +
    "(usual_price_usd) and whether one can run now, and the last run; plus `plan`: the team's balance, what a check " +
    "typically costs, watched apps, trial, buy_url (top up) and upgrade_url. Start here.",
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
  update_app:
    "Change a saved app: scenarios, limits, notes, test logins, store password, allowed origins, verdict email. Only the fields you " +
    "pass change; \"\" clears a field (for test_password and store_password: removes the stored password). " +
    "test_accounts adds or updates named accounts by label; remove_test_accounts deletes them. When a verdict says " +
    "the store password is needed or was not accepted, set it here.",
  start_check:
    "Start a check. With app_id: checks a saved app using its stored test logins, scenarios and limits — the usual " +
    "call after a deploy (add deploy_sha and deploy_env so the verdict names the build, and notes for what just " +
    "shipped). With url: a one-off check of any address; set ephemeral: true for a PR preview. A check takes about " +
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
};

export function registerRemoteTools(server: McpServer, tools: RemoteTools): void {
  server.registerTool("list_apps", { description: DESCRIPTIONS.list_apps, inputSchema: toolSchemas.list_apps }, () =>
    tools.list_apps(),
  );
  server.registerTool("create_app", { description: DESCRIPTIONS.create_app, inputSchema: toolSchemas.create_app }, (a) =>
    tools.create_app(a),
  );
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
}
