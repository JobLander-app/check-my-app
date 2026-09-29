// CHE-341 acceptance: a team invitation leaves through the agent worker, which
// holds the only mail key — and a production web worker that cannot send says
// so instead of logging as if it were local dev.
//
// The defect: the web worker never had EMAIL_API_KEY or EMAIL_FROM (checked with
// `wrangler secret list --name checkmyapp-web`, 2026-09-29), all three invite
// call sites passed those missing values to sendTeamInvite, and sendTeamInvite
// reads a missing key as local dev and only logs. Every invitation would have
// been created, answered 201, and never mailed.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-invite-mail.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sendInviteMail } from "@/lib/invite-mail";
import type { TeamInviteMail } from "@/lib/email";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const mail: TeamInviteMail = {
  to: "b@example.org",
  teamName: "Acme",
  invitedBy: "Ann",
  scope: "member",
  acceptUrl: "https://checkmyapp.dev/invite/tok",
};

async function main(): Promise<void> {
  console.log("\n1 — the send goes through the MAILER binding when it exists\n");
  {
    const received: unknown[] = [];
    const env = {
      MAILER: {
        sendTeamInvite: async (m: TeamInviteMail) => {
          received.push(m);
          return "msg_1";
        },
      },
    };
    const id = await sendInviteMail(env, mail);
    check("the binding was called once", received.length === 1, String(received.length));
    check("the provider id comes back to the caller", id === "msg_1", String(id));
    check(
      "the web worker hands over no key and no sender — only the agent worker has them",
      received.length === 1 && !("apiKey" in (received[0] as object)) && !("from" in (received[0] as object)),
    );
  }

  console.log("\n2 — no binding in production is an error, not a dev log\n");
  {
    const realEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    let threw = false;
    try {
      await sendInviteMail({}, mail);
    } catch {
      threw = true;
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = realEnv;
    }
    check("production without MAILER throws", threw);
  }

  console.log("\n3 — the wiring\n");
  {
    const web = source("wrangler.jsonc");
    check(
      "web worker: MAILER is a service binding to checkmyapp-agent's Mailer entrypoint",
      /"binding":\s*"MAILER"[\s\S]{0,80}"service":\s*"checkmyapp-agent"[\s\S]{0,80}"entrypoint":\s*"Mailer"/.test(web),
    );
    check("agent worker: the entry exports Mailer", /export \{ Mailer \} from "\.\/mailer"/.test(source("src/agent/index.ts")));
    const mailer = source("src/agent/mailer.ts");
    check("Mailer extends WorkerEntrypoint", /class Mailer extends WorkerEntrypoint</.test(mailer));
    check(
      "Mailer refuses to fall back to a log when its own key is missing",
      /if \(!this\.env\.EMAIL_API_KEY \|\| !this\.env\.EMAIL_FROM\)\s*\{\s*throw new Error/.test(mailer),
    );

    const appFiles = filesUnder(path.join(repoRoot, "src", "app"));
    const direct = appFiles.filter((f) => /\bsendTeamInvite\(/.test(readFileSync(f, "utf8")));
    check(
      "no web route calls sendTeamInvite directly",
      direct.length === 0,
      direct.map((f) => path.relative(repoRoot, f)).join(", "),
    );
    const keyReaders = appFiles.filter((f) => /bindings\.EMAIL_API_KEY|env\.EMAIL_API_KEY/.test(readFileSync(f, "utf8")));
    check(
      "no web route reads a mail key of its own",
      keyReaders.length === 0,
      keyReaders.map((f) => path.relative(repoRoot, f)).join(", "),
    );
    const callers = appFiles.filter((f) => /\bsendInviteMail\(/.test(readFileSync(f, "utf8")));
    check("all three invite paths send through sendInviteMail", callers.length === 3, String(callers.length));
  }
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
