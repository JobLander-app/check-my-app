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
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";

/** The one sentence every place says while the key cannot pay. */
export const BYOK_NO_CREDIT =
  "Checks are paused: the team's own OpenRouter key has no credit. They start again on their own once the OpenRouter account has credit.";

/** What the feed of a check stopped by it says. */
// Only what this path establishes: nothing was published, and we charge
// nothing for it. Calls the key paid for before the 402 are the team's own
// OpenRouter bill, and "costs nothing" would claim otherwise (CodeRabbit on #332).
export const BYOK_NO_CREDIT_STOP =
  "This check stopped: the team's own OpenRouter key has no credit. Nothing was published, and CheckMyApp charges nothing for it.";

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

// Every write about a key's credit names the key it is about — the encrypted
// value the run carried, or the one the re-check read — and lands only while
// that key is still the team's. A run that started on an old key cannot pause a
// new one, and a re-check of an old key cannot clear a new key's pause
// (CodeRabbit on #332). Returns whether it wrote.
export async function markKeyNoCredit(db: PrismaClient, teamId: string, keyEnc: string, now: Date): Promise<boolean> {
  const r = await db.team.updateMany({ where: { id: teamId, openrouterKeyEnc: keyEnc }, data: { openrouterKeyNoCreditAt: now, openrouterKeyCheckedAt: now } });
  return r.count === 1;
}

export async function clearKeyNoCredit(db: PrismaClient, teamId: string, keyEnc: string, now: Date): Promise<boolean> {
  const r = await db.team.updateMany({ where: { id: teamId, openrouterKeyEnc: keyEnc }, data: { openrouterKeyNoCreditAt: null, openrouterKeyCheckedAt: now } });
  return r.count === 1;
}

async function markKeyAsked(db: PrismaClient, teamId: string, keyEnc: string, now: Date): Promise<void> {
  await db.team.updateMany({ where: { id: teamId, openrouterKeyEnc: keyEnc }, data: { openrouterKeyCheckedAt: now } });
}

// The re-check's share of a tick: a few teams, asked at once, each answer
// bounded by the probe's timeout — so the due watches are read within seconds
// whatever the number of paused teams (CodeRabbit on #332).
export const RECHECKS_PER_TICK = 5;
export const PROBE_TIMEOUT_MS = 8_000;

/** A run stopped on a credit refusal: the team's key, when the run carried it. */
export function isTeamKeyDry(run: { budget: boolean; byokKeyEnc: string | null; teamId: string | null }): boolean {
  return run.budget && Boolean(run.byokKeyEnc) && Boolean(run.teamId);
}

/**
 * The workflow's whole answer to a check stopped by the team's key: the key is
 * paused (if it is still the team's) and the check's feed says why. Nothing
 * else — no watch retry, nothing on our board; the scheduler leaves the
 * team's watches until the key can pay. In one place, so it is run in a test
 * rather than read off the workflow's source.
 */
export async function recordTeamKeyDry(
  db: PrismaClient,
  run: { id: string; teamId: string; byokKeyEnc: string; phase: string },
  now: Date,
): Promise<void> {
  await markKeyNoCredit(db, run.teamId, run.byokKeyEnc, now);
  const row = await db.run.findFirst({ where: { ...teamOwned(run.teamId), id: run.id }, select: { events: true } });
  if (!row) return;
  let events: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row?.events ?? "[]");
    if (Array.isArray(parsed)) events = parsed;
  } catch {
    events = [];
  }
  events.push({ at: now.toISOString(), phase: run.phase, icon: "warn", text: BYOK_NO_CREDIT_STOP });
  await db.run.update({ ...alreadyScoped("already read in this request"), where: { id: run.id }, data: { events: JSON.stringify(events) } });
}

export type Credit = "credit" | "no_credit" | "unknown";

// OpenRouter has no balance a plain key may read (/api/v1/credits answers 403
// "Only management keys can fetch credits", checked 2026-10-12), so the only
// honest question is the one a check asks: can this key pay for a model? One
// token on a cheap paid model — a 402 is "no", a 200 is "yes", anything else
// proves nothing and changes nothing.
export const PROBE_MODEL = "openai/gpt-4o-mini";

export async function probeKeyCredit(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<Credit> {
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
    // The longest-waiting first, a few per tick; the rest are asked next tick.
    orderBy: { openrouterKeyCheckedAt: "asc" },
    take: RECHECKS_PER_TICK,
    select: { id: true, openrouterKeyEnc: true },
  });
  const answers = await Promise.all(
    due.map(async (team) => {
      const keyEnc = team.openrouterKeyEnc!;
      let key: string;
      try {
        key = decrypt(keyEnc);
      } catch {
        await markKeyAsked(db, team.id, keyEnc, now);
        return null;
      }
      if ((await probe(key)) === "credit") return (await clearKeyNoCredit(db, team.id, keyEnc, now)) ? team.id : null;
      await markKeyAsked(db, team.id, keyEnc, now);
      return null;
    }),
  );
  return answers.filter((id): id is string => id !== null);
}
