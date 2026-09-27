// The CheckMyApp MCP tools, served at https://checkmyapp.dev/mcp (CHE-315).
//
// The agent is the product's primary interface; the dashboard is visited
// once. So every tool here is a door onto the SAME function the dashboard or
// the public API calls — createAppForTeam / updateAppForTeam
// (src/lib/app-settings.ts), startSavedApp and startCheck with the plan's
// quota (assertCanStartRun), enableWatchForApp / configureWatch with the
// plan's watch cap, loadRunStatus / loadVerdict / loadReview for reading. A
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
import { loadReview } from "@/lib/review";
import { loadRunStatus, loadVerdict, type RunStatusPayload } from "@/lib/run-read";
import { can, refusal, type TeamAction, type TeamScope } from "@/lib/scopes";
import { startCheck } from "@/lib/start-check";
import { startSavedApp } from "@/lib/start-saved-app";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema, normalizeTargetUrl } from "@/lib/validation";
import { configureWatch, enableWatchForApp } from "@/lib/watch-enable";
import { teamOwned } from "@/lib/tenant-db";

// Who is calling: the person who minted the key (attribution), the team the
// key acts for (tenancy, plan, quota) and the key's own scope (CHE-263).
export interface McpCaller {
  user: { id: string; email: string; name: string | null };
  team: { id: string; name: string; plan: string };
  scope: TeamScope;
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
    test_email: z.string().email().optional().describe("Sign-in email of a test account in the app"),
    test_password: z.string().max(500).optional().describe("Its password. Stored encrypted and never returned"),
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
  | "ephemeral_requires_owner";

function fail(code: FailureCode, error: string, hint?: string): ToolResult {
  return text({ ok: false, code, error, ...(hint ? { hint } : {}) }, true);
}

const HINTS: Partial<Record<FailureCode, string>> = {
  quota_free:
    "The Free plan's runs are used. Upgrade the team's plan, or enable_watch on an app you have already checked. Do not retry.",
  plan_limit: "The team's plan does not allow this. Do not retry; tell the user what the plan allows.",
  not_found: "Not one of this team's apps or runs. list_apps and latest_results show what exists.",
  forbidden: "This API key cannot do that. An admin of the team can issue a key with more access.",
};

export function createRemoteTools(caller: McpCaller, deps: McpDeps) {
  const { db, origin } = deps;
  const team = caller.team;
  const plan = team.plan as UserPlan;

  const urls = (id: string) => ({ live_url: `${origin}/run/${id}`, verdict_url: `${origin}/verdict/${id}` });

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
          writeMode: true,
          testEmail: true,
          testPasswordEnc: true,
          watch: { select: { active: true, frequency: true, nextRunAt: true, trialEndsAt: true } },
          runs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { publicId: true, status: true, verdict: true, completedAt: true },
          },
        },
      });
      return text({
        ok: true,
        team: team.name,
        apps: apps.map((a) => {
          const trial = watchTrialState(a.watch, plan);
          const last = a.runs[0];
          return {
            app_id: a.id,
            app: a.appSlug,
            url: a.targetUrl,
            kind: a.targetKind,
            scenarios: a.focusAreas,
            limits: a.scopeHints,
            notes: a.userNotes,
            may_create_test_records: a.writeMode === "create_cleanup",
            // The password never leaves the database; whether one is stored
            // is all an agent needs to know.
            has_test_account: Boolean(a.testEmail && a.testPasswordEnc),
            test_email: a.testEmail,
            watch: !a.watch
              ? { state: a.targetKind === "extension" ? "on_demand" : "off" }
              : {
                  state: !a.watch.active ? "paused" : trial.kind === "ended" ? "trial_ended" : "active",
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
      notify_email?: string;
      frequency?: WatchFrequency;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const result = await createAppForTeam(
        db,
        { userId: caller.user.id, teamId: team.id, plan },
        {
          targetUrl: args.url,
          focusAreas: args.scenarios,
          scopeHints: args.limits,
          userNotes: args.notes,
          testEmail: args.test_email,
          testPassword: args.test_password,
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
      return text({
        ok: true,
        app_id: result.app.id,
        app: result.app.appSlug,
        hint: manual
          ? "Saved. Call start_check with this app_id to check it."
          : "Saved, with a recurring check. The first one is scheduled automatically — its result shows up in " +
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
      notify_email?: string;
    }): Promise<ToolResult> {
      const denied = deny("app.settings.write");
      if (denied) return denied;
      const result = await updateAppForTeam(db, { userId: caller.user.id, teamId: team.id, plan }, args.app_id, {
        focusAreas: args.scenarios,
        scopeHints: args.limits,
        userNotes: args.notes,
        testEmail: args.test_email,
        // "" removes the stored password — the one way to clear it (the
        // settings page's blank box keeps it).
        testPassword: args.test_password === undefined ? undefined : args.test_password || null,
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
          { trigger: deps.trigger, siteCap: deps.siteCap },
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
      const gate = await assertCanStartRun(db, { id: team.id, plan }, null, { siteCap: deps.siteCap() });
      if (!gate.ok) return fail(gate.code, gate.reason, HINTS[gate.code]);
      const expiresAt = ephemeral.ephemeral ? ephemeralExpiry(new Date(deps.now()), deps.ephemeralTtlDays()) : null;
      const run = await startCheck(
        db,
        {
          input,
          ownerId: caller.user.id,
          teamId: team.id,
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
        cost_usd: verdict && "cost_usd" in verdict ? verdict.cost_usd : null,
        error: run.errorMessage ?? null,
        verdict_url: urls(args.run_id).verdict_url,
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
      return text({ ok: true, ...review });
    },

    async latest_results(): Promise<ToolResult> {
      const denied = deny("read");
      if (denied) return denied;
      const results = await latestResults(db, team.id);
      return text({
        ok: true,
        apps: results.apps.map((a) => ({
          ...a,
          verdict_url: a.latest_run ? urls(a.latest_run.run_id).verdict_url : null,
        })),
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
        { frequency: args.frequency },
      );
      switch (result.kind) {
        case "ok":
          return text({ ok: true, app_id: args.app_id, app: result.slug, watch: { state: "active", frequency: args.frequency } });
        case "gated":
          return fail("plan_limit", result.reason, HINTS.plan_limit);
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
    "The team's apps: id, address, scenarios (what must keep working), limits, notes, whether a test login is " +
    "stored (never the password), recurring-check state, and the last run. Start here.",
  create_app:
    "Add an app. Pass its URL; scenarios, limits, notes and a test login are optional and can be changed later " +
    "with update_app. A website gets a recurring check (daily by default) within the team's plan; the first one " +
    "is scheduled automatically. isError with code plan_limit when the plan's app/watch allowance is used.",
  update_app:
    "Change a saved app: scenarios, limits, notes, test login, verdict email. Only the fields you pass change; " +
    "\"\" clears a field (for test_password: removes the stored password).",
  start_check:
    "Start a check. With app_id: checks a saved app using its stored test login, scenarios and limits — the usual " +
    "call after a deploy (add deploy_sha and deploy_env so the verdict names the build, and notes for what just " +
    "shipped). With url: a one-off check of any address; set ephemeral: true for a PR preview. A check takes about " +
    "20–40 minutes; follow it with wait_for_run or get_check_status. Refusals carry a stable code " +
    "(quota_free, quota_site, plan_limit, not_found, forbidden, invalid_input) — do not retry a quota refusal.",
  get_check_status:
    "Status of a run: phase (queued/connecting/surface_scan/discovery/walking/anatomy/writing), terminal state " +
    "(completed/partial/failed), verdict when done, and the latest progress events.",
  wait_for_run:
    "Wait for a run to finish, then return its verdict (bottom line, findings by severity, verdict URL). Each call " +
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
    "are NEW since the app's previous finished run; plus the checks still running. Use at the start of a session.",
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
