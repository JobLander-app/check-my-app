// CHE-441: the pilot's daily digest — one message to our owner's Telegram at
// 07:00 UTC about the teams given `shopify`, built from the day's rows.
//
// It is our own report (our owner reads it, never a customer), so it may name
// our incapacity plainly. Sent with sendRecorded under `pilot-digest:<date>`,
// so it goes out once a day whatever the ticks do, and not at all on a day
// with nothing to say.
//
// What it counts, for the last 24 hours:
//   - finished checks of the pilot teams' apps, by verdict;
//   - of what those checks walked, the share left unchecked, and by what cause
//     (CHE-443's loader — the same numbers as the admin's card);
//   - reports of the check's mistakes: new today, and where all of them stand
//     (open / fixed / not a mistake);
//   - checks that met an ended sign-in.

import type { PrismaClient } from "@/generated/prisma/client";
import { causesOfRun } from "@/lib/step-cause-load";
import { parseTeamFeatures } from "@/lib/team-features";
import { systemWide } from "@/lib/tenant-db";
import { AlreadySentError, sendRecorded, type SendDeps } from "@/lib/telegram-send";
import { sendDeps } from "./signed-out";
import type { AgentBindings, AgentEnv } from "./env";

export const DIGEST_HOUR_UTC = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function digestSendId(now: Date): string {
  return `pilot-digest:${now.toISOString().slice(0, 10)}`;
}

export async function buildPilotDigest(db: PrismaClient, now: Date): Promise<string | null> {
  const since = new Date(now.getTime() - DAY_MS);
  const teams = (await db.team.findMany({ ...systemWide("measurement"), select: { id: true, name: true, features: true } })).filter((t) =>
    parseTeamFeatures(t.features).includes("shopify"),
  );
  if (teams.length === 0) return null;
  const lines: string[] = [];
  let anything = false;
  for (const team of teams) {
    const runs = await db.run.findMany({
      where: { ...systemWide("measurement"), teamId: team.id, completedAt: { gte: since }, status: { in: ["completed", "partial"] } },
      select: { id: true, appSlug: true, verdict: true, bottomLine: true },
      orderBy: { completedAt: "asc" },
    });
    const count = (where: Record<string, unknown>) => db.feedback.count({ where: { ...systemWide("measurement"), teamId: team.id, ...where } });
    const [newReports, fixed, wontFix, open] = await Promise.all([
      count({ createdAt: { gte: since } }),
      count({ status: "fixed" }),
      count({ status: "wont_fix" }),
      count({ status: { in: ["open", "filing", "filed"] } }),
    ]);
    if (runs.length === 0 && newReports === 0) continue;
    anything = true;
    lines.push(`• ${team.name}`);
    if (runs.length) {
      const byVerdict = new Map<string, number>();
      let total = 0;
      let unchecked = 0;
      const byCause = new Map<string, number>();
      let signedOut = 0;
      for (const run of runs) {
        byVerdict.set(run.verdict ?? "no verdict", (byVerdict.get(run.verdict ?? "no verdict") ?? 0) + 1);
        const c = await causesOfRun(db, team.id, run.id, { walkedOnly: true });
        total += c.summary.total;
        unchecked += c.summary.unchecked;
        for (const [cause, n] of Object.entries(c.summary.byCause)) byCause.set(cause, (byCause.get(cause) ?? 0) + (n ?? 0));
        if (c.summary.defects.length) byCause.set("no cause (our defect)", (byCause.get("no cause (our defect)") ?? 0) + c.summary.defects.length);
        if (/sign-?in .*ended/i.test(run.bottomLine ?? "")) signedOut++;
      }
      lines.push(`  checks: ${runs.length} (${[...byVerdict].map(([v, n]) => `${v} ${n}`).join(", ")})`);
      if (total) {
        const causes = [...byCause].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ");
        lines.push(`  unchecked: ${unchecked} of ${total} steps (${Math.round((100 * unchecked) / total)}%)${causes ? ` — ${causes}` : ""}`);
      }
      if (signedOut) lines.push(`  ended sign-in: ${signedOut} check${signedOut === 1 ? "" : "s"}`);
    }
    lines.push(`  reports: ${newReports} new today; all time ${open} open, ${fixed} fixed, ${wontFix} not a mistake`);
  }
  if (!anything) return null;
  return [`Пилот Shopify, ${now.toISOString().slice(0, 10)} (за 24 ч):`, ...lines].join("\n");
}

export type DigestOutcome = "not_now" | "off" | "nothing" | "sent" | "already" | "failed";

/** Once a day, at the digest hour; every other tick is "not_now". Never throws. */
export async function sendPilotDigest(
  env: { db: AgentEnv["db"]; bindings: Pick<AgentBindings, "DB" | "TELEGRAM_BOT_TOKEN" | "OWNER_TELEGRAM_CHAT_ID"> },
  now: Date = new Date(),
  deps?: SendDeps,
): Promise<DigestOutcome> {
  if (now.getUTCHours() !== DIGEST_HOUR_UTC) return "not_now";
  const chatId = env.bindings.OWNER_TELEGRAM_CHAT_ID?.trim();
  const token = env.bindings.TELEGRAM_BOT_TOKEN?.trim();
  if (!chatId || (!deps && !token)) return "off";
  try {
    const text = await buildPilotDigest(env.db, now);
    if (!text) return "nothing";
    const sent = await sendRecorded(deps ?? sendDeps(env.bindings, token as string), chatId, text, digestSendId(now));
    return sent.status === "sent" ? "sent" : "failed";
  } catch (error) {
    if (error instanceof AlreadySentError) return "already";
    console.warn(`[pilot-digest] ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
