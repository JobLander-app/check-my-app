// Every journey we script for an installed extension arrives priced.
//
// shapeExtensionDiscovery throws away what the model proposed and writes the
// journeys itself. It wrote them with no price and no conversion, so none of
// them could ever be priced, and capability-gaps.ts filed "[Checker gap]
// Checker cannot say what a journey costs its user" after every extension run -
// re-filed on the board more than fifty times without anyone being able to
// close it. A price is a judgement owed to the owner (CLAUDE.md rule 2); the
// fix is that the scripted journey carries one, not that the gap is silenced.
//
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-extension-journey-pricing.ts

import { shapeExtensionDiscovery } from "../src/agent/extension-discovery";
import type { ExtensionSession } from "../src/agent/extension-contract";
import { decideMetric, MIN_NOTE_CHARS, MIN_PRICE } from "../src/agent/journey-metrics";
import { journeyMetric } from "../src/agent/journey-catalog";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "../src/lib/verdict-language";
import type { AgentEnv } from "../src/agent/env";

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  if (ok) console.log(`PASS  ${what}`);
  else {
    failures += 1;
    console.log(`FAIL  ${what}${detail ? `  ->  ${detail}` : ""}`);
  }
}

const identity = { extensionId: "hafhjepjihcimcljkdphpinannbdmnhf", installedVersion: "3.26.1" } as ExtensionSession;
const observed = [
  { surface: "native-popup", controls: [{ role: "push button", name: "Sign in with email" }, { role: "static", name: "Show JobLander Insights" }] },
  { source: "account-ui", balance: 1608, historyObserved: true },
  { surface: "practice-page", startAvailable: true, controls: [{ role: "button", name: "Start call" }] },
].map((read) => JSON.stringify(read)).join("\n");

const { journeys } = shapeExtensionDiscovery(identity, observed, []);
check("all five scripted journeys are produced", journeys.length === 5, String(journeys.length));

for (const j of journeys) {
  const m = j.metric;
  check(`${j.title}: carries a price and a conversion`, !!m && m.price !== null && m.conversion !== null);
  if (!m || m.price === null || m.conversion === null) continue;
  check(`${j.title}: the price is at least one action`, m.price >= MIN_PRICE, String(m.price));
  check(`${j.title}: the conversion is within 0-100`, m.conversion >= 0 && m.conversion <= 100);
  check(`${j.title}: the note says what the flow is`, m.note.trim().length >= MIN_NOTE_CHARS);
  check(
    `${j.title}: the note describes their product only`,
    !hasEnvironmentLeak(m.note) && !hasHomework(m.note) && !hasNarration(m.note),
    m.note,
  );
  const first = decideMetric(m, null, null);
  check(`${j.title}: an unpriced journey takes it as a first value`, first.value !== null && first.unpriced !== true, first.reason);
}

// journeyMetric against a catalog that holds `stored` for the journey.
function envWith(stored: { price: number; conversion: number; metricNote: string } | null): AgentEnv {
  return {
    db: {
      appJourney: { findUnique: async () => stored },
      journey: { findMany: async () => [] },
    },
  } as unknown as AgentEnv;
}

async function main() {
  const scripted = journeys[0].metric!;
  const opened = await journeyMetric(envWith(null), "aj1", scripted);
  check("a journey with no stored price is priced by its script", opened?.price === scripted.price && opened?.conversion === scripted.conversion);

  const stored = { price: 12, conversion: 30, metricNote: "the session start now asks for a second confirmation" };
  const again = await journeyMetric(envWith(stored), "aj1", scripted);
  check("a stored price is never restated by the script", again === null, JSON.stringify(again));

  // The model's own numbers keep moving a stored price, as before.
  const moved = await journeyMetric(envWith(stored), "aj1", { price: 9, conversion: 30, note: "one confirmation was removed from starting a session" });
  check("a model that names a change still moves the stored price", moved?.price === 9);

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nExtension journeys: every scripted journey is priced, and only until a price is stored");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
