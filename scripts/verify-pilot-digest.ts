// CHE-441 verification: the pilot's daily digest, on a real D1 (Miniflare),
// with the Telegram send recorded in the real TelegramMessage table.
//
//   1. content: per pilot team, checks by verdict, the unchecked share by
//      cause, ended sign-ins, and reports; teams without `shopify` are not in it;
//   2. it acts only at 07:00 UTC;
//   3. it goes out once a day — a second tick that hour, or a retried one,
//      sends nothing;
//   4. a day with nothing to say sends nothing.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-pilot-digest.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { TELEGRAM_MAX, buildPilotDigest, capDigest, digestSendId, sendPilotDigest } from "../src/agent/pilot-digest";
import type { SendDeps } from "../src/lib/telegram-send";
import { calls, source } from "./fixtures/ts-source";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  const real = await realD1();
  const { db } = real;
  try {
    const at7 = new Date("2026-10-13T07:05:00Z");
    const yesterday = new Date("2026-10-12T15:00:00Z");
    await db.user.create({ data: { id: "u", clerkUserId: "ck", email: "a@securify.test" } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.team.create({ data: { id: "to", name: "Other", plan: "business" } });
    await db.app.create({ data: { id: "a1", teamId: "ts", ownerId: "u", appSlug: "admin.shopify.com", targetUrl: "https://admin.shopify.com/x", targetKind: "website" } });
    await db.app.create({ data: { id: "o1", teamId: "to", ownerId: "u", appSlug: "other.test", targetUrl: "https://other.test", targetKind: "website" } });
    const run = (id: string, n: number, teamId: string, appId: string, verdict: string, bottomLine: string, completedAt = yesterday) =>
      db.run.create({ data: { id, publicId: `p${id}`, runNumber: n, teamId, ownerId: "u", appId, appSlug: appId, targetUrl: "https://x", status: "completed", verdict, bottomLine, completedAt } });
    await run("r1", 1, "ts", "a1", "mostly_ok", "Blocking works.");
    await run("r2", 2, "ts", "a1", "unverified", "Not verified: the sign-in this check uses has ended.");
    await run("r3", 3, "to", "o1", "broken", "Other team's run.");
    await run("r0", 4, "ts", "a1", "all_good", "Two days ago.", new Date("2026-10-11T06:00:00Z"));
    await db.journey.create({ data: { id: "j1", runId: "r1", order: 0, title: "Block a country", status: "ok" } });
    let o = 0;
    const step = (status: string, extra: Record<string, string> = {}) => db.step.create({ data: { journeyId: "j1", order: o++, label: `s${o}`, status, ...extra } });
    for (let i = 0; i < 6; i++) await step("ok");
    await step("skipped", { unverifiedReason: "missing_access", observed: "The store asks for a store password." });
    await step("skipped", { unverifiedReason: "our_capability", gapClass: "new_tab" });
    await step("skipped");
    await db.feedback.create({ data: { teamId: "ts", appId: "a1", runId: "r1", kind: "run", reason: "wrong", text: "x", authorId: "u", status: "filed", createdAt: new Date("2026-10-12T20:00:00Z") } });
    await db.feedback.create({ data: { teamId: "ts", appId: "a1", kind: "run", reason: "wrong", text: "y", authorId: "u", status: "fixed", createdAt: new Date("2026-10-01T20:00:00Z") } });

    // 1.
    const text = (await buildPilotDigest(db, at7)) ?? "";
    check("content: the pilot team, its two checks of the day by verdict", text.includes("• Securify") && /checks: 2 \(mostly_ok 1, unverified 1\)/.test(text), text);
    check("content: the unchecked share with its causes and our own defect", /unchecked: 3 of 9 steps \(33%\)/.test(text) && text.includes("missing_access:store_password 1") && text.includes("our_capability:new_tab 1") && text.includes("no cause (our defect) 1"), text);
    check("content: the ended sign-in", /ended sign-in: 1 check\b/.test(text), text);
    check("content: reports — new today and where all stand", /reports: 1 new today; all time 1 open, 1 fixed, 0 not a mistake/.test(text), text);
    check("content: a team without shopify is not in it", !text.includes("Other"), text);

    // 2–3.
    const sent: string[] = [];
    let n = 0;
    const deps: SendDeps = {
      d1: async (sql, params) => {
        const r = (await real.exec(sql, ...params)) as unknown as { results?: Record<string, unknown>[]; meta?: { changes?: number } };
        return { results: r.results ?? [], changes: r.meta?.changes ?? 0 };
      },
      sendMessage: async (chatId, msg) => {
        sent.push(msg);
        return { ok: true, result: { message_id: ++n, chat: { id: Number(chatId) }, date: Math.floor(at7.getTime() / 1000), text: msg } as never };
      },
      newId: () => `tg${n}${Math.random().toString(36).slice(2, 8)}`,
      now: () => at7,
    };
    const env = { db, bindings: { DB: undefined as never, OWNER_TELEGRAM_CHAT_ID: "123", TELEGRAM_BOT_TOKEN: undefined } };
    eq("timing: an 06:00 tick does nothing", await sendPilotDigest(env, new Date("2026-10-13T06:45:00Z"), deps), "not_now");
    eq("once: the first 07:00 tick sends", await sendPilotDigest(env, at7, deps), "sent");
    eq("once: the next tick that hour sends nothing", [await sendPilotDigest(env, new Date("2026-10-13T07:20:00Z"), deps), sent.length], ["already", 1]);
    eq("once: the send id is the date", digestSendId(at7), "pilot-digest:2026-10-13");

    // 4.
    eq("a quiet day sends nothing", await sendPilotDigest(env, new Date("2026-10-20T07:00:00Z"), deps), "nothing");
    eq("no chat configured: off", await sendPilotDigest({ ...env, bindings: { ...env.bindings, OWNER_TELEGRAM_CHAT_ID: undefined } }, at7, deps), "off");
  } finally {
    await real.dispose();
  }

  // Wired into the scheduler's tick.
  // Within Telegram's limit, whatever the number of teams (Codex on #321).
  const long = capDigest(Array.from({ length: 400 }, (_, i) => `• team ${i} — checks: 3 (all_good 3)`));
  check("a digest never exceeds Telegram's 4096 characters, and says what it left out", long.length <= TELEGRAM_MAX && /и ещё \d+ строк/.test(long), String(long.length));
  check("…a short one is untouched", capDigest(["a", "b"]) === "a\nb");
  const tick = calls(source("src/agent/index.ts")).find((c) => c.callee === "sendPilotDigest");
  check("the scheduler calls it on every tick", Boolean(tick));
  // A cron event delivered late still counts as its own hour and day (Codex on #321).
  eq("…at the tick's scheduled time, not the moment it ran", tick?.args[1], "new Date(controller.scheduledTime)");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
