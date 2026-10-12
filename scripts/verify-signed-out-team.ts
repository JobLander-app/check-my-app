// CHE-428 verification: when the sign-in an app's checks use has ended, the
// people who hear that app's checks are told — once per ended sign-in — on a
// real D1 (Miniflare) with a stub mailer.
//
//   1. the first run that meets an ended sign-in mails the app's recipients,
//      with the app's own sign-in page;
//   2. the next runs that meet the same ended sign-in send nothing;
//   3. a new sign-in that ends again is a new mail;
//   4. a failed send puts the claim back, and the next run sends;
//   5. our own product checked by us, and a self-check account, stay silent;
//   6. the words: access asked for, no homework, nothing about how we check.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-signed-out-team.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { tellTeamSignedOut } from "../src/agent/signed-out";
import { signInEndedCopy, type sendSignInEnded } from "../src/lib/email";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import { calls, source } from "./fixtures/ts-source";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  const copy = signInEndedCopy({ appSlug: "admin.shopify.com", host: "accounts.shopify.com" });
  const all = `${copy.subject} ${copy.body}`;
  check("the mail asks for a sign-in and nothing else: no homework, no machinery", !hasHomework(all) && !hasEnvironmentLeak(all), all);

  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "admin", clerkUserId: "ck_1", email: "vladislav@securify.test" } });
    await db.user.create({ data: { id: "qa", clerkUserId: "ck_2", email: "qa@checkmyapp.test", isTestAccount: true } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.membership.create({ data: { teamId: "ts", userId: "admin", scope: "admin" } });
    const reached1 = new Date("2026-10-10T08:00:00Z");
    await db.app.create({ data: { id: "a1", teamId: "ts", ownerId: "admin", appSlug: "admin.shopify.com", targetUrl: "https://admin.shopify.com/store/x/apps/y", targetKind: "website", sessionReachedAt: reached1 } });
    const mails: { to: string; signInUrl: string; key?: string }[] = [];
    let failNext = 0;
    const send: typeof sendSignInEnded = async (m) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("Resend send failed: 500");
      }
      mails.push({ to: m.to, signInUrl: m.signInUrl, key: m.idempotencyKey });
    };
    const env = { db, bindings: { EMAIL_API_KEY: "re_stub", EMAIL_FROM: "CheckMyApp <v@checkmyapp.dev>", APP_URL: "https://checkmyapp.dev" } };
    const run = { appId: "a1", appSlug: "admin.shopify.com", targetUrl: "https://admin.shopify.com/store/x/apps/y", ownerId: "admin", teamId: "ts", watchId: "w1" };

    // 1.
    const first = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    eq("the first run that meets it mails the app's people", [first.told, mails.map((m) => m.to)], ["sent", ["vladislav@securify.test"]]);
    check("…with the app's own sign-in page", mails[0]?.signInUrl === "https://checkmyapp.dev/health/apps/a1/sign-in", mails[0]?.signInUrl);

    // 2.
    const second = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    const third = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    eq("the next runs meeting the same ended sign-in send nothing", [second.told, third.told, mails.length], ["already", "already", 1]);

    // 3.
    await db.app.update({ where: { id: "a1" }, data: { sessionReachedAt: new Date("2026-10-11T08:00:00Z") } });
    const again = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    eq("a sign-in that worked and ended again is a new mail", [again.told, mails.length], ["sent", 2]);
    check("…under a different key", mails[0].key !== mails[1].key, `${mails[0].key} / ${mails[1].key}`);

    // 4.
    await db.app.update({ where: { id: "a1" }, data: { sessionReachedAt: new Date("2026-10-12T08:00:00Z") } });
    failNext = 1;
    const failed = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    eq("a failed send is said and nothing counts as told", [failed.told, mails.length], ["failed", 2]);
    const retried = await tellTeamSignedOut(env as never, run, "accounts.shopify.com", send);
    eq("the next run sends it", [retried.told, mails.length], ["sent", 3]);

    // 5.
    await db.app.create({ data: { id: "own", teamId: "ts", ownerId: "admin", appSlug: "checkmyapp.dev", targetUrl: "https://checkmyapp.dev", targetKind: "website" } });
    const ours = await tellTeamSignedOut(env as never, { ...run, appId: "own", appSlug: "checkmyapp.dev", targetUrl: "https://checkmyapp.dev" }, "accounts.google.com", send);
    eq("our own product checked by us stays silent", [ours.told, mails.length], ["silent", 3]);
    const selfCheck = await tellTeamSignedOut(env as never, { ...run, ownerId: "qa" }, "accounts.shopify.com", send);
    eq("a self-check account's run stays silent", [selfCheck.told, mails.length], ["silent", 3]);
    eq("a run with no saved app has nobody to tell", (await tellTeamSignedOut(env as never, { ...run, appId: null }, "x", send)).told, "no_app");
  } finally {
    await real.dispose();
  }

  // The workflow tells the team in a step of its own, on the signed-out path.
  const wf = source("src/agent/workflow.ts");
  const body = calls(wf).find((c) => c.callee === "step.do" && c.args[0] === '"tell-team-signed-out"')?.node.arguments[1];
  check("the workflow's signed-out path tells the team in its own step",
    Boolean(body) && calls(wf, body).some((c) => c.callee === "tellTeamSignedOut" && c.args[0] === "env" && c.args[2] === "host"));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
