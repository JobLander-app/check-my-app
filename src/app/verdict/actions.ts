"use server";

// Verdict page actions. Server actions on purpose (CHE-73): a <form action>
// submits natively even before React hydrates, so an early click on
// "Re-check now" can't be silently swallowed the way an onClick was.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { optionalTeamContext } from "@/lib/auth";
import { hashClientKey } from "@/lib/crypto";
import { createRecheckRun } from "@/lib/recheck";
import { isBalanceExhausted } from "@/lib/balance-events";
import { EPHEMERAL_WATCH_REFUSAL, enableWatchForRun } from "@/lib/watch-enable";
import { isSelfCheckRequest, selfCheckRedirectPath } from "@/lib/self-check";

// CHE-193: our own checker pressing these buttons started real runs of a
// stranger's site (#147, #148). A request carrying the checker header goes
// straight back to the verdict — before the database, before auth.
async function refuseSelfCheck(publicId: string): Promise<void> {
  if (isSelfCheckRequest(await headers())) {
    redirect(selfCheckRedirectPath(`/verdict/${publicId}`));
  }
}

// CHE-371: a check opened inside the app sends its own address with the
// action, so a refusal is read where the button was pressed and not on the
// public permalink. A bound argument travels through the browser, so only the
// app's own check address is taken; anything else — including the FormData a
// form passes when nothing was bound — is the permalink, as before.
const IN_APP_CHECK = /^\/health\/apps\/[A-Za-z0-9_-]{1,64}\/checks\/\d{1,9}$/;
function wayBack(publicId: string, back?: unknown): string {
  return typeof back === "string" && IN_APP_CHECK.test(back) ? back : `/verdict/${publicId}`;
}

export async function recheckRunAction(publicId: string, back?: string | FormData): Promise<void> {
  await refuseSelfCheck(publicId);
  return doRecheck(publicId, false, wayBack(publicId, back));
}

// CHE-329: "Run it again" on a check that didn't finish. The same re-check,
// with the same gates; only the way back differs — a refusal is read on the
// failed run's own page, since a failed run has no verdict page to land on.
// (Our own checker is still turned away first; its bounce to /verdict/{id}
// lands on the run page, where a failed run's verdict URL now leads.)
export async function retryFailedRunAction(publicId: string, form?: FormData): Promise<void> {
  await refuseSelfCheck(publicId);
  // CHE-335: a paid check that signed in asks for the password again.
  const password = form?.get("testPassword");
  return doRecheck(publicId, false, `/run/${publicId}`, typeof password === "string" && password ? password : undefined);
}

// CHE-74: walk everything from scratch — partial/smoke skip themselves.
export async function fullRecheckRunAction(publicId: string, back?: string | FormData): Promise<void> {
  await refuseSelfCheck(publicId);
  return doRecheck(publicId, true, wayBack(publicId, back));
}

// CHE-75: Enable Daily Watch, hydration-proof. Same defaults the API route's
// schema applies (daily, notify on change only).
export async function enableWatchAction(publicId: string, back?: string | FormData): Promise<void> {
  await refuseSelfCheck(publicId);
  const here = wayBack(publicId, back);
  const prisma = await getDbFromContext();
  const user = await getOptionalUser(prisma);
  const context = await optionalTeamContext(prisma, user);
  const result = await enableWatchForRun(
    prisma,
    user && context ? { id: user.id, teamId: context.team.id, plan: context.team.plan } : null,
    {
      runPublicId: publicId,
      frequency: "daily",
      notifyOnChangeOnly: true,
    },
  );
  switch (result.kind) {
    case "unauthenticated":
      redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
      break;
    case "not_found":
      redirect(`${here}?watch_error=${encodeURIComponent("Run not found.")}`);
      break;
    case "forbidden":
      redirect(`${here}?watch_error=${encodeURIComponent("This run belongs to another owner.")}`);
      break;
    case "ephemeral":
      redirect(`${here}?watch_error=${encodeURIComponent(EPHEMERAL_WATCH_REFUSAL)}`);
      break;
    case "gated":
      redirect(`${here}?watch_error=${encodeURIComponent(result.reason)}`);
      break;
    case "ok":
      redirect(`/watch/${result.slug}`);
  }
}

async function doRecheck(
  publicId: string,
  full: boolean,
  back = `/verdict/${publicId}`,
  testPassword?: string,
): Promise<void> {
  const prisma = await getDbFromContext();
  const anonKeyHash = await hashClientKey((await headers()).get("cf-connecting-ip"));
  const result = await createRecheckRun(prisma, publicId, { full, anonKeyHash, testPassword });
  if (result.kind === "unauthorized") {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }
  if (result.kind === "not_found") {
    redirect(`${back}?recheck=notfound`);
  }
  // CHE-94: anonymous callers get the fresh verdict they already have, or a
  // plain explanation for the owner-only full walk — never a silent no-op.
  if (result.kind === "reused") {
    redirect(`/verdict/${result.publicId}?recheck=reused`);
  }
  if (result.kind === "quota") {
    // CHE-327: an empty balance comes back with a flag, so the page shows the
    // two ways out next to the sentence.
    const balance = isBalanceExhausted(result.code) ? "&balance=1" : "";
    redirect(`${back}?recheck=${encodeURIComponent(result.reason)}${balance}`);
  }
  if (result.kind === "ok") {
    redirect(`/run/${result.publicId}`);
  }
}
