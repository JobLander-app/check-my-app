// GitHub App deliveries (CHE-369): a successful deploy of a mapped repository
// starts a check of the app it deploys; installation events keep the
// installation and its repositories current. Public route, verified by the
// signature GitHub computes with the App's webhook secret.
//
// Inert (503) until the App's secrets are set, like the Telegram and Stripe
// webhooks. 200 for everything verified — a duplicate, an event we do not
// act on, a repository nobody mapped — because a 4xx/5xx makes GitHub
// redeliver and mark the hook failing. 500 only when the database refused
// the write, which a redelivery can repair.
//
// What is logged never includes the body: it names the customer's repository
// and commit, which is theirs.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, appConfigured, getGitHubAppEnv, signatureMatches } from "@/lib/github-app";
import { defaultWebhookDeps, handleDelivery } from "@/lib/github-webhook";
import { SITE } from "@/lib/site-metadata";

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const app = getGitHubAppEnv(env as Record<string, unknown>);
  if (!appConfigured(app)) return new Response("github app not configured", { status: 503 });

  const raw = await req.text();
  if (!(await signatureMatches(raw, req.headers.get(SIGNATURE_HEADER), app.GITHUB_APP_WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }
  const deliveryId = req.headers.get(DELIVERY_HEADER);
  const event = req.headers.get(EVENT_HEADER);
  if (!deliveryId || !event) return new Response("missing delivery headers", { status: 400 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Verified but unreadable: a redelivery would be just as unreadable.
    return new Response("ok", { status: 200 });
  }

  const db = getDb(env as unknown as { DB: D1Database });
  try {
    const outcome = await handleDelivery(db, app, { deliveryId, event, payload }, defaultWebhookDeps(SITE));
    return Response.json({ ok: true, outcome });
  } catch (err) {
    console.error(`github webhook: delivery ${deliveryId} (${event}) not handled: ${err instanceof Error ? err.name : "error"}`);
    return new Response("not handled", { status: 500 });
  }
}
