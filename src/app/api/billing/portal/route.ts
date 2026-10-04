// CHE-259 (Teams T6): the team's own billing, in Stripe's portal.
//
// Payment method, invoices, cancellation — all of it lives with Stripe, and an
// admin gets there through a session we create for the TEAM's customer. There
// is deliberately no page of ours in between: a billing screen we render is a
// billing screen we have to keep true, and the one thing worse than no invoice
// history is invoice history that disagrees with the card statement.

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { BILLING_UNCONFIGURED, getStripe, getStripeEnv } from "@/lib/stripe";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { BALANCE_PATH } from "@/lib/balance-links";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

export async function POST(req: Request) {
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();

  const { env } = getCloudflareContext();
  const stripeEnv = getStripeEnv(env as Record<string, unknown>);
  const stripe = getStripe(stripeEnv);
  if (!stripe) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  const db = getDb(env as unknown as { DB: D1Database });
  const decision = await requireScope(db, req, "billing.manage", "Sign in to manage billing");
  if (!decision.ok) return decision.response;
  const { team } = decision.grant;

  if (!team.stripeCustomerId) {
    return NextResponse.json(
      { error: "This team has no subscription yet — pick a plan first." },
      { status: 409 },
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: team.stripeCustomerId,
    // Back to where the portal was opened from (CHE-351: Billing).
    return_url: `${APP_URL}${BALANCE_PATH}`,
  });
  return NextResponse.json({ url: session.url });
}
