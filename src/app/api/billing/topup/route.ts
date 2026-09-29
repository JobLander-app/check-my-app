import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { BILLING_UNCONFIGURED, getStripe, getStripeEnv } from "@/lib/stripe";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { isTopUpAmount } from "@/lib/plans";
import { topUpSessionParams } from "@/lib/topup";

// Prod build inlines https://checkmyapp.dev (.env.production); local dev lands
// back on localhost. Stripe requires absolute URLs here.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// POST /api/billing/topup { amountUsd: 10 | 25 | 50 } — start a Stripe Checkout
// payment that tops up the team's balance (CHE-327). A signed-in admin only,
// like every other billing act; the webhook credits it (src/lib/topup.ts).
export async function POST(req: Request) {
  // CHE-193: our own checker never opens a checkout. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const { env } = getCloudflareContext();
  const stripe = getStripe(getStripeEnv(env as Record<string, unknown>));
  if (!stripe) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  const db = getDb(env as unknown as { DB: D1Database });
  const decision = await requireScope(db, req, "billing.manage", "Sign in to top up");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;

  const json = (await req.json().catch(() => null)) as { amountUsd?: unknown } | null;
  const amountUsd = json?.amountUsd;
  if (!isTopUpAmount(amountUsd)) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const createSession = (customer: string | null) =>
    stripe.checkout.sessions.create(
      topUpSessionParams({ amountUsd, teamId: team.id, userId: user.id, email: user.email || null, customer, appUrl: APP_URL }),
    );
  let session;
  try {
    session = await createSession(team.stripeCustomerId);
  } catch (err) {
    // A stored customer can be stale — created under TEST keys before the
    // account went live (the same case /api/billing/checkout handles). A
    // top-up does not need the customer; it goes ahead by email.
    const missing = typeof err === "object" && err !== null && "code" in err && err.code === "resource_missing";
    if (!missing || !team.stripeCustomerId) throw err;
    session = await createSession(null);
  }
  if (!session.url) {
    return NextResponse.json({ error: "Stripe returned no checkout URL" }, { status: 502 });
  }
  return NextResponse.json({ url: session.url });
}
