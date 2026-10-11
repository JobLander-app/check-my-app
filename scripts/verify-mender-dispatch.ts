// CHE-445: the worker's cron is Mender's clock (GitHub fired the workflow's
// own schedule every 4–7 h). Without a token it does nothing; with one it asks
// GitHub for exactly one run of mender-agent.yml on main; a refusal is an
// error the scheduler logs and survives.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mender-dispatch.ts

import { readFileSync } from "node:fs";
import { dispatchMender, MENDER_REPO, MENDER_WORKFLOW } from "../src/agent/mender-dispatch";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

async function main() {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 204 }));

  check("no token, no call", (await dispatchMender({}, ok)) === "no-token" && calls.length === 0);

  check("with a token, one dispatch", (await dispatchMender({ MENDER_DISPATCH_TOKEN: "t" }, ok)) === "dispatched" && calls.length === 1);
  check("…of mender-agent.yml in this repository, on main",
    calls[0]?.url === `https://api.github.com/repos/${MENDER_REPO}/actions/workflows/${MENDER_WORKFLOW}/dispatches` &&
      JSON.parse(String(calls[0]?.init.body)).ref === "main" && calls[0]?.init.method === "POST");

  let threw = false;
  try {
    await dispatchMender({ MENDER_DISPATCH_TOKEN: "t" }, async () => new Response("{}", { status: 403 }));
  } catch {
    threw = true;
  }
  check("a refusal is an error, not a silent success", threw);

  const scheduler = readFileSync("src/agent/scheduler.ts", "utf8");
  check("the scheduler calls it every tick and survives its failure",
    /try \{\s*\n\s*await dispatchMender\(env\.bindings\);\s*\n\s*\} catch/.test(scheduler));

  console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
