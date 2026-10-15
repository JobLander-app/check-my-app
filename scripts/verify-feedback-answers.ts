// CHE-441 verification: a report of the check's mistake comes back to its
// author, once, on a real D1 (Miniflare) with a stub board and a stub mailer.
//
//   1. an open ticket moves nothing and mails nobody;
//   2. Done → the row is "fixed", its author gets one mail, and a second tick
//      sends nothing;
//   3. Canceled with no "Answer:" comment → the row waits (no "you were wrong"
//      without a reason); with one → "wont_fix", the answer stored and mailed;
//   4. an answer that tells the customer to do our work is not sent;
//   5. a failed send leaves the mail owed, and the next tick sends it under the
//      same idempotency key;
//   6. the words: the "Answer:" comment parser, and the mail copy under the
//      language rules.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-feedback-answers.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { answerFeedback, type AnswerSend } from "../src/agent/feedback-answers";
import { answerFrom } from "../src/lib/tracker/types";
import { feedbackAnswerCopy } from "../src/lib/email";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import type { GapBoard } from "../src/agent/capability-gaps";
import type { AgentEnv } from "../src/agent/env";
import type { IssueOutcome } from "../src/lib/tracker/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  // 6a. The parser.
  eq(
    "the newest comment starting with Answer: wins, prefix stripped",
    answerFrom([
      { body: "Answer: old", createdAt: "2026-10-12T10:00:00Z" },
      { body: "not an answer", createdAt: "2026-10-12T12:00:00Z" },
      { body: "  answer:  The block page shows for every visitor outside the allow list. ", createdAt: "2026-10-12T11:00:00Z" },
    ]),
    "The block page shows for every visitor outside the allow list.",
  );
  eq("no Answer: comment → null", answerFrom([{ body: "looked at it", createdAt: "2026-10-12T10:00:00Z" }]), null);
  eq("an empty Answer: is no answer", answerFrom([{ body: "Answer:   ", createdAt: "2026-10-12T10:00:00Z" }]), null);

  // 6b. The copy.
  for (const outcome of ["fixed", "wont_fix"] as const) {
    const c = feedbackAnswerCopy({ appSlug: "prod-release-1.myshopify.com", outcome, answer: "The store blocks visitors from that country on purpose." });
    const all = `${c.subject} ${c.lead} ${c.detail}`;
    check(`the ${outcome} mail says nothing about how we check and gives no homework`, !hasHomework(all) && !hasEnvironmentLeak(all), all);
  }

  const real = await realD1();
  const { db } = real;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await db.user.create({ data: { id: "ua", clerkUserId: "ck_a", email: "member@securify.test" } });
    await db.team.create({ data: { id: "ta", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.app.create({ data: { id: "a1", teamId: "ta", ownerId: "ua", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", targetKind: "website" } });
    await db.run.create({ data: { id: "r1", publicId: "pubA", runNumber: 1, teamId: "ta", ownerId: "ua", appId: "a1", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", status: "completed" } });
    const report = (id: string, ticket: string) =>
      db.feedback.create({ data: { id, teamId: "ta", appId: "a1", runId: "r1", kind: "run", reason: "wrong", text: `Report ${id}: the bottom line is wrong`, authorId: "ua", status: "filed", issueIdentifier: ticket } });
    await report("f1", "CHE-901");
    await report("f2", "CHE-902");
    await report("f3", "CHE-903");

    const outcomes: Record<string, IssueOutcome> = { "CHE-901": "open", "CHE-902": "open", "CHE-903": "open" };
    const answers: Record<string, string | null> = {};
    const board = {
      self: {},
      baseUrl: "https://checkmyapp.dev",
      tracker: {
        createIssue: async () => ({ id: "x", identifier: "x", url: "" }),
        addComment: async () => {},
        getIssueOutcome: async (id: string) => outcomes[id],
        latestAnswer: async (id: string) => answers[id] ?? null,
      },
    } as unknown as GapBoard;
    const mails: { to: string; outcome: string; answer?: string | null; key?: string; url: string }[] = [];
    let failNext = 0;
    const send: AnswerSend = async (m) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("Resend send failed: 500");
      }
      mails.push({ to: m.to, outcome: m.outcome, answer: m.answer, key: m.idempotencyKey, url: m.url });
    };
    const env = { db, bindings: { EMAIL_API_KEY: "re_stub", EMAIL_FROM: "CheckMyApp <v@checkmyapp.dev>", APP_URL: "https://checkmyapp.dev" } } as unknown as AgentEnv;
    const tick = () => answerFeedback(env, { board, send });
    const status = async (id: string) => (await db.feedback.findUnique({ where: { id } }))?.status;

    // 1.
    await tick();
    eq("open tickets move nothing and mail nobody", [await status("f1"), mails.length], ["filed", 0]);

    // 2.
    outcomes["CHE-901"] = "done";
    await tick();
    eq("Done → fixed, one mail to the author", [await status("f1"), mails.map((m) => [m.to, m.outcome])], ["fixed", [["member@securify.test", "fixed"]]]);
    check("…which links the verdict it was about", mails[0]?.url === "https://checkmyapp.dev/verdict/pubA", mails[0]?.url);
    await tick();
    eq("a second tick sends nothing", mails.length, 1);

    // 3.
    outcomes["CHE-902"] = "canceled";
    await tick();
    eq("Canceled without an Answer: comment waits, unmailed", [await status("f2"), mails.length], ["filed", 1]);
    answers["CHE-902"] = "The store shows its block page to every visitor outside the allow list; the check saw exactly that.";
    await tick();
    const f2 = await db.feedback.findUnique({ where: { id: "f2" } });
    eq("with an answer → wont_fix, the answer stored", [f2?.status, f2?.answer], ["wont_fix", answers["CHE-902"]]);
    eq("…and mailed with it", mails[1] ? [mails[1].outcome, mails[1].answer] : null, ["wont_fix", answers["CHE-902"]]);

    // 4.
    outcomes["CHE-903"] = "canceled";
    answers["CHE-903"] = "Please verify it in a real browser yourself.";
    await tick();
    eq("an answer that hands the customer homework is not sent", [await status("f3"), mails.length], ["filed", 2]);

    // 5.
    answers["CHE-903"] = "That page needs a store password; the check said so in the run.";
    failNext = 1;
    await tick();
    const f3 = await db.feedback.findUnique({ where: { id: "f3" } });
    eq("a failed send leaves the row settled and the mail owed", [f3?.status, f3?.answeredAt, mails.length], ["wont_fix", null, 2]);
    await tick();
    eq("the next tick sends it", mails.length, 3);
    check("…under the row's own idempotency key", Boolean(mails[2].key?.startsWith("feedback-answer/f3/")), mails[2].key);
    await tick();
    eq("and never again", mails.length, 3);

    // 7. Rows that never settle do not hide a newer one (CodeRabbit on #316).
    for (let i = 0; i < 25; i++) {
      await db.feedback.create({ data: { id: `old${i}`, teamId: "ta", appId: "a1", runId: "r1", kind: "run", reason: "wrong", text: `old ${i}`, authorId: "ua", status: "filed", issueIdentifier: `CHE-8${String(i).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) } });
      outcomes[`CHE-8${String(i).padStart(2, "0")}`] = "open";
    }
    await report("late", "CHE-950");
    outcomes["CHE-950"] = "done";
    const before = mails.length;
    for (let t = 0; t < 3 && (await status("late")) !== "fixed"; t++) {
      await answerFeedback(env, { board, send, now: new Date(Date.UTC(2026, 9, 12, 15, t)) });
    }
    eq("twenty-five tickets still open do not hide a newer one that is Done", [await status("late"), mails.length - before], ["fixed", 1]);

    // …and neither do mails that keep failing.
    for (let i = 0; i < 25; i++) {
      await db.feedback.create({ data: { id: `bounce${i}`, teamId: "ta", appId: "a1", runId: "r1", kind: "run", reason: "wrong", text: `bounce ${i}`, authorId: "ua", status: "fixed", issueIdentifier: `CHE-7${String(i).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 0, 2, 0, i)) } });
    }
    await db.feedback.create({ data: { id: "good", teamId: "ta", appId: "a1", runId: "r1", kind: "run", reason: "wrong", text: "good one", authorId: "ua", status: "fixed", issueIdentifier: "CHE-960" } });
    const bouncing: AnswerSend = async (m) => {
      if (m.theirWords.startsWith("bounce")) throw new Error("Resend send failed: 422");
      mails.push({ to: m.to, outcome: m.outcome, answer: m.answer, key: m.idempotencyKey, url: m.url });
    };
    for (let t = 0; t < 3 && !(await db.feedback.findUnique({ where: { id: "good" } }))?.answeredAt; t++) {
      await answerFeedback(env, { board, send: bouncing, now: new Date(Date.UTC(2026, 9, 12, 16, t)) });
    }
    check("twenty-five mails that keep failing do not hold back one that can go", Boolean((await db.feedback.findUnique({ where: { id: "good" } }))?.answeredAt));

    // No board: nothing moves, nothing lost.
    await report("f4", "CHE-904");
    outcomes["CHE-904"] = "done";
    const noBoard = await answerFeedback(env, { board: null, send });
    eq("with no board connected the row waits", [noBoard.waiting.includes("f4"), await status("f4")], [true, "filed"]);
  } finally {
    console.warn = warn;
    await real.dispose();
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
