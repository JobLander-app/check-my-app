// The paid one-off check (launch, owner decision 2026-09-05).
//
// When the site's free anonymous checks for the day are used up, a visitor
// may pay $1 for one check. It stays an anonymous, public check; payment is
// the abuse barrier, so this path has no Turnstile and no quota.
//
// Shape: the form input is parked in a PendingCheck while the visitor pays
// (POST /api/billing/one-check). Once Stripe says the Checkout Session is
// paid, the run is created from the parked input — by the webhook, or by the
// success page polling GET /api/billing/one-check when the webhook is late.
// Both go through startPaidCheck, which is idempotent: D1 has no
// transactions, so the unique Run.paidCheckoutSessionId is the lock, and the
// loser of a race reads the winner's run.

import type Stripe from "stripe";
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { readExtensionOptions } from "@/lib/extension-target";
import { captureServer, serverDistinctId } from "@/lib/analytics-server";
import { startCheck, type StartCheckDeps, type StartedCheck } from "@/lib/start-check";
import { publicRow } from "@/lib/tenant-db";

export const PENDING_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type PaidCheckState =
  | { state: "pending" }
  | { state: "started"; runPublicId: string };

// Prisma's unique-constraint violation; the D1 adapter surfaces it under the
// same code as every other provider.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

// Create the run a payment bought, exactly once. Callers have already
// established that `checkoutSessionId` is paid — this function trusts them
// and only guards against doing the work twice.
//
// Returns null when there is nothing to start: no such pending check, or the
// session does not belong to it.
export async function startPaidCheck(
  db: PrismaClient,
  pendingCheckId: string,
  checkoutSessionId: string,
  deps?: StartCheckDeps,
): Promise<StartedCheck | null> {
  const pending = await db.pendingCheck.findUnique({ where: { id: pendingCheckId } });
  if (!pending || pending.checkoutSessionId !== checkoutSessionId) return null;

  // Already started (by whichever of webhook / poll came first).
  if (pending.runId) {
    const existing = await db.run.findUnique({ ...publicRow(),
      where: { id: pending.runId },
      select: { id: true, publicId: true },
    });
    if (existing) return existing;
  }
  const bySession = await db.run.findUnique({ ...publicRow(),
    where: { paidCheckoutSessionId: checkoutSessionId },
    select: { id: true, publicId: true },
  });
  if (bySession) {
    await recordStarted(db, pendingCheckId, bySession.id);
    return bySession;
  }

  let run: StartedCheck;
  try {
    run = await startCheck(
      db,
      {
        input: {
          url: pending.targetUrl,
          extension: readExtensionOptions(pending.extensionConfig),
          testEmail: pending.testEmail ?? "",
          testPassword: pending.testPasswordEnc ? decryptSecret(pending.testPasswordEnc) : "",
          userNotes: pending.userNotes ?? "",
          notifyEmail: pending.notifyEmail ?? "",
        },
        ownerId: null,
        anonKeyHash: pending.anonKeyHash,
        paid: { checkoutSessionId },
        distinctId: pending.distinctId,
      },
      deps,
    );
    // The payment turned into a run, exactly once: the winner of the race
    // records it, the loser (below) does not. Attributed to the buyer's
    // browser when the POST that parked the check carried its id.
    const capture = deps ? deps.capture : captureServer;
    if (capture) {
      const who = serverDistinctId(pending.distinctId, null, `run:${run.publicId}`);
      await capture("one_check_paid", who.distinctId, { appSlug: appSlugFromUrl(pending.targetUrl), ...who.extra });
    }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race: the other starter's insert landed between our read and
    // our write. Its run is the run.
    const winner = await db.run.findUnique({ ...publicRow(),
      where: { paidCheckoutSessionId: checkoutSessionId },
      select: { id: true, publicId: true },
    });
    if (!winner) throw err;
    run = winner;
  }

  await recordStarted(db, pendingCheckId, run.id);
  return run;
}

// The parked password has done its job once the run holds its own copy.
async function recordStarted(db: PrismaClient, pendingCheckId: string, runId: string) {
  await db.pendingCheck.update({
    where: { id: pendingCheckId },
    data: { runId, testPasswordEnc: null },
  });
}

// Where a paid check stands, for the success page. Retrieves the session from
// Stripe only while no run exists yet, and starts the run itself when Stripe
// reports the session paid — so a late webhook never leaves a paying visitor
// staring at a spinner.
export async function paidCheckState(
  db: PrismaClient,
  stripe: Pick<Stripe, "checkout">,
  checkoutSessionId: string,
  deps?: StartCheckDeps,
): Promise<PaidCheckState | null> {
  const pending = await db.pendingCheck.findUnique({ where: { checkoutSessionId } });
  if (!pending) return null;

  if (pending.runId) {
    const run = await db.run.findUnique({ ...publicRow(),
      where: { id: pending.runId },
      select: { publicId: true },
    });
    if (run) return { state: "started", runPublicId: run.publicId };
  }

  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  if (!isPaidOneCheck(session, pending.id)) return { state: "pending" };

  const run = await startPaidCheck(db, pending.id, checkoutSessionId, deps);
  return run ? { state: "started", runPublicId: run.publicId } : { state: "pending" };
}

// Send the $1 buyer Stripe's receipt. The buyer is anonymous, so their email
// exists only once they have typed it into Checkout — too late for
// `payment_intent_data.receipt_email` on the session. Setting the charge's
// receipt_email afterwards sends the receipt ("if this field is updated, a new
// email receipt will be sent"). Without it a one-time payment gets a receipt
// only when the dashboard's "Successful payments" email is on; the first paid
// top-up (2026-09-29), made the same way, got none (src/lib/topup.ts).
//
// Called from the webhook only — one caller. A charge that already names an
// address is left alone, so a later redelivery does not mail twice; two
// deliveries arriving together both read it empty, so the update carries an
// idempotency key per charge and Stripe performs it once (a repeat within 24 h
// replays the first result instead of sending another receipt).
// Returns whether this call asked Stripe to send one.
export async function sendPaidCheckReceipt(
  stripe: { paymentIntents: Pick<Stripe["paymentIntents"], "retrieve">; charges: Pick<Stripe["charges"], "update"> },
  session: Pick<Stripe.Checkout.Session, "payment_intent" | "customer_details">,
): Promise<boolean> {
  const email = session.customer_details?.email;
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!email || !paymentIntentId) return false;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge === "string" || charge.receipt_email) return false;
  await stripe.charges.update(charge.id, { receipt_email: email }, { idempotencyKey: `one-check-receipt:${charge.id}` });
  return true;
}

// A Checkout Session is a paid one-off check when it is a one-time payment,
// settled, and names the pending check it was created for.
export function isPaidOneCheck(
  session: Pick<Stripe.Checkout.Session, "mode" | "payment_status" | "metadata">,
  pendingCheckId?: string,
): boolean {
  if (session.mode !== "payment" || session.payment_status !== "paid") return false;
  const id = session.metadata?.pendingCheckId;
  if (!id) return false;
  return pendingCheckId === undefined || id === pendingCheckId;
}
