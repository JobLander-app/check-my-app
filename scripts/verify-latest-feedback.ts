// CHE-434 place 9 verification: the admin card reads an app's newest reports,
// on a real D1 (Miniflare), past the 200 rows listFeedback keeps — the case
// Codex found on #320 (205 reports showed 196–200 and hid 201–205).
//
//   1. latestAppFeedback returns exactly the newest five, newest first, at 205;
//   2. another app's and another team's reports are not among them;
//   3. a report on a scenario carries the scenario's title.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-latest-feedback.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { latestAppFeedback } from "../src/lib/feedback";
import { reportQuote } from "../src/lib/report-card-copy";

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
    await db.user.create({ data: { id: "u", clerkUserId: "ck", email: "ann@securify.test", name: "Ann" } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business" } });
    await db.team.create({ data: { id: "to", name: "Other", plan: "business" } });
    await db.app.create({ data: { id: "a1", teamId: "ts", ownerId: "u", appSlug: "a1.test", targetUrl: "https://a1.test/" } });
    await db.app.create({ data: { id: "a2", teamId: "ts", ownerId: "u", appSlug: "a2.test", targetUrl: "https://a2.test/" } });
    await db.app.create({ data: { id: "ao", teamId: "to", ownerId: "u", appSlug: "ao.test", targetUrl: "https://ao.test/" } });
    await db.appJourney.create({ data: { id: "s1", appId: "a1", key: "block", title: "Block a country", source: "team" } });
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 1; i <= 205; i++) {
      await db.feedback.create({
        data: { id: `f${i}`, teamId: "ts", appId: "a1", kind: i === 205 ? "scenario" : "run", reason: "wrong", text: `report ${i}`, authorId: "u", appJourneyId: i === 205 ? "s1" : null, createdAt: new Date(t0 + i * 60_000) },
      });
    }
    // Newer rows elsewhere that must not leak in.
    await db.feedback.create({ data: { id: "x1", teamId: "ts", appId: "a2", kind: "run", reason: "wrong", text: "other app", authorId: "u", createdAt: new Date(t0 + 999 * 60_000) } });
    await db.feedback.create({ data: { id: "x2", teamId: "to", appId: "ao", kind: "run", reason: "wrong", text: "other team", authorId: "u", createdAt: new Date(t0 + 999 * 60_000) } });

    const latest = await latestAppFeedback(db, "ts", "a1", 5);
    eq("205 reports: exactly the newest five, newest first", latest.map((r) => r.id), ["f205", "f204", "f203", "f202", "f201"]);
    check("…none from another app or another team", latest.every((r) => r.id.startsWith("f")));
    eq("a report on a scenario carries the scenario's title", [latest[0].scenarioId, latest[0].scenarioTitle], ["s1", "Block a country"]);
    eq("…and another team's key reads none of them", (await latestAppFeedback(db, "to", "a1", 5)).length, 0);
  } finally {
    await real.dispose();
  }

  // Excerpts cut by characters, never through one (Codex on #320).
  const quote = reportQuote({ text: `${"a".repeat(139)}😀 and more`, author: "Ann" });
  check("an excerpt never splits a character in two", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(quote) && quote.includes("😀…"), quote.slice(130));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
