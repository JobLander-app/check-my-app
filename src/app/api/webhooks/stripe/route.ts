// Stripe → Team.plan sync (CHE-40 phase 3; the subject became the team in CHE-253).
//
// Stripe posts subscription lifecycle events here; we keep `Team.plan` and the
// stored customer/subscription ids in step. Inert until STRIPE_SECRET_KEY +
// STRIPE_WEBHOOK_SECRET are set and the endpoint is registered in the Stripe
// dashboard — returns 503 until then. Public route (signature-verified, not
// session; clerkMiddleware only protects page routes, so a cookieless POST
// passes straight through).

import type Stripe from "stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import {
  getStripe,
  getStripeEnv,
  planFromPriceId,
  stripeCryptoProvider,
  type StripeEnv,
} from "@/lib/stripe";
import { isPaidOneCheck, startPaidCheck } from "@/lib/one-check";
import { personalTeamId } from "@/lib/teams";
import { captureServer } from "@/lib/analytics-server";
import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";

function customerIdOf(c: string | { id: string } | null): string | null {
  return typeof c === "string" ? c : (c?.id ?? null);
}

// A subscription no longer in good standing pays for nothing.
const GOOD_STANDING: Stripe.Subscription.Status[] = ["active", "trialing"];

function planFromSubscription(env: StripeEnv, sub: Stripe.Subscription): UserPlan | null {
  if (!GOOD_STANDING.includes(sub.status)) return "free";
  // Quantity-1 single-item subscriptions only (checkout creates exactly that).
  return planFromPriceId(env, sub.items.data[0]?.price?.id);
}

// CHE-253: the subscription belongs to a TEAM. Resolved by the Stripe customer
// id, then by the subscription id — never by an email, which is a person and
// can belong to several teams.
async function findTeamForSubscription(db: PrismaClient, sub: Stripe.Subscription) {
  const customerId = customerIdOf(sub.customer);
  if (customerId) {
    const byCustomer = await db.team.findUnique({ where: { stripeCustomerId: customerId } });
    if (byCustomer) return byCustomer;
  }
  return db.team.findFirst({ where: { stripeSubscriptionId: sub.id } });
}

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const stripeEnv = getStripeEnv(env as Record<string, unknown>);
  const stripe = getStripe(stripeEnv);
  if (!stripe || !stripeEnv.STRIPE_WEBHOOK_SECRET) {
    return new Response("stripe webhook not configured", { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    // workerd: async SubtleCrypto verification — constructEvent (sync) throws.
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      stripeEnv.STRIPE_WEBHOOK_SECRET,
      undefined,
      stripeCryptoProvider,
    );
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  const db = getDb(env as unknown as { DB: D1Database });

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      // A paid one-off check (src/lib/one-check.ts): create the run the
      // payment bought. Idempotent — the success page may have started it
      // already, and Stripe retries deliveries. `one_check_paid` is recorded
      // in there, by whichever starter creates the run, so a retry or the
      // success page's poll never counts a payment twice.
      if (session.mode === "payment") {
        const pendingCheckId = session.metadata?.pendingCheckId;
        if (pendingCheckId && isPaidOneCheck(session)) {
          await startPaidCheck(db, pendingCheckId, session.id);
        }
        break;
      }

      // A plan subscription: sync the TEAM's plan from the price.
      if (session.mode !== "subscription") break;
      const userId = session.client_reference_id ?? session.metadata?.userId;
      // teamId is what checkout writes now; userId is the fallback for a session
      // created before this deploy and paid after it, whose team is the buyer's
      // personal one (CHE-253, migration 0032 derived that id from the user's).
      const teamId = session.metadata?.teamId ?? (userId ? personalTeamId(userId) : null);
      if (!teamId) break; // not one of ours (checkout we didn't create)
      const team = await db.team.findUnique({ where: { id: teamId } });
      if (!team) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      // The session payload carries no line items — the subscription holds the
      // price, and the price decides the plan.
      let plan: UserPlan | null = null;
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        plan = planFromSubscription(stripeEnv, sub);
      }
      await db.team.update({
        where: { id: team.id },
        data: {
          stripeCustomerId: customerIdOf(session.customer) ?? team.stripeCustomerId,
          stripeSubscriptionId: subscriptionId,
          // Unknown price → leave the plan alone rather than guessing.
          ...(plan ? { plan } : {}),
        },
      });
      // The buyer is a signed-in person and the browser identified with the
      // same Clerk id, so this joins their own events without a cookie. The
      // plan is the team's; the event is still theirs.
      if (userId) await captureServer("checkout_completed", userId, { plan: plan ?? "unknown" });
      break;
    }

    // `created` matters for subscriptions made outside checkout — a comped
    // trial set up from the Stripe side (CHE-314) arrives only as `created`,
    // and without this branch the team kept `free` until someone edited D1.
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const team = await findTeamForSubscription(db, sub);
      if (!team) break;
      const plan = planFromSubscription(stripeEnv, sub);
      await db.team.update({
        where: { id: team.id },
        data: { stripeSubscriptionId: sub.id, ...(plan ? { plan } : {}) },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const team = await findTeamForSubscription(db, sub);
      if (!team) break;
      await db.team.update({
        where: { id: team.id },
        data: { plan: "free", stripeSubscriptionId: null },
      });
      break;
    }

    default:
      // Everything else (invoices, payment intents, …): acknowledged, ignored.
      break;
  }

  return new Response("ok", { status: 200 });
}
