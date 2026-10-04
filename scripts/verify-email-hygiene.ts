// CHE-226 acceptance: every mail we send looks like a legitimate sender's mail
// to a stranger's provider — the first verdict to a customer outside this
// account (2026-09-28, a daily check) landed in Gmail's spam.
//
// Authentication was never the problem: SPF, DKIM (resend._domainkey) and DMARC
// all align on checkmyapp.dev. What this holds is the rest of what the message
// carries, for all four senders in src/lib/email.ts, by driving the REAL send
// functions against a stub provider and reading the body they POST:
//
//   - a complete HTML document, not a fragment;
//   - a plain-text twin (the trial-paused mail had none);
//   - one line saying why this address gets the mail, and on a recurring mail
//     where to change or stop it;
//   - a From with a display name, so the inbox shows "CheckMyApp", not "verdicts".
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-email-hygiene.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  sendBalanceUsedUp,
  sendTeamInvite,
  sendVerdictReady,
  sendWatchTrialPaused,
} from "@/lib/email";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

interface Posted {
  from?: string;
  subject?: string;
  reply_to?: string;
  html?: string;
  text?: string;
}

async function capture(send: () => Promise<unknown>): Promise<Posted> {
  const realFetch = globalThis.fetch;
  let body: Posted = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Posted;
    return new Response(JSON.stringify({ id: "msg_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await send();
  } finally {
    globalThis.fetch = realFetch;
  }
  return body;
}

const REPLY_TO = "CheckMyApp <hello@checkmyapp.dev>";
const common = {
  apiKey: "re_stub",
  from: "CheckMyApp <verdicts@checkmyapp.dev>",
  replyTo: REPLY_TO,
  baseUrl: "https://checkmyapp.dev",
};

async function main(): Promise<void> {
  const mails: [string, Posted, { recurring: boolean }][] = [
    [
      "verdict, daily check",
      await capture(() =>
        sendVerdictReady({
          ...common,
          to: "a@example.org",
          appSlug: "app.example.org",
          publicId: "pub_1",
          verdict: "needs_attention",
          recurring: true,
          bottomLine: "Sign-up works; the pricing page does not load.",
          findingCounts: { broken: 1, total: 2 },
        }),
      ),
      { recurring: true },
    ],
    [
      "verdict, one-off check",
      await capture(() =>
        sendVerdictReady({ ...common, to: "a@example.org", appSlug: "app.example.org", publicId: "pub_2", verdict: "all_good" }),
      ),
      { recurring: false },
    ],
    [
      "daily watch trial paused",
      await capture(() => sendWatchTrialPaused({ ...common, to: "a@example.org", appSlug: "app.example.org" })),
      { recurring: false },
    ],
    [
      "balance used up",
      await capture(() =>
        sendBalanceUsedUp({ ...common, to: "a@example.org", appSlug: "app.example.org", reason: "The balance is used." }),
      ),
      { recurring: true },
    ],
    [
      "team invite",
      await capture(() =>
        sendTeamInvite({
          ...common,
          to: "b@example.org",
          teamName: "Acme",
          invitedBy: "Ann",
          scope: "member",
          acceptUrl: "https://checkmyapp.dev/invite/tok",
        }),
      ),
      { recurring: false },
    ],
  ];

  for (const [name, m, { recurring }] of mails) {
    console.log(`\n${name}\n`);
    const html = m.html ?? "";
    check(`${name}: HTML is a complete document`, /^<!doctype html>/i.test(html) && /<\/body><\/html>$/.test(html));
    check(`${name}: the document has a title`, /<title>[^<]+<\/title>/.test(html));
    check(`${name}: a plain-text twin is sent`, typeof m.text === "string" && m.text.trim().length > 40, String(m.text?.length ?? 0));
    check(`${name}: the HTML says why this address gets it`, html.includes("You get this because"));
    check(`${name}: so does the text`, (m.text ?? "").includes("You get this because"));
    if (recurring) {
      check(`${name}: a recurring mail says where to change or stop it`, (m.text ?? "").includes("https://checkmyapp.dev/settings/account"));
    }
    check(`${name}: nothing about how we check leaks into the footer`, !/browser|headless|playwright|model|token/i.test(m.text ?? ""));
    check(`${name}: a reply goes to a mailbox somebody reads`, m.reply_to === REPLY_TO, String(m.reply_to));
  }

  console.log("\nreply path\n");
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const src = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
  check(
    "agent worker: EMAIL_REPLY_TO is a named address on our domain",
    /"EMAIL_REPLY_TO":\s*"CheckMyApp <hello@checkmyapp\.dev>"/.test(src("wrangler-agent.jsonc")),
  );
  check("notify-verdict: the verdict mail passes EMAIL_REPLY_TO", /replyTo: bindings\.EMAIL_REPLY_TO/.test(src("src/agent/notify-verdict.ts")));
  check(
    "scheduler: both notices pass EMAIL_REPLY_TO",
    (src("src/agent/scheduler.ts").match(/replyTo: bindings\.EMAIL_REPLY_TO/g) ?? []).length === 2,
  );
  check("mailer: the invite passes EMAIL_REPLY_TO", /replyTo: this\.env\.EMAIL_REPLY_TO/.test(src("src/agent/mailer.ts")));
  check(".env.example: EMAIL_REPLY_TO is documented", /^EMAIL_REPLY_TO="CheckMyApp <hello@checkmyapp\.dev>"/m.test(src(".env.example")));

  console.log("\nsender\n");
  const agentConfig = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "wrangler-agent.jsonc"),
    "utf8",
  );
  const from = agentConfig.match(/"EMAIL_FROM":\s*"([^"]+)"/)?.[1] ?? "";
  check(
    "agent worker: EMAIL_FROM carries a display name and our domain",
    /^CheckMyApp <[^@\s>]+@checkmyapp\.dev>$/.test(from),
    from,
  );
  // The documented value is what a new deployment copies; it must not bring
  // the bare address back.
  const envExample = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.example"),
    "utf8",
  );
  const documented = envExample.match(/^EMAIL_FROM="([^"]*)"/m)?.[1] ?? "";
  check(
    ".env.example: the documented EMAIL_FROM carries the same display name",
    /^CheckMyApp <[^@\s>]+@checkmyapp\.dev>$/.test(documented),
    documented,
  );
}

main().then(
  () => {
    console.log(`\n${failures === 0 ? "all pass" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
