// Creating a run from a submission and handing it to the agent — the one
// path, shared by the free form (/api/checks) and the paid one-off check
// (src/lib/one-check.ts). Everything that decides WHETHER a run may start —
// Turnstile, quotas, the same-domain reuse — stays with the caller; this is
// only what happens once that is settled.

import type { PrismaClient } from "@/generated/prisma/client";
import { nextRunNumber } from "@/lib/db";
import { triggerRun } from "@/lib/trigger";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { captureServer, serverDistinctId } from "@/lib/analytics-server";
import type { CreateCheckInput } from "@/lib/validation";
import { extensionColumns } from "@/lib/extension-target";
import { alreadyScoped } from "@/lib/tenant-db";
export interface StartCheckOptions {
  // The validated submission (createCheckSchema output).
  input: CreateCheckInput;
  // Attribution: a signed-in owner, or the anonymous client's salted IP hash.
  ownerId: string | null;
  // CHE-253: the team whose plan pays for this run. Null exactly when ownerId
  // is — an anonymous check belongs to nobody and is billed to nobody.
  teamId?: string | null;
  // CHE-327: which door started it (Run.startedVia) — measurement only.
  // CHE-383: "action" is MCP called by our GitHub Action (src/lib/started-via.ts).
  startedVia?: "ui" | "api" | "mcp" | "action" | "anon";
  anonKeyHash: string | null;
  // A paid one-off check: the Stripe Checkout Session that paid for it. The
  // column is unique, so a second start on the same payment fails at the
  // insert instead of producing a second run.
  paid?: { checkoutSessionId: string };
  // CHE-202: an ephemeral run (a PR preview) and when it is deleted. Set only
  // by the API route, and only for an owner — the gate that decides that is
  // ephemeralGate in src/lib/ephemeral.ts, with the caller. No App row is
  // created for any run here, ephemeral or not: Apps come from onboarding,
  // Enable Daily Watch and Connect GitHub, and all three refuse ephemeral runs.
  ephemeral?: { expiresAt: Date };
  // The browser's PostHog distinct id when the caller has it (from the
  // request cookie, or parked with a paid check), so `run_created` joins the
  // visitor's own events. Null when the visitor sent none.
  distinctId?: string | null;
}

export interface StartCheckDeps {
  // Hands the queued run to the agent. Injectable so the start can be verified
  // without a Workflow binding or an agent worker.
  trigger: (runId: string) => Promise<void>;
  // Records the product event. Absent in a test's deps → nothing is sent;
  // production callers pass no deps and get the real capture.
  capture?: typeof captureServer;
}

export interface StartedCheck {
  id: string;
  publicId: string;
}

export async function startCheck(
  db: PrismaClient,
  opts: StartCheckOptions,
  deps: StartCheckDeps = { trigger: triggerRun, capture: captureServer },
): Promise<StartedCheck> {
  const { input } = opts;
  const appSlug = appSlugFromUrl(input.url);
  // CHE-234: a check an owner starts by hand against an app they already own is
  // a check OF THAT APP — the dashboard's "check now", the API, the app-review
  // skill. Until this, only the scheduler set `appId`, so those runs walked the
  // app's journeys and updated none of their history (30 runs of it by the time
  // it was noticed). An ephemeral run stays app-less — a PR preview is not the
  // app (CHE-202).
  const appId =
    opts.ownerId && !opts.ephemeral
      ? ((
          await db.app.findUnique({ ...alreadyScoped("the unique key names the owner"),
            where: { ownerId_appSlug: { ownerId: opts.ownerId, appSlug } },
            select: { id: true },
          })
        )?.id ?? null)
      : null;
  const run = await db.run.create({ ...alreadyScoped("created with its team"),
    data: {
      runNumber: await nextRunNumber(db),
      appId,
      targetUrl: input.url,
      ...extensionColumns(input.url, input.extension),
      appSlug,
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      storePasswordEnc: input.storePassword ? encryptSecret(input.storePassword) : null,
      scopeHints: input.scopeHints || null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      // Deploy identity (CHE-56) — set by CI so the verdict names a build.
      deploySha: input.deploy?.sha ?? null,
      deployEnv: input.deploy?.env || null,
      ownerId: opts.ownerId,
      teamId: opts.teamId ?? null,
      startedVia: opts.startedVia ?? (opts.ownerId ? "ui" : "anon"),
      anonKeyHash: opts.anonKeyHash,
      paidCheckoutSessionId: opts.paid?.checkoutSessionId ?? null,
      ephemeral: Boolean(opts.ephemeral),
      expiresAt: opts.ephemeral?.expiresAt ?? null,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  // The row is the fact the event records, so it is sent here and not after
  // the hand-off: a run that failed to trigger still exists and still counts.
  // captureServer never throws — analytics being down cannot fail a run.
  if (deps.capture) {
    const who = serverDistinctId(opts.distinctId ?? null, opts.ownerId, `run:${run.publicId}`);
    await deps.capture("run_created", who.distinctId, {
      appSlug,
      paid: Boolean(opts.paid),
      ephemeral: Boolean(opts.ephemeral),
      hasCredentials: Boolean(input.testEmail && input.testPassword),
      ...who.extra,
    });
  }

  await deps.trigger(run.id);
  return run;
}
