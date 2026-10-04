// Topping up a team's balance (CHE-327).
//
// A top-up is a one-time Stripe Checkout payment of $10, $25 or $50
// (TOPUP_AMOUNTS_USD — nothing smaller, so Stripe's fixed fee per payment does
// not eat it). The amount is priced inline in the session (price_data), so
// there is no Stripe price object or secret to keep in step with the code: the
// number the button shows is the number Stripe charges and the number
// credited, and the webhook checks the three agree before crediting.
//
// Crediting happens once per paid session: a BalanceTopUp row is the receipt
// (unique on the session id, so a retried or duplicated webhook cannot make a
// second one), and `credited` is claimed before the balance moves, so a retry
// after a crash between the two finishes the credit instead of repeating it.

import type Stripe from "stripe";
import type { PrismaClient } from "@/generated/prisma/client";
import { isTopUpAmount, type TopUpAmount } from "@/lib/plans";
import { BALANCE_PATH } from "@/lib/balance-links";

export const TOPUP_KIND = "balance_topup";

// The session metadata a top-up is created with, read back by the webhook.
export function topUpMetadata(teamId: string, amountUsd: TopUpAmount): Record<string, string> {
  return { kind: TOPUP_KIND, teamId, amountUsd: String(amountUsd) };
}

// The Checkout Session a top-up is paid through. Priced inline: the amount on
// the button is the amount charged and the amount credited, with no Stripe
// price object to keep in step.
//
// The receipt is asked for by name. A one-time payment gets Stripe's receipt
// only when the dashboard's "Successful payments" email is on, or when the
// payment carries `receipt_email` — which, in live mode, sends one regardless
// of that setting. The first $10 top-up (2026-09-29) was created without it,
// and its charge carries no receipt email and no receipt number: no receipt
// went out. A receipt that depends on a dashboard toggle is a receipt nobody
// can see is missing.
export function topUpSessionParams(args: {
  amountUsd: TopUpAmount;
  teamId: string;
  userId: string;
  email: string | null;
  customer: string | null;
  appUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  const { amountUsd, teamId, userId, email, customer, appUrl } = args;
  return {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amountUsd * 100,
          product_data: { name: `CheckMyApp balance top-up — $${amountUsd}` },
        },
        quantity: 1,
      },
    ],
    // A team that already pays keeps one Stripe customer; one that does not
    // pays as its admin's email.
    ...(customer ? { customer } : { customer_email: email || undefined }),
    ...(email ? { payment_intent_data: { receipt_email: email } } : {}),
    client_reference_id: userId,
    metadata: topUpMetadata(teamId, amountUsd),
    success_url: `${appUrl}${BALANCE_PATH}?topped_up=${amountUsd}`,
    cancel_url: `${appUrl}${BALANCE_PATH}`,
  };
}

// A Checkout Session is a paid top-up when it is a settled one-time payment we
// created for a team, and the amount it charged is the amount its metadata
// names — which is one of the amounts we sell.
export function paidTopUp(
  session: Pick<Stripe.Checkout.Session, "mode" | "payment_status" | "metadata" | "amount_total" | "id">,
): { sessionId: string; teamId: string; amountUsd: TopUpAmount } | null {
  if (session.mode !== "payment" || session.payment_status !== "paid") return null;
  const m = session.metadata ?? {};
  if (m.kind !== TOPUP_KIND || !m.teamId) return null;
  const amountUsd = Number(m.amountUsd);
  if (!isTopUpAmount(amountUsd)) return null;
  if (session.amount_total !== amountUsd * 100) return null;
  return { sessionId: session.id, teamId: m.teamId, amountUsd };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

// Credit a paid top-up exactly once. Returns whether THIS call moved the
// balance (false: an earlier delivery already did, or the team is gone).
export async function creditTopUp(
  db: PrismaClient,
  topUp: { sessionId: string; teamId: string; amountUsd: number },
): Promise<boolean> {
  const team = await db.team.findUnique({ where: { id: topUp.teamId }, select: { id: true } });
  if (!team) return false;
  // The receipt once: an existing one is read, and the unique key settles a
  // race between two deliveries arriving together.
  const existing = await db.balanceTopUp.findUnique({ where: { checkoutSessionId: topUp.sessionId }, select: { id: true } });
  if (!existing) try {
    await db.balanceTopUp.create({
      data: { checkoutSessionId: topUp.sessionId, teamId: topUp.teamId, amountUsd: topUp.amountUsd, credited: false },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const claimed = await db.balanceTopUp.updateMany({
    where: { checkoutSessionId: topUp.sessionId, credited: false },
    data: { credited: true },
  });
  if (claimed.count !== 1) return false;
  await db.team.update({ where: { id: topUp.teamId }, data: { topupUsd: { increment: topUp.amountUsd } } });
  return true;
}
