// CHE-328: a verdict mail goes out once per run and recipient, however many
// times the Workflow step that sends it runs.
//
// Run #263 (2026-09-28, our first external customer): the notify step sent the
// mail, then died with WorkflowInternalError; the platform retried the step and
// the customer received the same verdict twice. The fix is Resend's
// Idempotency-Key, stable across attempts. This checks the key's shape, that it
// reaches the provider, that a 409 for a reused key is treated as "already
// sent", and that the notify path actually passes it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-verdict-email-once.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type Seen = { key: string | null };

async function main() {
  const email = (await import("@/lib/email")) as Record<string, unknown>;
  const sendVerdictReady = email.sendVerdictReady as (a: Record<string, unknown>) => Promise<string | null>;
  const keyFor = email.verdictIdempotencyKey as ((p: string, t: string) => string) | undefined;
  check("email: verdictIdempotencyKey exists", typeof keyFor === "function");
  if (typeof keyFor !== "function") return finish();

  check("key: stable across attempts for the same run and recipient", keyFor("pub_1", "a@x.test") === keyFor("pub_1", "a@x.test"));
  check("key: differs per recipient", keyFor("pub_1", "a@x.test") !== keyFor("pub_1", "b@x.test"));
  check("key: differs per run", keyFor("pub_1", "a@x.test") !== keyFor("pub_2", "a@x.test"));
  check("key: case of the address does not split it", keyFor("pub_1", "A@X.test") === keyFor("pub_1", "a@x.test"));
  check("key: within Resend's 256-character limit", keyFor("p".repeat(300), "a@x.test").length <= 256);

  const seen: Seen[] = [];
  let reply: () => Response = () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ key: headers.get("Idempotency-Key") });
    return reply();
  }) as typeof fetch;

  const args = {
    to: "a@x.test", appSlug: "app.test", publicId: "pub_1", verdict: "mostly_ok", recurring: true,
    bottomLine: "Works.", apiKey: "re_test", from: "v@checkmyapp.dev", baseUrl: "https://checkmyapp.dev",
    idempotencyKey: keyFor("pub_1", "a@x.test"),
  };
  await sendVerdictReady(args);
  await sendVerdictReady(args);
  check("send: the key reaches Resend as Idempotency-Key", seen[0]?.key === args.idempotencyKey, JSON.stringify(seen[0]));
  check("send: a second attempt carries the same key", seen.length === 2 && seen[1].key === seen[0].key);

  reply = () => new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
  let threw = false;
  let out: string | null | undefined;
  try {
    out = await sendVerdictReady(args);
  } catch {
    threw = true;
  }
  check("send: a 409 for a reused key is 'already sent', not a failure", !threw && out === null);

  reply = () => new Response("boom", { status: 500 });
  let threw500 = false;
  try {
    await sendVerdictReady(args);
  } catch {
    threw500 = true;
  }
  check("send: any other refusal still fails", threw500);

  const notify = readFileSync(join(process.cwd(), "src/agent/notify-verdict.ts"), "utf8");
  check("notify: the verdict send passes a key built from the run and the recipient",
    /idempotencyKey:\s*verdictIdempotencyKey\(run\.publicId,\s*to\)/.test(notify));
  finish();
}

function finish() {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
