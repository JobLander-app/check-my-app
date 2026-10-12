// CHE-458: a team's own OpenRouter key that cannot pay.
//
// Owner, 2026-10-12: Securify added its key while the account behind it had no
// credit — «чеки пока будут на паузе, мы должны увидеть в ui что чеки не идут
// потому что у ключа нет денег». Until this file a BYOK check that met
// OpenRouter's 402 was read as OUR budget dying (LlmBudgetError, rule 4): it
// failed "on our side", the watch retried every two hours, and nothing said the
// team's key was the reason.
//
// The rule now: a 402 on the team's key is the team's access, like a store
// password nobody gave us. Team.openrouterKeyNoCreditAt is stamped; while it is,
// nothing starts on the key, and the Team page, Today, All apps and MCP say
// why. A new key clears it, and so does the scheduler finding that the key can
// pay again (one 1-token request, at most once an hour per team).

import type { PrismaClient } from "@/generated/prisma/client";

/** The one sentence every place says while the key cannot pay. */
export const BYOK_NO_CREDIT =
  "Checks are paused: the team's own OpenRouter key has no credit. They start again on their own once the OpenRouter account has credit.";

/** What the feed of a check stopped by it says. */
export const BYOK_NO_CREDIT_STOP = "This check stopped: the team's own OpenRouter key has no credit. Nothing was published, and it costs nothing.";

export const RECHECK_EVERY_MS = 60 * 60 * 1000;

type KeyState = { openrouterKeyEnc: string | null; openrouterKeyNoCreditAt: Date | null };

/** Paused only while the team has a key and that key was found with no credit. */
export function byokPaused(team: KeyState | null | undefined): boolean {
  return Boolean(team?.openrouterKeyEnc && team.openrouterKeyNoCreditAt);
}

/** The refusal of a start on a paused key, or null. Asked by every start path. */
export async function byokRefusal(db: PrismaClient, teamId: string | null | undefined): Promise<string | null> {
  if (!teamId) return null;
  const team = await db.team.findUnique({ where: { id: teamId }, select: { openrouterKeyEnc: true, openrouterKeyNoCreditAt: true } });
  return byokPaused(team) ? BYOK_NO_CREDIT : null;
}

export async function markKeyNoCredit(db: PrismaClient, teamId: string, now: Date): Promise<void> {
  await db.team.update({ where: { id: teamId }, data: { openrouterKeyNoCreditAt: now, openrouterKeyCheckedAt: now } });
}

export async function clearKeyNoCredit(db: PrismaClient, teamId: string, now: Date): Promise<void> {
  await db.team.update({ where: { id: teamId }, data: { openrouterKeyNoCreditAt: null, openrouterKeyCheckedAt: now } });
}

export type Credit = "credit" | "no_credit" | "unknown";

// OpenRouter has no balance a plain key may read (/api/v1/credits answers 403
// "Only management keys can fetch credits", checked 2026-10-12), so the only
// honest question is the one a check asks: can this key pay for a model? One
// token on a cheap paid model — a 402 is "no", a 200 is "yes", anything else
// proves nothing and changes nothing.
export const PROBE_MODEL = "openai/gpt-4o-mini";

export async function probeKeyCredit(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<Credit> {
  let res: Response;
  try {
    res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "unknown";
  }
  if (res.status === 402) return "no_credit";
  return res.ok ? "credit" : "unknown";
}

/**
 * The scheduler's half: every paused team whose key was last asked an hour ago
 * or more is asked again. A key that can pay clears the pause, so the team's
 * watches start on the next tick; anything else just records that it asked.
 * Returns the teams it un-paused.
 */
export async function recheckPausedKeys(
  db: PrismaClient,
  now: Date,
  decrypt: (blob: string) => string,
  probe: (key: string) => Promise<Credit> = (k) => probeKeyCredit(k),
): Promise<string[]> {
  const due = await db.team.findMany({
    where: {
      openrouterKeyEnc: { not: null },
      openrouterKeyNoCreditAt: { not: null },
      OR: [{ openrouterKeyCheckedAt: null }, { openrouterKeyCheckedAt: { lte: new Date(now.getTime() - RECHECK_EVERY_MS) } }],
    },
    select: { id: true, openrouterKeyEnc: true },
  });
  const cleared: string[] = [];
  for (const team of due) {
    let key: string;
    try {
      key = decrypt(team.openrouterKeyEnc!);
    } catch {
      await db.team.update({ where: { id: team.id }, data: { openrouterKeyCheckedAt: now } });
      continue;
    }
    if ((await probe(key)) === "credit") {
      await clearKeyNoCredit(db, team.id, now);
      cleared.push(team.id);
    } else {
      await db.team.update({ where: { id: team.id }, data: { openrouterKeyCheckedAt: now } });
    }
  }
  return cleared;
}
