// CHE-431: the doer's ladder is real. A withdrawn attempt counts only against
// the model that made it, so a ticket t1 gave up on twice is fresh for t2.
//
// Why: from 2026-10-04 every admitted ticket (CHE-96, CHE-146, CHE-222) had two
// withdrawn t1 attempts (deepseek-v4-flash, 40 steps; 9 of 11 since 2026-09-18
// produced no patch), and counting every model together stopped every tick on
// "no implementer is delivering on these" — mender.yml's `ladder: [t1, t2]`
// could never reach t2.
//
// Usage: node scripts/verify-doer-ladder.mjs

import { readFileSync } from "node:fs";
import { WITHDRAWN_TITLE_PREFIX, tierModel, withdrawnByModel } from "./doer/mender.mjs";

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

// #284's body, verbatim — the shape every withdrawn attempt records.
const t1 = {
  title: `${WITHDRAWN_TITLE_PREFIX} — Checker reported a product defect from the absence of evidence`,
  mergedAt: null,
  body: "**Attempt withdrawn.** Mender's gate was truncated at `test` · $0.01147 · 40 steps · deepseek/deepseek-v4-flash",
};
check("a t1 withdrawal counts against the t1 model", withdrawnByModel(t1, "deepseek/deepseek-v4-flash") === true);
check("…and not against t2, which the ladder brings in for exactly these tickets",
  withdrawnByModel(t1, "minimax/minimax-m3") === false);
check("no model named counts nothing", withdrawnByModel(t1, "") === false);
check("a merged attempt is never a withdrawal, whatever its model",
  withdrawnByModel({ ...t1, mergedAt: "2026-10-07T00:00:00Z" }, "deepseek/deepseek-v4-flash") === false);
check("the tier names its model",
  tierModel({ MENDER_TIER: "t2", MENDER_T2: "minimax/minimax-m3", MENDER_T1: "deepseek/deepseek-v4-flash" }) === "minimax/minimax-m3");

const tick = readFileSync(new URL("./doer/tick.mjs", import.meta.url), "utf8");
check("the tick counts withdrawals by its own model, reading each attempt's body",
  /withdrawnByModel\(p, model\)/.test(tick) && /headRefName,mergedAt,title,body/.test(tick));

const wf = readFileSync(new URL("../.github/workflows/doer.yml", import.meta.url), "utf8");
const tier = wf.match(/MENDER_TIER:\s*(\w+)/)?.[1] ?? "";
check("the workflow's tier has a model named for it",
  tier !== "" && new RegExp(`MENDER_${tier.toUpperCase()}:\\s*\\S+`).test(wf), tier || "no MENDER_TIER");

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
