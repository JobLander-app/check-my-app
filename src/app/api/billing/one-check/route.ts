import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { encryptSecret, hashClientKey } from "@/lib/crypto";
import { BILLING_UNCONFIGURED, getStripe, getStripeEnv, oneCheckPriceId } from "@/lib/stripe";
import { PENDING_CHECK_TTL_MS, paidCheckState } from "@/lib/one-check";
import { createCheckSchema } from "@/lib/validation";
import { distinctIdFromCookies } from "@/lib/analytics-server";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// Prod build inlines https://checkmyapp.dev (.env.production); local dev lands
// back on localhost. Stripe requires absolute URLs here.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// POST /api/billing/one-check — a $1 one-off check for a visitor whose free
// allowance for the day is spent (launch, owner decision 2026-09-05). Same
// body as /api/checks minus the Turnstile token: payment is the abuse
// barrier. Parks the submission as a PendingCheck and answers with the Stripe
// Checkout URL; nothing runs until Stripe says the session is paid (see
// src/lib/one-check.ts). Anonymous — no account, no Stripe customer.
export async function POST(req: Request) {
  // CHE-193: our own checker never parks a paid check. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const { env } = getCloudflareContext();
  const stripeEnv = getStripeEnv(env as Record<string, unknown>);
  const stripe = getStripe(stripeEnv);
  const priceId = oneCheckPriceId(stripeEnv);
  if (!stripe || !priceId) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  const json = await req.json().catch(() => null);
  const parsed = createCheckSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const db = getDb(env as unknown as { DB: D1Database });
  const pending = await db.pendingCheck.create({
    data: {
      targetUrl: input.url,
      extensionConfig: input.extension ? JSON.stringify(input.extension) : null,
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      storePasswordEnc: input.storePassword ? encryptSecret(input.storePassword) : null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      anonKeyHash: await hashClientKey(req.headers.get("cf-connecting-ip")),
      // The buyer's PostHog id, so the events the payment produces later
      // (one_check_paid, run_created) land on the same person as this click.
      distinctId: distinctIdFromCookies(req.headers.get("cookie")),
      expiresAt: new Date(Date.now() + PENDING_CHECK_TTL_MS),
    },
    select: { id: true },
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    // Both id carriers on purpose: the webhook and the success page resolve
    // the pending check from either.
    client_reference_id: pending.id,
    metadata: { pendingCheckId: pending.id },
    success_url: `${APP_URL}/paid?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/?url=${encodeURIComponent(input.url)}`,
  });
  if (!session.url) {
    return NextResponse.json({ error: "Stripe returned no checkout URL" }, { status: 502 });
  }

  await db.pendingCheck.update({
    where: { id: pending.id },
    data: { checkoutSessionId: session.id },
  });

  return NextResponse.json({ url: session.url });
}

// GET /api/billing/one-check?session_id=… — where the paid check stands, for
// the success page's poll. `started` carries the run's public id; `pending`
// means Stripe has not reported the payment settled yet. If the session is
// paid and the webhook has not arrived, this call starts the run itself.
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { env } = getCloudflareContext();
  const stripe = getStripe(getStripeEnv(env as Record<string, unknown>));
  if (!stripe) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  const db = getDb(env as unknown as { DB: D1Database });
  const state = await paidCheckState(db, stripe, sessionId);
  if (!state) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(state);
}
