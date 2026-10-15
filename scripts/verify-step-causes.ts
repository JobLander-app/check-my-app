// CHE-443 acceptance: every unchecked step says why, in one named cause, and the
// cause goes to the person who can act on it.
//
// The owner, 2026-10-07: runs keep saying "we could not check this" and nobody
// can say why. The run that showed it (otp-plus-sso, cmuy23f79000btg1r7x3x0j6g)
// had five steps our checker could not do, nine it stopped on purpose, and a
// sign-in step nobody could read. This holds:
//
//   1. a cause from the closed list for every unchecked step, derived from the
//      row — and a step with none (no reason, or our "unclassified" bucket) is
//      reported as our defect, never as a cause. This is the guard that fails
//      first on "a step without a cause";
//   2. the sentence on the step, in the product's words only (no homework, no
//      machinery), for every cause there can be;
//   3. where each cause goes: ours to Mender, the rest to the team's admin;
//   4. the admin's mail: one per new cause per app, never a second for the
//      same cause, never to a member, never for a team without `shopify`, and
//      a mail that did not go is tried again — over a fake database that
//      enforces the same unique index the migration creates;
//   5. the unchecked share of a run, which is what a digest counts and what
//      falls as the gap tickets close;
//   6. the pages and the workflow actually use all of it.
//
// The gap ticket carrying `mender` (and its recurrence getting it) is held in
// scripts/verify-gap-filing.ts, which owns the filing world.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-step-causes.ts

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@/generated/prisma/client";
import { GAP_CLASSES } from "@/agent/gap-classes";
import { noticeNewCauses, type CauseSend } from "@/agent/cause-notice";
import { sendCauseNotice } from "@/lib/email";
import {
  ACCESS_KINDS,
  ACCESS_PHRASE,
  CAPABILITY_PHRASE,
  DEFECT_TEXT,
  accessKindOf,
  causeLine,
  causeOfStep,
  causeRoute,
  causeText,
  isMailedToAdmin,
  summarizeCauses,
  type CauseStep,
  type StepCause,
} from "@/lib/step-cause";
import { SELF_CHECK_REFUSED_OBSERVED, hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";
import { signedOutObserved } from "@/agent/signed-out";
import { STORE_LOCKED_OBSERVED, STORE_MISSING_OBSERVED } from "@/agent/tools";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsAttention } from "@/components/needs-attention";
import { REPORTS_HEADING, reportLine, reportLink, reportQuote, reportStatus } from "@/lib/report-card-copy";
import { calls, elementAccesses, initializerOf, jsx, jsxTextAt, properties, source, type Call } from "./fixtures/ts-source";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const skipped = (over: Partial<CauseStep>): CauseStep => ({ status: "skipped", label: "A step", attempted: null, observed: null, ...over });

function causeOf(step: CauseStep): string {
  const o = causeOfStep(step);
  return o === null ? "checked" : "cause" in o ? o.cause : `DEFECT:${o.defect}`;
}

async function main() {
  // ─── 1. a cause for every unchecked step ──────────────────────────────────
  console.log("\n1. the cause of a step\n");

  check("a checked step has no cause", causeOfStep({ status: "ok" }) === null && causeOfStep({ status: "broken", unverifiedReason: "our_capability" }) === null);

  const capabilityClasses = Object.keys(GAP_CLASSES).filter((c) => c !== "unclassified");
  check(
    "every gap class but `unclassified` has its customer phrase (and no phrase is for a class that does not exist)",
    capabilityClasses.every((c) => c in CAPABILITY_PHRASE) && Object.keys(CAPABILITY_PHRASE).every((c) => c in GAP_CLASSES),
    `${capabilityClasses.length} classes`,
  );
  for (const gap of capabilityClasses) {
    check(
      `our_capability / ${gap} is a cause, and it is ours`,
      causeOf(skipped({ unverifiedReason: "our_capability", gapClass: gap })) === `our_capability:${gap}` &&
        causeRoute(`our_capability:${gap}` as StepCause) === "mender",
    );
  }

  // The guard that fails first: a step with no cause is our defect.
  check("our_capability with no class is a defect, not a cause", causeOf(skipped({ unverifiedReason: "our_capability", gapClass: null })) === "DEFECT:unclassified");
  check("our_capability / unclassified is a defect, not a cause", causeOf(skipped({ unverifiedReason: "our_capability", gapClass: "unclassified" })) === "DEFECT:unclassified");
  check("our_capability with a class nobody named is a defect", causeOf(skipped({ unverifiedReason: "our_capability", gapClass: "made_up" })) === "DEFECT:unclassified");
  check("a skipped step with no reason is a defect", causeOf(skipped({ unverifiedReason: null })) === "DEFECT:no_reason");
  check("a skipped step with a reason nobody defined is a defect", causeOf(skipped({ unverifiedReason: "whatever" })) === "DEFECT:no_reason");

  // What access: the sentences the code paths write, read back from the row.
  const access: [string, string, string][] = [
    ["the store's password gate, refused", STORE_LOCKED_OBSERVED, "store_password"],
    ["the store's password gate, none given", STORE_MISSING_OBSERVED, "store_password"],
    ["the sign-in ended", signedOutObserved("accounts.shopify.com"), "sign_in_ended"],
    ["the sign-in details no longer work", "The sign-in details we were given for the default account no longer work, so nothing behind the login was checked.", "sign_in_rejected"],
    ["no test credentials", "No test credentials were provided, so the form was not submitted.", "test_account"],
    ["no staff access", "The test account has no staff access to the store, so its admin pages were not reachable.", "staff_access"],
    ["a words we have no rule for", "Something behind this page was out of reach.", "other"],
  ];
  for (const [name, observed, kind] of access) {
    check(`missing access — ${name}`, causeOf(skipped({ unverifiedReason: "missing_access", observed })) === `missing_access:${kind}`, accessKindOf(observed));
  }
  check("every access kind is reachable and has its words", ACCESS_KINDS.every((k) => k in ACCESS_PHRASE) && new Set(access.map((a) => a[2])).size === ACCESS_KINDS.length);

  check("our own guard's refusal is `read_only`", causeOf(skipped({ unverifiedReason: "not_applicable", observed: SELF_CHECK_REFUSED_OBSERVED })) === "read_only");
  check("any other not_applicable stays `not_applicable`", causeOf(skipped({ unverifiedReason: "not_applicable", observed: "Out of scope for this check." })) === "not_applicable");

  // ─── 2. the sentence on the step ──────────────────────────────────────────
  console.log("\n2. what the step says\n");

  const everyCause: StepCause[] = [
    ...capabilityClasses.map((c) => `our_capability:${c}` as StepCause),
    ...ACCESS_KINDS.map((k) => `missing_access:${k}` as StepCause),
    "read_only",
    "not_applicable",
  ];
  const sentences = [...everyCause.map(causeText), DEFECT_TEXT];
  check(`${sentences.length} sentences, every one begins "Not checked:"`, sentences.every((s) => s.startsWith("Not checked: ")));
  check("none says `unclassified`", sentences.every((s) => !/unclassified/i.test(s)));
  check("none is homework for the customer", sentences.every((s) => !hasHomework(s)), sentences.find(hasHomework) ?? "");
  check("none leaks our machinery or narrates the walk", sentences.every((s) => !hasEnvironmentLeak(s) && !hasNarration(s)), sentences.find((s) => hasEnvironmentLeak(s) || hasNarration(s)) ?? "");
  check("the sentences are all different (a reader can tell the causes apart)", new Set(sentences).size === sentences.length);
  check("read_only says what the owner said: stopped on purpose, checks never change settings", /stopped on purpose/i.test(causeText("read_only")) && /never change settings/i.test(causeText("read_only")));
  check("a checked step shows nothing", causeLine({ status: "ok" }) === null);
  check("a step with no cause still says something, and says it is ours", causeLine(skipped({ unverifiedReason: null })) === DEFECT_TEXT && /on our side/.test(DEFECT_TEXT));

  // ─── 3. where each goes ───────────────────────────────────────────────────
  console.log("\n3. who gets it\n");
  check("our_capability → Mender; every other cause → the admin", everyCause.every((c) => causeRoute(c) === (c.startsWith("our_capability:") ? "mender" : "admin")));
  check(
    "the admin is mailed missing_access and read_only, and only those",
    everyCause.filter(isMailedToAdmin).every((c) => c.startsWith("missing_access:") || c === "read_only") &&
      !isMailedToAdmin("not_applicable") &&
      !everyCause.filter((c) => c.startsWith("our_capability:")).some(isMailedToAdmin),
  );

  // ─── the run that started it ──────────────────────────────────────────────
  // otp-plus-sso: 5 steps ours (4 could not drive a field, 1 a code), 9 stopped
  // on purpose, the rest checked.
  const otp: CauseStep[] = [
    ...Array.from({ length: 16 }, (_, i) => ({ status: "ok", label: `Checked ${i}` })),
    ...Array.from({ length: 4 }, (_, i) => skipped({ label: `Type into field ${i}`, unverifiedReason: "our_capability", gapClass: "undriven_control" })),
    skipped({ label: "Enter the emailed code", unverifiedReason: "our_capability", gapClass: "verification_code" }),
    ...Array.from({ length: 9 }, (_, i) => skipped({ label: `Toggle setting ${i}`, unverifiedReason: "not_applicable", observed: SELF_CHECK_REFUSED_OBSERVED })),
  ];
  console.log("\notp-plus-sso, as the ticket counts it\n");
  const s = summarizeCauses(otp);
  check("30 steps, 14 unchecked", s.total === 30 && s.unchecked === 14, `${s.total}/${s.unchecked}`);
  check("every unchecked step has a cause", s.defects.length === 0, JSON.stringify(s.defects.map((d) => d.defect)));
  check("by cause: 4 undriven control, 1 code, 9 stopped on purpose", s.byCause["our_capability:undriven_control"] === 4 && s.byCause["our_capability:verification_code"] === 1 && s.byCause.read_only === 9, JSON.stringify(s.byCause));
  check("the unchecked share is 14/30", Math.abs(s.share - 14 / 30) < 1e-9, s.share.toFixed(3));

  const withDefect = summarizeCauses([...otp, skipped({ label: "Mystery", unverifiedReason: "our_capability", gapClass: "unclassified" })]);
  check("a run with one step we cannot explain reports it as a defect (what a guard over real runs fails on)", withDefect.defects.length === 1 && withDefect.defects[0].defect === "unclassified");

  // ─── 5. the share falls as the gap tickets close ──────────────────────────
  console.log("\n5. the unchecked share\n");
  const fixed = otp.map((st) => (st.gapClass === "undriven_control" ? { status: "ok", label: st.label } : st));
  check("when the field gap is fixed the next run's unchecked share is lower", summarizeCauses(fixed).share < s.share, `${s.share.toFixed(2)} → ${summarizeCauses(fixed).share.toFixed(2)}`);
  check("a run with no steps has share 0, not NaN", summarizeCauses([]).share === 0);

  // ─── 4. the admin's mail ──────────────────────────────────────────────────
  console.log("\n4. one mail per new cause per app\n");

  // The unique index the migration creates, proven on a real SQLite.
  {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys = ON;`);
      db.exec(`CREATE TABLE "App" ("id" TEXT NOT NULL PRIMARY KEY);`);
      const dir = path.join(root, "prisma/migrations");
      const file = readdirSync(dir).find((f) => /^\d+_cause_notice\.sql$/.test(f));
      check("a migration creates CauseNotice", Boolean(file), file ?? "");
      if (!file) throw new Error("no *_cause_notice.sql migration");
      db.exec(readFileSync(path.join(dir, file), "utf8"));
      db.exec(`INSERT INTO "App" VALUES ('a1')`);
      const ins = () => db.exec(`INSERT INTO "CauseNotice" ("id","appId","cause","firstRunId") VALUES ('${Math.random()}','a1','read_only','r1')`);
      ins();
      let second = "";
      try {
        ins();
      } catch (e) {
        second = (e as Error).message;
      }
      check("the same cause twice on one app is refused by the table itself", /unique/i.test(second), second);
      db.exec(`INSERT INTO "CauseNotice" ("id","appId","cause","firstRunId") VALUES ('x','a1','missing_access:store_password','r1')`);
      check("another cause on the same app is fine", true);
      db.exec(`DELETE FROM "App" WHERE id='a1'`);
      const remaining = db.prepare(`SELECT * FROM "CauseNotice"`).all();
      check("deleting its app deletes its CauseNotice rows", remaining.length === 0, `${remaining.length} rows remain`);
    } finally {
      db.close();
    }
  }

  type Row = { appId: string; cause: string; firstRunId: string; sentAt: Date | null };
  function world(opts: { features?: string | null; admins?: string[]; members?: string[] } = {}) {
    const notices: Row[] = [];
    const runs = new Map<string, { appId: string; teamId: string; appSlug: string; ephemeral: boolean; steps: (CauseStep & { carried?: boolean })[] }>();
    const mails: { to: string; cause: string; sentence: string; labels: string[]; actionUrl?: string; key?: string }[] = [];
    let failSends = 0;
    const admins = opts.admins ?? ["vladislav@otp.plus"];
    const members = opts.members ?? ["member@otp.plus"];
    const queries: string[] = [];
    const db = {
      run: { findUnique: async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null },
      team: { findUnique: async () => ({ features: opts.features === undefined ? JSON.stringify(["shopify"]) : opts.features }) },
      step: {
        findMany: async ({ where }: { where: { journey: { runId: string; carriedFromRunId?: null } } }) => {
          queries.push(JSON.stringify(where));
          const run = runs.get(where.journey.runId);
          return (run?.steps ?? []).filter((st) => !("carriedFromRunId" in where.journey) || !st.carried);
        },
      },
      membership: {
        findMany: async ({ where }: { where: { scope: string } }) =>
          (where.scope === "admin" ? admins : members).map((email) => ({ user: { email } })),
      },
      causeNotice: {
        findUnique: async ({ where }: { where: { appId_cause: { appId: string; cause: string } } }) =>
          notices.find((n) => n.appId === where.appId_cause.appId && n.cause === where.appId_cause.cause) ?? null,
        create: async ({ data }: { data: { appId: string; cause: string; firstRunId: string } }) => {
          await Promise.resolve();
          if (notices.some((n) => n.appId === data.appId && n.cause === data.cause)) {
            throw Object.assign(new Error("Unique constraint failed on the fields: (`appId`,`cause`)"), { code: "P2002" });
          }
          notices.push({ ...data, sentAt: null });
        },
        update: async ({ where, data }: { where: { appId_cause: { appId: string; cause: string } }; data: { sentAt: Date } }) => {
          const n = notices.find((x) => x.appId === where.appId_cause.appId && x.cause === where.appId_cause.cause);
          if (!n) throw new Error("update of a notice that does not exist");
          n.sentAt = data.sentAt;
        },
      },
    };
    const send: CauseSend = async (m) => {
      if (failSends > 0) {
        failSends--;
        throw new Error("Resend send failed: 500");
      }
      mails.push({ to: m.to, cause: m.idempotencyKey ?? "", sentence: m.causeSentence, labels: m.stepLabels, actionUrl: m.actionUrl, key: m.idempotencyKey });
    };
    const env = {
      db: db as unknown as PrismaClient,
      bindings: { EMAIL_API_KEY: "re_stub", EMAIL_FROM: "CheckMyApp <v@checkmyapp.dev>", EMAIL_REPLY_TO: undefined, APP_URL: "https://checkmyapp.dev" },
    };
    const addRun = (id: string, steps: (CauseStep & { carried?: boolean })[], appId = "app-1") =>
      runs.set(id, { appId, teamId: "team-1", appSlug: "otp-plus-sso", ephemeral: false, steps });
    return { env, notices, mails, send, addRun, runs, queries, failNext: (n: number) => (failSends = n) };
  }

  const stopped = (n: number) => Array.from({ length: n }, (_, i) => skipped({ label: `Toggle setting ${i}`, unverifiedReason: "not_applicable", observed: SELF_CHECK_REFUSED_OBSERVED }));
  const noPassword = (n: number) => Array.from({ length: n }, (_, i) => skipped({ label: `Open products ${i}`, unverifiedReason: "missing_access", observed: STORE_MISSING_OBSERVED }));
  const ours = (n: number) => Array.from({ length: n }, (_, i) => skipped({ label: `Type ${i}`, unverifiedReason: "our_capability", gapClass: "undriven_control" }));
  const notApplicable = [skipped({ label: "Out of scope", unverifiedReason: "not_applicable", observed: "Not part of this check." })];
  const checked = [{ status: "ok", label: "Fine" }];

  {
    const w = world();
    w.addRun("r1", [...checked, ...stopped(9), ...noPassword(2), ...ours(5), ...notApplicable]);
    const out = await noticeNewCauses(w.env, "r1", w.send);
    check("the first run mails two causes — the password and the rule — to the admin", w.mails.length === 2 && w.mails.every((m) => m.to === "vladislav@otp.plus"), w.mails.map((m) => m.sentence).join(" | "));
    check("…not our incapacity, and not the not_applicable step", !w.mails.some((m) => /could not|outside what/.test(m.sentence)));
    check("…not to a member", !w.mails.some((m) => m.to === "member@otp.plus"));
    check("…and each says what it kept unchecked, by name", w.mails.some((m) => m.labels.includes("Open products 0")) && w.mails.some((m) => m.labels.includes("Toggle setting 0")));
    check("…the access one names where to act, on the app", w.mails.some((m) => m.actionUrl === "https://checkmyapp.dev/health/apps/app-1/settings/accounts"), w.mails.map((m) => m.actionUrl).join(","));
    check("…two notices stamped as sent", w.notices.length === 2 && w.notices.every((n) => n.sentAt !== null));
    check("…and the outcome says so", out.filter((o) => o.result === "told").length === 2);
    check("the steps are read only through a run of the run's own team", w.queries.every((q) => q.includes('"run":{"teamId":"team-1"}')), w.queries[0]);

    // The same causes, next run.
    w.addRun("r2", [...checked, ...stopped(9), ...noPassword(2), ...ours(5)]);
    await noticeNewCauses(w.env, "r2", w.send);
    w.addRun("r3", [...checked, ...stopped(3), ...noPassword(1)]);
    await noticeNewCauses(w.env, "r3", w.send);
    check("the same causes on the next two runs send nothing", w.mails.length === 2, String(w.mails.length));

    // A new cause is a new mail — once.
    w.addRun("r4", [...checked, ...stopped(1), skipped({ label: "Open the app", unverifiedReason: "missing_access", observed: signedOutObserved("accounts.shopify.com") })]);
    await noticeNewCauses(w.env, "r4", w.send);
    check("a cause the app has not had before is one more mail", w.mails.length === 3 && /sign-in this check uses has ended/.test(w.mails[2].sentence), String(w.mails.length));
    check("…which points at signing in again", w.mails[2].actionUrl === "https://checkmyapp.dev/health/apps/app-1/sign-in", String(w.mails[2].actionUrl));
    await noticeNewCauses(w.env, "r4", w.send);
    check("a retried step of the same run sends nothing", w.mails.length === 3);

    // Another app has its own first time.
    w.addRun("r5", [...stopped(2)], "app-2");
    await noticeNewCauses(w.env, "r5", w.send);
    check("the same cause on another app is that app's first mail", w.mails.length === 4);
  }

  {
    // Two runs of one app finishing together.
    const w = world();
    w.addRun("a", stopped(1));
    w.addRun("b", stopped(1));
    await Promise.all([noticeNewCauses(w.env, "a", w.send), noticeNewCauses(w.env, "b", w.send)]);
    check("two runs of an app finishing together send one mail", w.mails.length === 1 && w.notices.length === 1, `${w.mails.length} mails, ${w.notices.length} notices`);
  }

  {
    // A mail that did not go is not a mail that was sent.
    const w = world();
    w.addRun("r1", stopped(1));
    w.failNext(1);
    const first = await noticeNewCauses(w.env, "r1", w.send);
    check("a refused send is said, and the notice is left unsent", first[0]?.result === "failed" && w.notices[0]?.sentAt === null && w.mails.length === 0);
    w.addRun("r2", stopped(1));
    await noticeNewCauses(w.env, "r2", w.send);
    check("the next run tries again, and it goes", w.mails.length === 1 && w.notices[0].sentAt !== null);
    w.addRun("r3", stopped(1));
    await noticeNewCauses(w.env, "r3", w.send);
    check("…and then never again", w.mails.length === 1);
    check("the provider's idempotency key is the app and the cause, so a repeat of the same send is not a second mail", Boolean(w.mails[0].key) && /^[\w/.-]+\/[0-9a-f]{16}$/.test(w.mails[0].key as string), w.mails[0].key);
  }

  {
    // One admin reached, one not: the cause stays unsent so the next run retries.
    const w = world({ admins: ["a@otp.plus", "b@otp.plus"] });
    w.addRun("r1", stopped(1));
    w.failNext(1);
    const first = await noticeNewCauses(w.env, "r1", w.send);
    check("one admin of two unreached leaves the cause unsent", first[0]?.result === "failed" && first[0]?.admins === 1 && w.notices[0]?.sentAt === null && w.mails.length === 1);
    w.addRun("r2", stopped(1));
    await noticeNewCauses(w.env, "r2", w.send);
    check("the next run reaches the admin it missed and stamps the cause", w.notices[0].sentAt !== null && w.mails.some((m) => m.to === "b@otp.plus"));
  }

  {
    const w = world({ admins: [] });
    w.addRun("r1", stopped(1));
    const out = await noticeNewCauses(w.env, "r1", w.send);
    check("a team with no admin address mails nobody and keeps the cause unsent", out[0]?.result === "none" && w.mails.length === 0 && w.notices[0]?.sentAt === null);
  }

  {
    const w = world({ features: null });
    w.addRun("r1", [...stopped(3), ...noPassword(1)]);
    await noticeNewCauses(w.env, "r1", w.send);
    check("a team without `shopify` is mailed nothing and nothing is recorded", w.mails.length === 0 && w.notices.length === 0);
  }

  {
    const w = world();
    w.addRun("r1", stopped(3));
    w.runs.get("r1")!.ephemeral = true;
    await noticeNewCauses(w.env, "r1", w.send);
    check("a check of no saved app (ephemeral) mails nobody", w.mails.length === 0);
    w.addRun("r2", [{ ...stopped(1)[0], carried: true }]);
    await noticeNewCauses(w.env, "r2", w.send);
    check("a journey a run only carried forward is not that run's news", w.mails.length === 0 && w.queries.some((q) => q.includes('"carriedFromRunId":null')), w.queries.join(" "));
  }

  {
    const w = world();
    w.addRun("r1", stopped(1));
    const broken: CauseSend = async () => {
      throw new Error("boom");
    };
    const thrown = noticeNewCauses({ ...w.env, db: { ...w.env.db, run: { findUnique: async () => { throw new Error("D1 is down"); } } } as unknown as PrismaClient }, "r1", broken);
    check("a failure inside never reaches the run", await thrown.then(() => true, () => false));
  }

  // The mail as the provider receives it.
  {
    const realFetch = globalThis.fetch;
    let posted: { subject?: string; html?: string; text?: string; to?: string[] } = {};
    let key = "";
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await sendCauseNotice({
        to: "vladislav@otp.plus",
        appSlug: "otp-plus-sso",
        causeSentence: causeText("missing_access:store_password"),
        actionText: "Add the store password",
        actionUrl: "https://checkmyapp.dev/health/apps/app-1/settings/accounts",
        stepLabels: ["Open products", "Open orders"],
        appUrl: "https://checkmyapp.dev/health/apps/app-1",
        apiKey: "re_stub",
        from: "CheckMyApp <verdicts@checkmyapp.dev>",
        idempotencyKey: "k1",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const both = `${posted.subject} ${posted.text}`;
    check("the mail is a complete document with a plain-text twin and says why it came", /^<!doctype html>/i.test(posted.html ?? "") && (posted.text ?? "").length > 80 && (posted.text ?? "").includes("You get this because"));
    check("…names the cause, the steps and the action", /password/.test(both) && /Open products/.test(both) && /Add the store password/.test(both));
    check("…carries the idempotency key", key === "k1");
    check("…says nothing about how we check, and hands out no homework", !hasEnvironmentLeak(both) && !hasHomework(both) && !/browser|headless|playwright|model|token/i.test(both));
  }

  // ─── 6. the places that use it ────────────────────────────────────────────
  console.log("\n6. wiring\n");
  // Read as syntax (scripts/fixtures/ts-source.ts), not as text: a reformat
  // must neither break these nor make them pass by accident.
  const called = (callsList: Call[], callee: string, args: string[]) =>
    callsList.some((c) => c.callee === callee && JSON.stringify(c.args) === JSON.stringify(args));
  const wf = source("src/agent/workflow.ts");
  const stepBody = (name: string) => calls(wf).find((c) => c.callee === "step.do" && c.args[0] === `"${name}"`)?.node.arguments[1];
  const tellsAdmin = (name: string) => {
    const body = stepBody(name);
    return Boolean(body) && called(calls(wf, body), "noticeNewCauses", ["env", "runId"]);
  };
  check('the workflow tells the admin after a walked run ("admin-causes")', tellsAdmin("admin-causes"));
  check('…and after a run that ended at a sign-in that had ended ("admin-causes-signed-out")', tellsAdmin("admin-causes-signed-out"));

  const view = source("src/components/verdict-view.tsx");
  check(
    "the verdict page gives every unchecked step its sentence, for a team given `shopify`",
    called(calls(view), "teamHasFeature", ["prisma", "run.teamId", '"shopify"']) &&
      calls(view).some((c) => c.callee === "causeLine") &&
      jsx(view).some((e) => e.tag === "JourneyStrips" && e.props.causeTexts === "causeTexts"),
  );
  const strip = source("src/components/journey-strip.tsx");
  check(
    "the strip prints it on the card and in the step's detail",
    elementAccesses(strip).some(([o, i]) => o === "causeTexts" && i === "step.id") &&
      jsx(strip).some((e) => e.tag === "StepDetail" && e.props.cause === "causeTexts?.[selected.id]"),
  );

  const page = source("src/app/(app)/health/apps/[appId]/page.tsx");
  // The gate is `forAdmin` (CHE-434 shares it with the members' reports), and
  // the card is rendered behind it.
  const gate = initializerOf(page, "forAdmin");
  const card = jsx(page).find((e) => e.tag === "NeedsAttention" && e.guard === "forAdmin");
  const aside = jsx(page).find((e) => e.tag === "aside");
  const cost = jsxTextAt(page, "This app costs")[0];
  check(
    "the app page shows the admin card first in its right column, for an admin of a `shopify` team",
    Boolean(gate) &&
      ts.isBinaryExpression(gate!) &&
      gate.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      gate.left.getText(page) === 'scope === "admin"' &&
      called(calls(page, gate.right), "teamHasFeature", ["db", "team.id", '"shopify"']) &&
      Boolean(card && aside && cost !== undefined) &&
      card!.node.getStart(page) > aside!.node.getStart(page) &&
      card!.node.getStart(page) < cost,
  );
  check(
    "…and only what is the team's to act on (not our incapacity)",
    calls(page).some((c) => c.callee === "causeRoute" && c.args[0] === "g.cause" && /=== "admin"$/.test(c.node.parent.getText(page))),
  );
  // CHE-434 place 9: the members' reports sit on the same card, for the same admin.
  // `const [attention, attentionReports] = forAdmin ? await Promise.all([…]) : […]`
  let reportsInit: ts.Expression | undefined;
  const findPair = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && /attentionReports/.test(n.name.getText(page)) && n.initializer) reportsInit = n.initializer;
    n.forEachChild(findPair);
  };
  findPair(page);
  const both = reportsInit && ts.isConditionalExpression(reportsInit) ? calls(page, reportsInit.whenTrue) : [];
  check(
    "the card also lists the team's reports about the check, for the same admin",
    Boolean(reportsInit) &&
      ts.isConditionalExpression(reportsInit!) &&
      reportsInit.condition.getText(page) === "forAdmin" &&
      // The newest few, asked of the database — not a slice of the first 200 (Codex on #320).
      both.some((c) => c.callee === "latestAppFeedback" && c.args.join(",") === "db,team.id,app.id,CARD_REPORTS") &&
      card?.props.reports === "attentionReports",
  );
  check(
    "…read together with the causes, not after them (Codex on #320)",
    both.some((c) => c.callee === "Promise.all" && /causesOfAppsLatestRun/.test(c.args[0] ?? "") && /latestAppFeedback/.test(c.args[0] ?? "")),
  );
  // Every sentence the card says about a report comes from one pure module and
  // passes the language guards whole (R18; Codex on #320).
  const sample = { reason: "wrong" as const, text: "The list is empty only for us", author: "Ann", status: "filed", findingNumber: null, stepLabel: null, scenarioTitle: "Block a country", runPublicId: null, scenarioId: "s1" };
  const copy = [REPORTS_HEADING, reportLine(sample), reportQuote(sample), reportStatus(sample), reportLink(sample, "/scope")?.text ?? ""];
  check("the card's report sentences pass the homework, leak and narration guards", copy.every((s) => !hasHomework(s) && !hasEnvironmentLeak(s) && !hasNarration(s)), copy.join(" | "));
  const scenarioReport = [reportLine(sample), reportLink(sample, "/health/apps/a1/settings/scope")];
  check("a report on a scenario names the scenario and links to the app's scenarios",
    JSON.stringify(scenarioReport) === JSON.stringify(["The check got it wrong · scenario “Block a country”", { href: "/health/apps/a1/settings/scope", text: "the scenario" }]),
    JSON.stringify(scenarioReport));
  const cardText = source("src/components/needs-attention.tsx");
  check("…and the card writes none of them itself (no report text in its JSX)", jsxTextAt(cardText, "team reported").length === 0 && jsxTextAt(cardText, "the check").length === 0);
  const rendered = renderToStaticMarkup(
    createElement(NeedsAttention, {
      appId: "a1",
      runNumber: null,
      groups: [],
      reports: [
        {
          id: "f1", kind: "finding", reason: "wrong", text: "The list is empty only for us", author: "Ann", at: "2026-10-12T10:00:00.000Z",
          status: "fixed", findingNumber: 3, journeyId: null, stepId: null, stepLabel: null, runPublicId: "pubA", scenarioId: null, scenarioTitle: null,
        },
      ],
    }),
  );
  check(
    "…each with what it was about, who said it and where it stands",
    /finding #003/.test(rendered) && /Ann/.test(rendered) && rendered.includes(">fixed") && rendered.includes('href="/verdict/pubA"'),
    rendered.slice(0, 300),
  );
  check("a card with no cause and no report is not shown", renderToStaticMarkup(createElement(NeedsAttention, { appId: "a1", runNumber: 1, groups: [], reports: [] })) === "");
  const cardSf = source("src/components/needs-attention.tsx");
  check("the card has no button and no form: the cause is text, with a link to where it is fixed", !jsx(cardSf).some((e) => e.tag === "button" || e.tag === "form"));
  // "Add the store password" goes to the accounts section, so the password must
  // be settable there — it used to be MCP-only, and the link led nowhere.
  check(
    "the accounts section the card links to has a store password box, and the save reads it",
    properties(source("src/lib/step-cause.ts"), "store_password").some((v) => /to: "accounts"/.test(v)) &&
      jsx(source("src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx")).some((e) => e.tag === "Input" && e.props.name === '"storePassword"') &&
      properties(source("src/app/dashboard/actions.ts"), "storePassword").some((v) => /^formData\.get\("storePasswordRemove"\) \? "" : text\("storePassword"\)/.test(v)),
  );
  const gaps = source("src/agent/capability-gaps.ts");
  check(
    "the gap filer puts `mender` on every ticket it opens and on every recurrence",
    called(calls(gaps), "selfPolicy", ["self", '"[Checker gap] {verdict}"', "[MENDER_LABEL]"]) &&
      called(calls(gaps), "tracker.addLabel", ["outcome.identifier", "MENDER_LABEL"]),
  );

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
