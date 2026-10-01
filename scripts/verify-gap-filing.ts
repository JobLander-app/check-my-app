// CHE-198 verification: every our_capability step files a gap ticket that
// names the capability, deduped by that capability; the unclassified bucket
// is the last resort, and it records the step so it can be classified next
// time; the classes that already had tickets keep their dedup keys.
//
// Two real steps from prod D1 (2026-09-06) drive this, byte for byte as the
// rows were stored: run #153 (joblander.app) "Modify Insight Preferences
// (slider) and Save/Reset" and run #154 (meetbashar.com) "Click a ▶ Video
// link (YouTube session)". Both were skipped / our_capability and both landed
// on CHE-86 "unclassified" (its Linear comments at 17:00:30 and 19:26:28 UTC).
//
// The filing path is the real one — fileCapabilityGaps → fileFindingTicket →
// dedupKeyForFinding — over a prisma-like stub and a stub tracker; no
// network, no model, no database. The dedup keys asserted for the existing
// classes are the keys on the IssueLink rows in prod (CHE-85/86/94/96/104/
// 146/164), so a label that drifts fails here before it forks a ticket.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-gap-filing.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AgentEnv } from "@/agent/env";
import { fileCapabilityGaps, type GapBoard } from "@/agent/capability-gaps";
import { GAP_CLASSES, classifyGap, gapEvidenceText, type GapClass, type GapEvidence } from "@/agent/gap-classes";
import type { RecordedAction, ReportedStep } from "@/agent/tools";
import { productizeStep } from "@/agent/tools";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import type { CreatedIssue, IssueOutcome, TicketDraft, Tracker } from "@/lib/tracker/types";
import { CHE_333, readBackSql, seedProblem, seedSql, shopifyAdminDedupKey, type LinkRow } from "./seed-gap-link-che-333";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── The two steps, as stored in prod D1 ─────────────────────────────────────

interface StoredStep {
  label: string;
  attempted: string | null;
  observed: string | null;
  gapClass: string | null;
  actions: string | null;
  journey: { title: string };
}

// Run #153, step cmtq217j4001cu60n4newo9er.
const SLIDER_153: StoredStep = {
  label: "Modify Insight Preferences (slider) and Save/Reset",
  attempted:
    'Set the Widget opacity range slider to a new value, and clicked "Reset to Defaults". Attempted to move the four visible styling sliders (Brief/Detailed, Generic/Personalized, Neutral/Promotional, Simple/Technical) to enable "Save Changes".',
  observed: 'The Widget opacity range input accepted a fill (78). "Reset to Defaults" is clickable and produced no error.',
  gapClass: null,
  actions: JSON.stringify([
    { kind: "click", role: "slider", name: "Widget opacity", outcome: { urlAfter: "https://joblander.app/settings", navigated: false, requests: 1, mutations: 14 } },
    { kind: "fill", selector: "input[type=range]", value: "78", outcome: { urlAfter: "https://joblander.app/settings" } },
    { kind: "click", role: "button", name: "Reset to Defaults", outcome: { urlAfter: "https://joblander.app/settings", navigated: false, requests: 2, mutations: 15 } },
  ]),
  journey: { title: "Configure Settings & Insight Preferences" },
};

// Run #154, step cmtq6u8tp000o3j0nnj71pcz3. The stored observed text begins
// "Note:" — the sentence before it named our side and was cut by CHE-180.
const NEW_TAB_154: StoredStep = {
  label: "Click a ▶ Video link (YouTube session)",
  attempted: 'Click the "▶ Video" link for the Mass Consciousness session to open it on YouTube.',
  observed:
    "Note: the destination is not a defect — the YouTube video was already confirmed live and playable via the oEmbed check (HTTP 200), and the Archive page link for the same session resolves.",
  gapClass: null,
  actions: JSON.stringify([
    { kind: "click", role: "link", name: "▶ Video", outcome: { urlAfter: "https://meetbashar.com/transmissions", navigated: false, requests: 0, mutations: 0 } },
  ]),
  journey: { title: "Explore the Transmissions Archive" },
};

// A step nothing recognises.
const UNCLASSIFIED: StoredStep = {
  label: "Print the invoice",
  attempted: "Pressed the Print button on the invoice page.",
  observed: "We could not confirm this step this run.",
  gapClass: null,
  actions: null,
  journey: { title: "Billing" },
};

// ─── Prod dedup keys (IssueLink rows on the checkmyapp.dev app, 2026-09-06) ──

const PROD_KEYS: Record<Exclude<GapClass, "range_input" | "third_party_block" | "egress_unreachable">, { key: string; ticket: string }> = {
  new_tab: { key: "50f4130bdfc6e121332065e6892d9dde", ticket: "(never filed in prod — the class existed, no step ever reached it)" },
  oauth: { key: "e779e9daa0f7f7503f1b278c5e505918", ticket: "CHE-94" },
  passwordless: { key: "7d30740aec630a9e52633dec39f3a78e", ticket: "CHE-104" },
  verification_code: { key: "f3d12bda7508c94011262fe12dae34b2", ticket: "(no row yet)" },
  media_devices: { key: "b8430aa8ae1ec3275318f88b667aa9d8", ticket: "CHE-164" },
  captcha: { key: "bdcfa29fd68ba54f8456ee8978f60784", ticket: "CHE-85" },
  test_records: { key: "421f8e7cba3273ec98e3ebbb81d0c255", ticket: "CHE-96" },
  file_transfer: { key: "e9c71381208c556ca91c5f6e110bb527", ticket: "CHE-146" },
  unclassified: { key: "5745adef5df702c26f73e14ef3dd9b8c", ticket: "CHE-86" },
};

// The key the filer produces for a class, through the same function the
// ledger uses.
function keyFor(cls: GapClass): string {
  return dedupKeyForFinding(
    {
      title: GAP_CLASSES[cls].label,
      category: "broken",
      severity: "high",
      detail: JSON.stringify({ where: "CheckMyApp agent capability" }),
    },
    { appSlug: "checkmyapp.dev" },
  );
}

// ─── Stubs ───────────────────────────────────────────────────────────────────

interface Filed {
  kind: "created" | "commented";
  identifier: string;
  title?: string;
  dedupKey?: string;
  body?: string;
}

function stubWorld(
  steps: StoredStep[],
  opts: {
    existing?: Record<string, string>;
    extensionAudit?: boolean;
    unpricedJourneys?: string[];
    unfunnelledJourneys?: string[];
    targetUrl?: string;
  } = {},
) {
  const filed: Filed[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const links = new Map<string, { id: string; externalIssueId: string; status: string; occurrences: number; escalatedAt: null; defectClass: null }>();
  for (const [key, identifier] of Object.entries(opts.existing ?? {})) {
    links.set(key, { id: `link-${identifier}`, externalIssueId: identifier, status: "open", occurrences: 1, escalatedAt: null, defectClass: null });
  }
  let counter = 200;

  const tracker: Tracker = {
    async createIssue(draft: TicketDraft): Promise<CreatedIssue> {
      const identifier = `CHE-${++counter}`;
      filed.push({ kind: "created", identifier, title: draft.title, body: draft.description });
      return { id: identifier, identifier, url: `https://linear.app/x/${identifier}` };
    },
    async addComment(issueId: string, body: string) {
      comments.push({ issueId, body });
    },
    async getIssueOutcome(): Promise<IssueOutcome> {
      return "open";
    },
  };

  const run = {
    targetKind: opts.extensionAudit ? "extension" : "website",
    id: "run-1",
    runNumber: 153,
    publicId: "pub-1",
    startedAt: new Date("2026-09-06T16:45:42Z"),
    appSlug: "joblander.app",
    targetUrl: opts.targetUrl ?? "https://joblander.app",
    appId: "app-customer",
  };

  const db = {
    run: { findUnique: async () => run },
    step: { findMany: async () => steps },
    // CHE-235 (price) and CHE-238 (funnel): journeys this run walked whose
    // catalog row is missing one of them. The where-shape is asserted here, not
    // just the result — a filter that stopped excluding carried journeys would
    // file gaps for walks that never happened.
    //
    // Both queries come through this one stub, so it dispatches on the catalog
    // clause rather than assuming a single caller: a second reader arriving and
    // silently receiving the first one's rows is how a stub starts lying.
    journey: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const common =
          where.carriedFromRunId === null &&
          JSON.stringify(where.appJourneyId) === JSON.stringify({ not: null });
        const appJourney = JSON.stringify(where.appJourney);
        if (common && appJourney === JSON.stringify({ price: null })) {
          return (opts.unpricedJourneys ?? []).map((title) => ({ title }));
        }
        if (common && appJourney === JSON.stringify({ funnelStages: null, funnelRefusal: { not: null } })) {
          return (opts.unfunnelledJourneys ?? []).map((title) => ({
            title,
            appJourney: { funnelRefusal: "revisits" },
          }));
        }
        throw new Error(`journey query lost its filter: ${JSON.stringify(where)}`);
      },
    },
    createdResource: { findMany: async () => [], count: async () => 0 },
    issueLink: {
      findUnique: async ({ where }: { where: { appId_dedupKey: { dedupKey: string } } }) =>
        links.get(where.appId_dedupKey.dedupKey) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { occurrences: { increment: number } } }) => {
        const link = [...links.values()].find((l) => l.id === where.id);
        if (!link) throw new Error(`update of unknown link ${where.id}`);
        link.occurrences += data.occurrences.increment;
        filed.push({ kind: "commented", identifier: link.externalIssueId });
        return link;
      },
      upsert: async ({ where, create }: { where: { appId_dedupKey: { dedupKey: string } }; create: { externalIssueId: string } }) => {
        const key = where.appId_dedupKey.dedupKey;
        const last = filed[filed.length - 1];
        if (last?.kind === "created" && last.identifier === create.externalIssueId) last.dedupKey = key;
        const link = { id: `link-${create.externalIssueId}`, externalIssueId: create.externalIssueId, status: "open", occurrences: 1, escalatedAt: null, defectClass: null };
        links.set(key, link);
        return link;
      },
    },
    settledSignature: { findFirst: async () => null, create: async () => ({}) },
    // CHE-256: filing resolves the app's team, because a settlement is the
    // team's knowledge and must be stored with one.
    app: { findUnique: async () => ({ teamId: "team_fixture" }) },
  };

  const self = {
    id: "app-self",
    appSlug: "checkmyapp.dev",
    ownerId: "owner-self",
    policy: null,
    tracker: { teamId: "team" },
  };
  const board = { self, tracker, baseUrl: "https://checkmyapp.dev" } as unknown as GapBoard;
  const env = { db: db as unknown as PrismaClient, bindings: { EVIDENCE: { head: async () => opts.extensionAudit ? { key: "private/runs/run-1/checker-gaps.json" } : null } } } as unknown as AgentEnv;
  return { env, board, filed, comments };
}

async function main() {
  // 0 — the root cause, reproduced: the words the classifier keys on are the
  // words CHE-180 cuts before the row is written. A step reported with the
  // model's sentence classifies on that sentence; the stored copy no longer
  // has it.
  {
    const reported: ReportedStep = {
      label: NEW_TAB_154.label,
      status: "skipped",
      unverifiedReason: "our_capability",
      attempted: NEW_TAB_154.attempted ?? "",
      observed: `The link opens in a new tab, which our browser cannot follow. ${NEW_TAB_154.observed}`,
    };
    const raw = gapEvidenceText(reported.label, reported.attempted, reported.observed);
    productizeStep(reported);
    check(
      "root cause: productizeStep cuts the sentence naming the new tab",
      !/new tab/i.test(reported.observed) && reported.observed.startsWith("Note:"),
      reported.observed,
    );
    check("…and the model's own words classify as new_tab", classifyGap({ text: raw }) === "new_tab");
  }

  // 1 — #153 slider and #154 new-tab through the real filing path: two
  // tickets, two dedup keys, two capability-named titles, neither CHE-86's.
  {
    const w = stubWorld([SLIDER_153, NEW_TAB_154]);
    const notes = await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    const created = w.filed.filter((f) => f.kind === "created");
    check("#153 + #154: two tickets created", created.length === 2, notes.map((n) => n.text).join(" | "));
    const titles = created.map((f) => f.title ?? "");
    check(
      "#153: title names the range input",
      titles.some((t) => t.startsWith("[Checker gap]") && t.endsWith(GAP_CLASSES.range_input.label)),
      titles.join(" | "),
    );
    check(
      "#154: title names the new tab",
      titles.some((t) => t.startsWith("[Checker gap]") && t.endsWith(GAP_CLASSES.new_tab.label)),
      titles.join(" | "),
    );
    const keys = created.map((f) => f.dedupKey ?? "");
    check("two distinct dedup keys", keys[0] !== keys[1] && keys.every(Boolean), keys.join(", "));
    check("neither key is CHE-86's", !keys.includes(PROD_KEYS.unclassified.key));
    check("the new-tab key is the one the class always had", keys.includes(PROD_KEYS.new_tab.key));
    check("the range-input key is the class's own", keys.includes(keyFor("range_input")));
    check("no comment landed on CHE-86", w.comments.length === 0);
  }

  // 2 — a class recorded on the row wins over re-classification.
  {
    const w = stubWorld([{ ...SLIDER_153, gapClass: "oauth" }]);
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    check(
      "Step.gapClass on the row is used as written",
      w.filed[0]?.title?.endsWith(GAP_CLASSES.oauth.label) === true,
      w.filed[0]?.title,
    );
  }

  // 3 — an unclassified step still files, on CHE-86's key; on recurrence the
  // step text goes on the ticket.
  {
    const w = stubWorld([UNCLASSIFIED]);
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    check("unclassified step files", w.filed.length === 1 && w.filed[0].kind === "created");
    check("…on the unclassified key (CHE-86)", w.filed[0]?.dedupKey === PROD_KEYS.unclassified.key, w.filed[0]?.dedupKey);

    const again = stubWorld([UNCLASSIFIED], { existing: { [PROD_KEYS.unclassified.key]: "CHE-86" } });
    await fileCapabilityGaps(again.env, "run-1", { board: again.board });
    check("unclassified recurrence comments on CHE-86", again.filed[0]?.kind === "commented" && again.filed[0].identifier === "CHE-86");
    const withStep = again.comments.find((c) => c.issueId === "CHE-86" && c.body.includes(UNCLASSIFIED.label));
    check("…and the comment carries the step text", Boolean(withStep), again.comments.map((c) => c.body).join(" || "));
  }

  {
    const privateStep = { ...UNCLASSIFIED, label: "PRIVATE_RESUME_CONTEXT", observed: "PRIVATE_DIALOGUE_CONTEXT" };
    const w = stubWorld([privateStep], { extensionAudit: true });
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    check("extension checker gap: ticket points to the retained private observations", w.filed[0]?.body?.includes("private/runs/run-1/checker-gaps.json") === true);
    check("extension checker gap: resume/dialogue stays out of the ticket", !JSON.stringify(w.filed).includes("PRIVATE_"));
    const again = stubWorld([privateStep], { extensionAudit: true, existing: { [PROD_KEYS.unclassified.key]: "CHE-86" } });
    await fileCapabilityGaps(again.env, "run-1", { board: again.board });
    check("extension checker gap: recurrence retains the current audit reference", again.comments.some(c => c.body.includes("private/runs/run-1/checker-gaps.json")));
    check("extension checker gap: recurrence does not copy private content", !JSON.stringify(again.comments).includes("PRIVATE_"));
  }

  // 4 — the existing classes keep their prod dedup keys, and their inputs
  // still map to them.
  {
    for (const [cls, { key, ticket }] of Object.entries(PROD_KEYS) as [keyof typeof PROD_KEYS, { key: string; ticket: string }][]) {
      check(`dedup key unchanged: ${cls} ${ticket}`, keyFor(cls) === key, keyFor(cls));
    }
    const samples: [string, GapClass][] = [
      ["Link opens in a new tab which could not be followed", "new_tab"],
      ["Sign in with Google via OAuth popup", "oauth"],
      ["Magic link sign-in required; passwordless flow", "passwordless"],
      ["A verification code was emailed; MFA required", "verification_code"],
      ["Camera and microphone prompt for the call", "media_devices"],
      ["Signup shows a reCAPTCHA challenge", "captcha"],
      ["Records still present: note \"cma-1\"", "test_records"],
      ["The file upload picker did not accept a file", "file_transfer"],
    ];
    for (const [text, cls] of samples) {
      check(`existing class still matched: ${cls}`, classifyGap({ text }) === cls, classifyGap({ text }));
    }
    // The order among the original classes is unchanged: new-tab wins over
    // oauth as before when a text says both.
    check("original order kept (new_tab before oauth)", classifyGap({ text: "OAuth opens in a new tab" }) === "new_tab");
  }

  // 5 — the new classes: the machine trail decides when the words say
  // nothing, third-party and egress are told apart by host and phrase.
  {
    const trail = (a: RecordedAction[]) => a;
    check(
      "trail: link click with no navigation, no request, no mutation → new_tab",
      classifyGap({ text: "Clicked the link.", actions: trail(JSON.parse(NEW_TAB_154.actions ?? "[]")) }) === "new_tab",
    );
    check(
      "trail: a click on a slider role → range_input",
      classifyGap({ text: "Set the value.", actions: trail(JSON.parse(SLIDER_153.actions ?? "[]")) }) === "range_input",
    );
    check(
      "trail: a fill into input[type=range] → range_input",
      classifyGap({ text: "Set the value.", actions: [{ kind: "fill", selector: "input[type=range]", value: "5", outcome: { urlAfter: "x" } }] }) === "range_input",
    );
    check(
      "trail: a link click that navigated is not a new tab",
      classifyGap({ text: "Clicked the link.", actions: [{ kind: "click", role: "link", name: "Docs", outcome: { urlAfter: "x", navigated: true, requests: 3, mutations: 9 } }] }) === "unclassified",
    );
    check("words: drag-and-drop is not the range class", classifyGap({ text: "Drag-and-drop the file onto the area" }) !== "range_input");

    // CHE-86's own body, run #96: the Cloudflare challenge on hugedomains.com
    // while the target was your-app.com.
    const hugedomains =
      "Could not access the domain profile page due to Cloudflare security verification blocking automated access (HTTP 403). The actual domain profile content on hugedomains.com was never loaded.";
    check(
      "CHE-86's hugedomains steps → third_party_block (foreign host)",
      classifyGap({ text: hugedomains, targetOrigin: "https://your-app.com" }) === "third_party_block",
      classifyGap({ text: hugedomains, targetOrigin: "https://your-app.com" }),
    );
    check(
      "the same challenge on the target itself → captcha",
      classifyGap({ text: hugedomains, targetOrigin: "https://hugedomains.com" }) === "captcha",
    );
    check(
      "no target known → captcha, never a third party by guess",
      classifyGap({ text: hugedomains }) === "captcha",
    );
    check(
      "verify_links' UNREACHABLE (HTTP 403 from vk.com) → third_party_block",
      classifyGap({ text: "UNREACHABLE (HTTP 403 from vk.com) https://vk.com/share.php", targetOrigin: "https://theins.ru" }) === "third_party_block",
    );
    // PR #60 review: a 429 is our own request volume (CLAUDE.md rule 3), not
    // the host's door — it must not be filed as a third-party block.
    check(
      "verify_links' UNREACHABLE (HTTP 429 from vk.com) → egress_unreachable, not third_party_block",
      classifyGap({ text: "UNREACHABLE (HTTP 429 from vk.com) https://vk.com/share.php", targetOrigin: "https://theins.ru" }) === "egress_unreachable",
      classifyGap({ text: "UNREACHABLE (HTTP 429 from vk.com) https://vk.com/share.php", targetOrigin: "https://theins.ru" }),
    );
    check(
      "a bare 403 from a foreign host (no UNREACHABLE word) → third_party_block",
      classifyGap({ text: "The share dialog never opened; hugedomains.com answered HTTP 403.", targetOrigin: "https://your-app.com" }) === "third_party_block",
    );
    check(
      "a 503 from a foreign host → third_party_block",
      classifyGap({ text: "UNREACHABLE (HTTP 503 from t.me) https://t.me/share", targetOrigin: "https://theins.ru" }) === "third_party_block",
    );
    check(
      "coerceUnreachable's surviving sentence → egress_unreachable",
      classifyGap({ text: "The share button did nothing visible. Could not confirm vk.com this run.", targetOrigin: "https://theins.ru" }) === "egress_unreachable",
    );
    check(
      "UNREACHABLE (timeout) → egress_unreachable",
      classifyGap({ text: "UNREACHABLE (timeout) https://t.me/share", targetOrigin: "https://theins.ru" }) === "egress_unreachable",
    );
    check("the three new labels are distinct from every old one", new Set(Object.values(GAP_CLASSES).map((c) => c.label)).size === Object.keys(GAP_CLASSES).length);
    for (const cls of ["range_input", "third_party_block", "egress_unreachable"] as const) {
      check(`new class ${cls} has its own key`, !Object.values(PROD_KEYS).some((p) => p.key === keyFor(cls)), keyFor(cls));
    }
  }

  // 6 — a run with several gaps of one class files one ticket; a mix files
  // one per class, and a legacy row without gapClass is classified from what
  // it has.
  {
    const w = stubWorld([SLIDER_153, { ...SLIDER_153, label: "Move the opacity slider again" }, NEW_TAB_154, UNCLASSIFIED]);
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    const created = w.filed.filter((f) => f.kind === "created");
    check("four gaps in three classes → three tickets", created.length === 3, created.map((f) => f.title).join(" | "));
  }

  // 7 — CHE-235: a journey we walked and left unpriced is our gap, not a
  // silence. Run #192 walked four journeys of checkmyapp.dev, priced every one
  // of them at 0 actions / 0% conversion with the note "not tracked", and
  // nothing anywhere said we had failed to deliver a judgement.
  {
    const w = stubWorld([], { unpricedJourneys: ["Run a free first-app check", "Sign up via the free pricing CTA"] });
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    const created = w.filed.filter((f) => f.kind === "created");
    check(
      "a walked journey with no price files one ticket on our board",
      created.length === 1 && created[0].title.includes(GAP_CLASSES.unpriced_journey.label),
      created.map((f) => f.title).join(" | "),
    );
    check(
      "…and it names the journeys, so the next reader sees which ones",
      (created[0]?.body ?? "").includes("Run a free first-app check"),
      (created[0]?.body ?? "").slice(0, 160),
    );
  }

  // …and a run whose journeys are all priced files nothing.
  {
    const w = stubWorld([]);
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    check("every journey priced → no ticket", w.filed.length === 0, w.filed.map((f) => f.title).join(" | "));
  }

  // CHE-238: a journey we walked and could not turn into a funnel is OUR gap.
  // The customer is never told "we could not measure this" — it is a ticket on
  // our board, like every other thing we cannot yet do (rule 2).
  {
    const w = stubWorld([], { unfunnelledJourneys: ["Explore the app in different languages (i18n)"] });
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    const created = w.filed.filter((f) => f.kind === "created");
    check(
      "a walked journey with no funnel files one ticket on our board",
      created.length === 1 && created[0].title.includes(GAP_CLASSES.unfunnelled_journey.label),
      created.map((f) => f.title).join(" | "),
    );
    check(
      "…and it names the journey and why we refused",
      (created[0]?.body ?? "").includes("different languages") && (created[0]?.body ?? "").includes("revisits"),
      (created[0]?.body ?? "").slice(0, 200),
    );
    // Rule 1: our machinery must not be described to a customer. This ticket is
    // ours, but the words in it get reused, so the gap sentence must talk about
    // what we could not do rather than about the customer's product.
    check(
      "the gap's 'why' blames our derivation, not the customer's product",
      /our wandering|our browsing|we walked|could not/i.test(GAP_CLASSES.unfunnelled_journey.why),
      GAP_CLASSES.unfunnelled_journey.why.slice(0, 120),
    );
  }

  // A journey that HAS a funnel and merely wandered today is not a gap: the
  // funnel it is measured along still stands.
  {
    const w = stubWorld([], { unfunnelledJourneys: [] });
    await fileCapabilityGaps(w.env, "run-1", { board: w.board });
    check("every walked journey has a funnel → no ticket", w.filed.length === 0, w.filed.map((f) => f.title).join(" | "));
  }

  // 8 — CHE-374: the Shopify admin is one capability, filed on CHE-333, and it
  // is decided by where the walk was, never by what a step says. Run #283's
  // step (prod D1, step cmuptq3f7001ez90n9413w9zo, byte for byte, gapClass
  // included) was classified third_party_block and counted on CHE-309; its 403
  // came from a server-side link check, so no trail shows a landing and it
  // keeps that class — a known limit, stated in gap-classes.ts.
  {
    const SHOPIFY_283: StoredStep = {
      label: 'Follow the "Log in here" link on the gate',
      attempted:
        'Checked the gate\'s only link, "Log in here" (/admin), which leads to the Shopify admin sign-in for the store owner.',
      observed:
        "The link resolves to the Shopify admin host (admin.shopify.com), which answers HTTP 403 to an automated check, so the destination could not be confirmed this run. It is the merchant sign-in, not a shopper-facing page; without owner credentials nothing behind it was inspected.",
      gapClass: "third_party_block",
      actions: null,
      journey: { title: "Explore storefront (blocked by password gate)" },
    };
    // Words never decide this class: the run's target and the machine trail
    // do. S = a store's storefront, SA = a store's admin as the target, J/A =
    // products that are not stores.
    const S = "https://securify-demo.myshopify.com";
    const SA = "https://securify-demo.myshopify.com/admin";
    const J = "https://joblander.app";
    const A = "https://acme.app";
    const sliderTrail: RecordedAction[] = JSON.parse(SLIDER_153.actions ?? "[]");
    const silentLink: RecordedAction[] = JSON.parse(NEW_TAB_154.actions ?? "[]");
    const nav = (url: string, urlAfter = url, status: number | null = 200): RecordedAction => ({ kind: "navigate", url, outcome: { urlAfter, status } });
    const landedBy = (urlAfter: string): RecordedAction => ({
      kind: "click",
      role: "link",
      name: "Log in here",
      outcome: { urlAfter, navigated: true, requests: 4, mutations: 30 },
    });
    const fileChooser = (urlAfter: string): RecordedAction => ({
      kind: "click",
      selector: 'input[type="file"]',
      outcome: { urlAfter, navigated: false, requests: 1, mutations: 2 },
    });
    const adminStore = "https://admin.shopify.com/store/securify-demo";
    const said403 = "admin.shopify.com answered HTTP 403.";
    const cases: [string, GapEvidence, GapClass][] = [
      // (a) Landed at the admin and stopped there: the admin, whatever the words.
      ["(a) landed on admin.shopify.com, label 'Import products from CSV', file-upload words", { text: `Import products from CSV · the file upload never appeared: ${said403}`, targetOrigin: S, actions: [landedBy(adminStore)] }, "shopify_admin"],
      ["landed, with OAuth / CAPTCHA / new-tab words", { text: "We could not follow the link; the OAuth sign-in shows a reCAPTCHA and opens in a new tab.", targetOrigin: S, actions: [landedBy(adminStore)] }, "shopify_admin"],
      ["landed on accounts.shopify.com (the store owner's sign-in)", { text: "The login page did not accept us.", targetOrigin: S, actions: [landedBy("https://accounts.shopify.com/lookup?rid=abc")] }, "shopify_admin"],
      ["navigated to the store's /admin, redirected to accounts.shopify.com", { text: "The page did not load.", targetOrigin: S, actions: [nav(`${S}/admin`, "https://accounts.shopify.com/lookup?rid=abc")] }, "shopify_admin"],
      ["navigated to the store's /admin, which redirected off Shopify (the requested URL counts)", { text: "The page did not load.", targetOrigin: S, actions: [nav(`${S}/admin`, "https://securify.example/login")] }, "shopify_admin"],
      ["navigated to the store's /admin/apps, 403", { text: "The page did not load.", targetOrigin: S, actions: [nav(`${S}/admin/apps/securify`, `${S}/admin/apps/securify`, 403)] }, "shopify_admin"],
      ["landed on 'admin.shopify.com.' (trailing dot, same host)", { text: "The page did not load.", targetOrigin: S, actions: [landedBy("https://admin.shopify.com./store/securify-demo")] }, "shopify_admin"],
      ["landed on an upper-case admin URL", { text: "The page did not load.", targetOrigin: S, actions: [landedBy("HTTPS://ADMIN.SHOPIFY.COM/store/securify-demo")] }, "shopify_admin"],
      ["navigated to an upper-case /ADMIN on the store", { text: "The page did not load.", targetOrigin: S, actions: [nav(`${S}/ADMIN`, `${S}/ADMIN`, 403)] }, "shopify_admin"],
      ["the target is the store's /admin, no trail", { text: "The orders page did not load.", targetOrigin: S, targetUrl: SA }, "shopify_admin"],
      ["the target is admin.shopify.com, no trail", { text: "The orders page did not load.", targetOrigin: "https://admin.shopify.com" }, "shopify_admin"],

      // (b) At the admin, a mechanism the trail shows was exercised is its own.
      ["(b) landed, and a file input was clicked → file_transfer", { text: said403, targetOrigin: S, actions: [landedBy(adminStore), fileChooser(`${adminStore}/products/import`)] }, "file_transfer"],
      ["landed, and a file input was filled → file_transfer", { text: said403, targetOrigin: S, actions: [landedBy(adminStore), { kind: "fill", selector: "input[type=file]", value: "products.csv", outcome: { urlAfter: adminStore } }] }, "file_transfer"],
      ["landed, and a slider was driven → range_input", { text: said403, targetOrigin: S, actions: [landedBy(adminStore), ...sliderTrail] }, "range_input"],
      ["landed, and a link opened a new tab → new_tab", { text: said403, targetOrigin: S, actions: [landedBy(adminStore), ...silentLink] }, "new_tab"],
      ["the admin as target, and a slider was driven → range_input", { text: "The discount could not be set.", targetOrigin: S, targetUrl: SA, actions: sliderTrail }, "range_input"],

      // (d) A "Connect Shopify" OAuth hop from another product is the admin sign-in.
      ["(d) Connect Shopify landed on admin.shopify.com/oauth/authorize", { text: "Connect Shopify: the OAuth sign-in could not be completed.", targetOrigin: A, actions: [landedBy("https://admin.shopify.com/oauth/authorize?client_id=x")] }, "shopify_admin"],
      ["Connect Shopify landed on <store>/admin/oauth/authorize", { text: "Connect Shopify: the OAuth sign-in could not be completed.", targetOrigin: A, actions: [landedBy(`${S}/admin/oauth/authorize?client_id=x`)] }, "shopify_admin"],
      ["Connect Shopify landed on admin.shopify.com/store/x/oauth/authorize", { text: "Connect Shopify: the OAuth sign-in could not be completed.", targetOrigin: A, actions: [landedBy(`${adminStore}/oauth/authorize?client_id=x`)] }, "shopify_admin"],

      // (c) No trail landing: words about the admin change nothing — the class
      // the rules gave before this change.
      ["(c) run #283's words on its storefront target, no trail (known limit)", { text: gapEvidenceText(SHOPIFY_283.observed, SHOPIFY_283.attempted, SHOPIFY_283.label), targetOrigin: S, targetUrl: `${S}/` }, "third_party_block"],
      ["UNREACHABLE (HTTP 403 from admin.shopify.com) on J", { text: "UNREACHABLE (HTTP 403 from admin.shopify.com) https://admin.shopify.com/store/x", targetOrigin: J }, "third_party_block"],
      ["admin.shopify.com timed out on J", { text: "UNREACHABLE (timeout) https://admin.shopify.com/store/x", targetOrigin: J }, "egress_unreachable"],
      ["a reCAPTCHA on a page that syncs to the Shopify admin", { text: "The signup page, which syncs orders to the Shopify admin, shows a reCAPTCHA.", targetOrigin: A }, "captcha"],
      ["a markdown link to the admin", { text: "[Open the admin](https://admin.shopify.com/store/x) did nothing.", targetOrigin: J }, "unclassified"],
      ["a JSON href to the admin", { text: '{"href":"https://admin.shopify.com/store/x"} did nothing.', targetOrigin: J }, "unclassified"],
      ["'not inside the Shopify admin', on a store", { text: "The app is not inside the Shopify admin; nothing loaded.", targetOrigin: S }, "unclassified"],
      ["'embedded Shopify app', on a store", { text: "The embedded Shopify app could not be opened from here.", targetOrigin: S }, "unclassified"],
      ["Google sign-in words on a store, no trail", { text: "The store owner login on accounts.shopify.com offers Continue with Google.", targetOrigin: S }, "oauth"],
      ["'footprint' is not an OTP", { text: "The footprint chart did not load.", targetOrigin: A }, "unclassified"],
      ["the file-transfer words are back to what they were", { text: "Uploading the products CSV: Import did nothing.", targetOrigin: J }, "unclassified"],

      // Trail URLs that only look like the admin.
      ...(
        [
          "https://admin.shopify.com.1337.io/",
          "https://accounts.shopify.com.0x.io/",
          "https://admin.shopify.com@evil.io/login",
          "https://evil.io/go?next=admin.shopify.com",
          "https://evil.io/admin.shopify.com",
          "https://evil.io/x.myshopify.com/admin",
          "https://admin.shopify.comé.io/",
          "https://admin.shopify.com.​evil.io/",
          "https://shop.admin.shopify.com/",
          "https://fakeaccounts.shopify.com/",
          "https://x.myshopify.com/administrator",
          "https://x.myshopify.com/admin-tools",
          "https://myshopify.com/admin",
          "https://securify-demo.myshopify.com/products/x",
          "not a url",
        ] as const
      ).map((url): [string, GapEvidence, GapClass] => [`look-alike landing ${JSON.stringify(url)}`, { text: "The page did not load.", targetOrigin: J, actions: [landedBy(url)] }, "unclassified"]),
      ["a look-alike target: x.myshopify.com/administrator", { text: "The page did not load.", targetOrigin: J, targetUrl: "https://x.myshopify.com/administrator" }, "unclassified"],
      ["a look-alike target: admin.shopify.com.1337.io", { text: "The page did not load.", targetOrigin: "https://admin.shopify.com.1337.io" }, "unclassified"],
      ["the storefront as target is not the admin", { text: "The page did not load.", targetOrigin: S, targetUrl: `${S}/` }, "unclassified"],

      // The neighbours stay where they were.
      ["unchanged: Google sign-in on the product → oauth", { text: "Sign in with Google via OAuth popup", targetOrigin: J }, "oauth"],
      ["unchanged: Cloudflare challenge on hugedomains.com", { text: "Cloudflare security verification blocking automated access (HTTP 403) on hugedomains.com", targetOrigin: "https://your-app.com" }, "third_party_block"],
    ];
    for (const [name, evidence, expected] of cases) {
      const got = classifyGap(evidence);
      check(`${expected}: ${name}`, got === expected, got);
    }
    check("the third-party key is CHE-309's, the ticket #283 landed on", keyFor("third_party_block") === "48076e4280e98ec6be313a3f0680b8e7", keyFor("third_party_block"));

    // The seed's key is pinned like every prod key above: a label that drifts
    // detaches CHE-333 from its row.
    const seedKey = shopifyAdminDedupKey();
    check("the shopify_admin key is the seeded one", seedKey === "44180f6e9c56bab68cd7084eb555927a", seedKey);
    check("the class key is its own", !Object.values(PROD_KEYS).some((p) => p.key === seedKey) && seedKey !== keyFor("third_party_block"));

    // (e) Run #283's row as stored keeps the class it was given then: filing
    // reads the class and never re-guesses it, so history stays on CHE-309.
    const stored = stubWorld([SHOPIFY_283], { targetUrl: S });
    await fileCapabilityGaps(stored.env, "run-1", { board: stored.board });
    check("(e) the stored #283 row files where it always did (CHE-309's key)", stored.filed[0]?.dedupKey === keyFor("third_party_block"), stored.filed[0]?.dedupKey);

    // The same gate met by a click that landed on the admin: reported after
    // this change it carries shopify_admin, and the real filer keys it on the
    // seeded key.
    const LANDED: StoredStep = {
      ...SHOPIFY_283,
      gapClass: null,
      label: 'Click "Log in here" on the password page',
      actions: JSON.stringify([landedBy(adminStore)]),
    };
    const reportedNow = (s: StoredStep): StoredStep => ({
      ...s,
      gapClass: classifyGap({
        text: gapEvidenceText(s.label, s.attempted, s.observed),
        actions: JSON.parse(s.actions ?? "[]"),
        targetOrigin: S,
      }),
    });
    check("a landed step reported now is shopify_admin", reportedNow(LANDED).gapClass === "shopify_admin", reportedNow(LANDED).gapClass ?? "");
    const fresh = stubWorld([reportedNow(LANDED)], { targetUrl: S });
    await fileCapabilityGaps(fresh.env, "run-1", { board: fresh.board });
    check(
      "the filer keys the class on the seeded key",
      fresh.filed[0]?.kind === "created" && fresh.filed[0].dedupKey === seedKey,
      `${fresh.filed[0]?.dedupKey} vs ${seedKey}`,
    );

    // A legacy row on a run whose target is the store's admin: the filer
    // classifies it from the run's target URL alone.
    const onAdmin = stubWorld([{ ...SHOPIFY_283, gapClass: null, actions: null, label: "Open orders", observed: "The orders page did not load." }], { targetUrl: SA });
    await fileCapabilityGaps(onAdmin.env, "run-1", { board: onAdmin.board });
    check("a legacy row on an admin target files on the seeded key", onAdmin.filed[0]?.dedupKey === seedKey, onAdmin.filed[0]?.dedupKey);

    // Report time is where the class is decided (execution.ts), and it must
    // hand the classifier the trail and the full target URL — the origin
    // alone drops a store's /admin. A source pin: that call is inside the
    // walk and runs only against a live browser.
    const execution = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agent", "execution.ts"), "utf8");
    check(
      "report time passes actions: actionTrail and targetUrl: run.targetUrl to classifyGap",
      /classifyGap\(\{[^}]*actions:\s*actionTrail,[^}]*targetUrl:\s*run\.targetUrl,/.test(execution),
    );

    // With the seeded row in place, a Shopify-admin run counts on CHE-333 and
    // opens nothing — a reported row, and a legacy row without a class that
    // the filer classifies from its stored trail.
    const legacy: StoredStep = {
      ...SHOPIFY_283,
      gapClass: null,
      label: "Sign in to the Shopify admin",
      observed: "Continue with Google was offered; the sign-in could not be completed.",
      actions: JSON.stringify([nav(`${S}/admin`, "https://accounts.shopify.com/lookup?rid=abc")]),
    };
    const seeded = stubWorld([reportedNow(LANDED), legacy], { existing: { [seedKey]: CHE_333.identifier }, targetUrl: S });
    await fileCapabilityGaps(seeded.env, "run-1", { board: seeded.board });
    check(
      "with the seed, every Shopify-admin gap comments on CHE-333 and creates nothing",
      seeded.filed.length === 1 && seeded.filed[0].kind === "commented" && seeded.filed[0].identifier === CHE_333.identifier,
      JSON.stringify(seeded.filed),
    );

    // The seed statement itself, run against the real schema in SQLite. CHE-329
    // fixture: a NEWER checkmyapp.dev row (another account saved our URL) that
    // holds someone else's tracker — the seed must pick ours, by our board.
    const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
    const schemaDb = () => {
      const d = new DatabaseSync(":memory:");
      for (const f of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) d.exec(readFileSync(path.join(migrations, f), "utf8"));
      d.exec(`INSERT INTO User (id, clerkUserId, email, updatedAt) VALUES ('u1','c1','o@x.dev','x'), ('u2','c2','s@x.dev','x');`);
      return d;
    };
    const seedRun = (d: DatabaseSync): { changes: number; error?: string } => {
      try {
        return { changes: Number(d.prepare(seedSql()).run().changes) };
      } catch (err) {
        return { changes: -1, error: err instanceof Error ? err.message : String(err) };
      }
    };

    const empty = schemaDb();
    const none = seedRun(empty);
    check("seed: without our app it writes nothing and does not fail", none.changes === 0 && !none.error, JSON.stringify(none));
    empty.close();

    const db = schemaDb();
    db.exec(`INSERT INTO App (id, ownerId, targetUrl, appSlug, updatedAt, createdAt) VALUES
        ('app-ours','u1','https://checkmyapp.dev','checkmyapp.dev','x','2026-07-25T13:06:19.499+00:00'),
        ('app-newer','u2','https://checkmyapp.dev','checkmyapp.dev','x','2026-09-28T00:00:00.000+00:00');
      INSERT INTO TrackerIntegration (id, appId, accessTokenEnc, teamId, updatedAt) VALUES
        ('t1','app-ours','x','b9503451-107e-41b6-a933-5959324a72af','x'),
        ('t2','app-newer','x','someone-elses-linear-team','x');`);
    const first = seedRun(db);
    const afterFirst = db.prepare(readBackSql()).all() as unknown as LinkRow[];
    const written = db.prepare("SELECT appId, createdAt, lastSeenAt, updatedAt FROM IssueLink").all() as unknown as {
      appId: string;
      createdAt: string;
      lastSeenAt: string;
      updatedAt: string;
    }[];
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM IssueLink").all());
    const second = seedRun(db);
    check("seed: the first run writes one row", first.changes === 1, JSON.stringify(first));
    check("seed: the row is on our app, not the newer row with another team's tracker", written.length === 1 && written[0].appId === "app-ours", JSON.stringify(written));
    check(
      "seed: on our app, open, CHE-333, under the pinned key",
      afterFirst.length === 1 && afterFirst[0].appId === "app-ours" && seedProblem(afterFirst[0]) === null && afterFirst[0].dedupKey === seedKey,
      JSON.stringify(afterFirst),
    );
    const prismaTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
    check(
      "seed: timestamps in the shape Prisma writes on D1",
      written.length === 1 && [written[0].createdAt, written[0].lastSeenAt, written[0].updatedAt].every((t) => prismaTime.test(t)),
      JSON.stringify(written[0]),
    );
    check("seed: a second run changes nothing", second.changes === 0 && JSON.stringify(db.prepare("SELECT * FROM IssueLink").all()) === snapshot, JSON.stringify(second));
    db.exec("DELETE FROM IssueLink");
    db.exec(`INSERT INTO IssueLink (id, appId, dedupKey, externalIssueId, updatedAt) VALUES ('cuid-x','app-ours','${seedKey}','CHE-400','x')`);
    const taken = seedRun(db);
    const takenRow = (db.prepare(readBackSql()).all() as unknown as LinkRow[])[0];
    check("seed: a key held by another ticket is not overwritten", taken.changes === 0 && takenRow?.externalIssueId === "CHE-400", JSON.stringify(takenRow));
    check("seed: …and the script reports it instead of claiming success", seedProblem(takenRow) !== null);
    check("seed: a link that is not open is reported", seedProblem({ ...afterFirst[0], status: "suppressed" }) !== null);
    db.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
