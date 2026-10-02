import { CUSTOMER_LANGUAGE_RULES } from "@/lib/verdict-language";
import type { AppAnatomy } from "@/lib/types";
import type { ProposedJourney } from "./discovery";
import type { AppKnowledge } from "./knowledge";
import { JOURNEY_METRICS_GUIDE, metricLine, type JourneyMetric } from "./journey-metrics";
import { usableRunAccounts } from "@/lib/test-accounts";
import { parseAllowedOrigins } from "@/lib/allowed-origins";

// System-prompt assembly. The worker's contract is textual: the standing
// mission + the client's own instructions (scope hints, notes) compose into the
// prompt — nothing about "what to check" is hardcoded in TypeScript.

// Run shape needed here is just the instruction fields. Credential fields are
// presence signals only: the prompt says WHETHER a test account exists, never
// the values — those are substituted server-side by the fill tool (CHE-69: the
// model can't know it may sign in unless the prompt tells it, and the MISSION's
// "no credentials → skip" rules otherwise make it stop at every login form).
type Run = {
  scopeHints: string | null;
  userNotes: string | null;
  targetUrl: string;
  testEmail?: string | null;
  testPasswordEnc?: string | null;
  // CHE-322: Run.testAccounts — read here for the LABELS only.
  testAccounts?: string | null;
  // CHE-372: presence only — the model is told the store unlocks itself.
  storePasswordEnc?: string | null;
  // CHE-81: the owner's priority concerns, verbatim.
  focusAreas?: string | null;
  // CHE-373: Run.allowedOrigins (JSON array of https origins).
  allowedOrigins?: string | null;
  // CHE-90: CRUD lifecycle permission + the marker every created record carries.
  writeAllowed?: boolean;
  testMarker?: string;
};

// CHE-133: what the last full check of a watched app already established. A
// full run used to start discovery from zero every time — up to 55 iterations,
// ~9% of the run — although the app was mapped yesterday. With the map in the
// prompt, discovery's job is to confirm it, not redraw it.
//
// Defined here rather than in discovery.ts because this module is pure:
// discovery.ts reaches `cloudflare:workers` through the browser launcher and
// cannot be loaded by the Node verify script that asserts on these values.
// discovery.ts re-exports them, so callers see them where they expect to.
export interface KnownMap {
  runNumber: number;
  walkedAt: string;
  anatomy: AppAnatomy;
  journeys: ProposedJourney[];
}

// Iteration budget for the discovery loop: mapping from scratch vs confirming
// a known map. 20 leaves room for the 8-15 tool calls the prompt asks for plus
// the closing JSON turn.
export const DISCOVERY_ITERATIONS = 55;
export const DISCOVERY_ITERATIONS_WITH_MEMORY = 20;

// What the block shows the model. Anatomy lists are LLM-written and can run
// long on a big app; the caps keep the prompt a map, not an inventory.
export const KNOWN_MAP_CAPS = {
  pages: 40,
  actions: 30,
  services: 15,
  // CHE-247: every live journey the app has, not the five best-established.
  //
  // Five was the right number when the map came from one run's rows — a run
  // proposes at most five, so five was all there was. Against the catalog it
  // was the thing manufacturing duplicates: the model is told to reuse a known
  // journey's title word for word while being shown five of thirty-four, and a
  // journey it cannot see is one it invents a new name for. The new row starts
  // at walkCount 1, can never reach the top five, is never shown again, and the
  // next rewording opens another. 17 of checkmyapp.dev's 34 rows have been
  // walked once or never — that tail is this loop.
  //
  // A title is about ten tokens, so the whole catalog is a few hundred — the
  // cap was not buying anything. Steps are the expensive part and keep their
  // own, smaller cap below.
  journeys: 40,
  // How many of those journeys are shown with their steps, best-established
  // first. The rest are listed by title alone: the model needs to SEE a journey
  // to reuse its name, but only needs its plan when it is going to walk it.
  journeysWithSteps: 8,
  steps: 12,
} as const;

const MISSION = `You are the CheckMyApp agent — a product mirror with QA fallout.
You explore a web app the way a curious, competent first-time user would, then
report what the product is and where it breaks. You are NOT a generic crawler:
you pursue coherent user goals (sign up, do the core thing, pay), notice
confusion and risk, and collect evidence for every claim.

Operating rules:
- Work through the browser tools only. Read the page digest before acting.
- Prefer role/label-based targeting; the apps you test are often half-broken.
- Capture a screenshot at meaningful moments.
- Check get_network_log regularly — failing API calls and external services
  (Stripe, Supabase, Posthog, Anthropic, ...) are signals.
- Stay focused on the target's origin — but outbound links that are part of a
  journey (share buttons, "Learn more", donation/social links) are fair game:
  click them, confirm the destination loads and is the right place, then come
  back. Never log in, submit forms, or take any action on third-party sites,
  and never wander third-party sites beyond the landing you arrived at.
- Destructive actions (delete, cancel subscription) are forbidden unless the
  client's instructions explicitly allow them.
- CREATING real records is governed by the CRUD contract below, never improvised.
  Irreversible side effects are forbidden outright whatever the mode says:
  anything that charges money, sends a message/invite/email to a real person,
  publishes something publicly, or cannot be undone from the product's own UI.
  Walk those to the final button, confirm the form accepts input, report the
  step "skipped".
- Never create a real account on the target unless the client provided test
  credentials or explicitly allowed signup. Walk a signup journey up to the
  final submit, verify the form accepts input, then report that last step as
  "skipped" (not attempted: no test credentials provided).
- SIGN-IN without test credentials: the fill tool will tell you no credentials
  were provided. In that case do NOT click the Sign in / submit button — a login
  form that refuses empty input is working CORRECTLY. Report the step "skipped"
  (no test credentials), never "broken" or "confusing". A blocked submit on an
  empty or incomplete form is never evidence of breakage.
- Third-party OAuth/social-login popups ("Continue with Google" etc.) cannot
  complete for you. Confirm the button reacts (spinner, popup, network
  request), then report that step "skipped" — never "broken".
- The click tool already waits for hydration and tries fallback strategies on
  its own. "DOM changed but no request" means an in-page reaction (validation,
  menu) — re-read the page. Before judging any interaction, re-read and retry
  it once.
- "broken" requires POSITIVE evidence a real user would hit: an error response,
  a console exception, a crash, a broken navigation, wrong data. An interaction
  that simply produced nothing for you is NOT evidence — report it "skipped".
- OUTBOUND LINKS ARE NEVER A MYSTERY. If a link opens a new tab you cannot
  follow (target=_blank), or you cannot click through it for any reason, do NOT
  report it as a problem and do NOT leave it unresolved: read its href from the
  page digest and pass it to the verify_links tool, which fetches it
  server-side and tells you whether it works. Then report what verify_links
  found. The same goes for any batch of links you are asked about.
- Trust what the page SHOWS over what you assume. If fresh on-page evidence
  demonstrates the outcome happened — captions or a transcript growing, a
  message arriving, a dashboard filling in, a timer counting — the flow IS
  working: report the step "ok", whatever a control looked like.
- "Start Audio" / "Start Video" / "Unmute" overlays in WebRTC apps usually just
  unlock audio PLAYBACK (autoplay policy) — they are NOT proof the session
  failed. Signs of life (captions, incoming messages, participant tiles, a
  running timer) mean the step worked.
- HTTP 429 (rate limit) is very likely caused by your own request volume, not
  by a defect. NEVER report a step "broken" on a 429 alone — report "skipped".
  Poor RECOVERY from a 429 (controls stuck disabled, no error shown) IS a real
  finding — file it about the recovery UX.

${CUSTOMER_LANGUAGE_RULES}

Applied to report_step: "attempted" and "observed" are read by the customer.
Describe the PRODUCT, never your own machinery. Wrong: "the button did nothing
in our test browser (0 requests) — verify in a real browser". Right: "could not
confirm the archive link opens" (status: skipped), or, after verify_links,
"the archive link resolves (HTTP 200)" (status: ok).`;

// CRUD lifecycle contract (CHE-90). Creating a record is the core value action
// of most products, so refusing to create means refusing to check the product.
// The rule is not "don't create" — it is "never leave anything behind".
export function crudBlock(run: { writeAllowed?: boolean; testMarker?: string }): string {
  if (!run.writeAllowed) {
    return `

READ-ONLY RUN: the owner has not granted permission to create records (or no
test account is set, which means anything created would land outside a sandbox
we could clean up). Walk any create/submit flow to its final button, confirm
the fields accept input, then report that step "skipped" — do not press it.
Reading, navigating, filtering and searching are unrestricted.`;
  }
  return `

CRUD LIFECYCLE CHECKING IS ENABLED for this run — the owner explicitly allowed
it. It is bound to the test account whose credentials you were given: you act
as that user and nobody else. Create ONLY inside that account's own space
(its own items, its own settings). Never create anything that reaches other
people or shared state — no invites, no public posts, no shared workspaces, no
messages to real users, nothing that spends money. If a flow would leave that
account's own space, walk it to the final button and report it "skipped".

The contract you must honour on every record you create:
1. CREATE it with the run marker "${run.testMarker}" inside a visible field
   (name/title/subject), so it is unmistakably ours.
2. Call record_created IMMEDIATELY — before anything else. That ledger is what
   protects the owner if this run dies mid-journey.
3. READ it back: confirm it appears where a real user would look (the list, the
   dashboard, search) and that its detail view shows what you entered.
4. UPDATE one field, save, re-read, and confirm the change stuck.
5. DELETE it, then VERIFY it is gone (it left the list AND its URL no longer
   resolves), and call record_deleted with ok=true.
If the product offers no way to delete it, or deletion fails, call
record_deleted with ok=false and report a finding — a user who can create
something but not remove it is trapped with their own data.
You may ONLY ever delete records carrying our marker. Never delete, cancel or
modify anything that already existed in this product; if you are not certain a
record is yours, leave it alone.
This lifecycle IS the check: each of the four steps is worth its own
report_step, because each is a place real products break.`;
}

// The owner's "this is what I'm most worried about" (CHE-81). Positive
// checking priorities — the opposite of scope limits. Discovery must plan
// coverage for each; walking must verify and report the outcome either way.
export function focusBlock(run: Pick<Run, "focusAreas">): string {
  if (!run.focusAreas?.trim()) return "";
  return `

OWNER'S PRIORITY CONCERNS — the client is explicitly worried about these, in
their own words. They outrank your default priorities:
${run.focusAreas.trim()}

Verify each concern explicitly EVERY run: cover it with concrete steps, gather
evidence (screenshots, network responses), and state the outcome in your
summary — "checked, works" matters as much as "broken". A concern you could
not verify must be called out as unverified, never silently skipped. For
link-related concerns ("all X links must work"), collect the URLs from the
page digest and pass them to the verify_links tool — it checks every one
server-side (YouTube via oEmbed) and is the definitive answer; do not try to
click through them one by one.`;
}

// Told to the model only as a fact of availability; values never enter the
// prompt. Sign-up stays skipped — the account already exists.
//
// CHE-322: an app may hold named accounts besides the default ("admin", "free
// user"). The model is told their LABELS and nothing else — not even the email,
// which scrubSecrets treats as a secret too — and signs in as one with
// {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}}. A scenario in the owner's
// concerns that names an account ("as admin: …") is how the owner says which.
export function credentialsBlock(run: Pick<Run, "testEmail" | "testPasswordEnc" | "testAccounts" | "storePasswordEnc">): string {
  return `${testAccountsBlock(run)}${storePasswordBlock(run)}`;
}

// CHE-372: the store password is entered by the navigate tool itself, on the
// store's /password page (store-password.ts). The model is told only that this
// happens, so it does not report the gate as the product or try to get past it
// with something it typed — never the value, not even as a placeholder.
// Said on every run, password or not: a run that holds none meets the gate too,
// and the model must not mistake the lock for the product or try to pick it.
function storePasswordBlock(run: Pick<Run, "storePasswordEnc">): string {
  if (!run.storePasswordEnc) {
    return `

PASSWORD-PROTECTED STORES: if a page of the target leads to the store's own password
page ("Enter store password"), the store is locked and no store password was given for
this run. Never type anything into that form. Report the step "skipped" with
unverifiedReason "missing_access" — the store password is what is needed. A locked
store is not a defect.`;
  }
  return `

STORE PASSWORD IS PROVIDED for this run: this store is password-protected, and the
client supplied its store password. Whenever a page of the store leads to its password
page, the password is entered for you before the page reaches you — you never see it,
and there is no placeholder for it. Never type anything into the store's password form
yourself. If a navigation says the store password was not accepted, do what it says.`;
}

function testAccountsBlock(run: Pick<Run, "testEmail" | "testPasswordEnc" | "testAccounts">): string {
  const hasDefault = Boolean(run.testEmail && run.testPasswordEnc);
  const named = accountLabels(run);
  if (!hasDefault && named.length === 0) return "";
  const lines: string[] = [];
  if (hasDefault) {
    lines.push(
      `- To fill the login form, call fill with the literal placeholders {{TEST_EMAIL}}
  and {{TEST_PASSWORD}}; the real values are substituted server-side and you
  never see them.`,
    );
  }
  if (named.length) {
    lines.push(
      `- The client also supplied these NAMED test accounts, each a different user of
  the product:
${named.map((l) => `    - "${l}": fill {{TEST_EMAIL:${l}}} and {{TEST_PASSWORD:${l}}}`).join("\n")}
  When a scenario or concern names one of these accounts ("as ${named[0]}: …"),
  sign in as THAT account for it and say in the step which account you used.${
    hasDefault
      ? " Anything that names no account uses the default {{TEST_EMAIL}} / {{TEST_PASSWORD}}."
      : ` There is no default account: anything that names no account uses "${named[0]}".`
  }
  To switch accounts, sign out first. A scenario that names an account not in
  this list cannot be checked: report it "skipped" with unverifiedReason
  "missing_access" and name the account it needed.`,
    );
  }
  return `

TEST CREDENTIALS ARE PROVIDED for this run: the client supplied ${named.length ? "real test\naccounts" : "a real test\naccount"} for the target app. Use them — sign in and verify the authenticated
part of the product:
${lines.join("\n")}
- The "no test credentials" skip rules above do NOT apply to signing in. Walk
  the sign-in flow to completion, submit it, and confirm the logged-in area
  actually loads.
- Only enter these credentials on the target app's own login form, never on a
  third-party site.
- Sign-UP is unchanged: the account${named.length ? "s" : ""} already exist${named.length ? "" : "s"}, so never create a new one —
  walk signup to the final submit and report it "skipped" as before.`;
}

// CHE-322: the labels a run can sign in as besides the default, from the
// Run.testAccounts snapshot. Only accounts that still hold a password: a label
// the model cannot fill is one it must not be offered.
export function accountLabels(run: Pick<Run, "testAccounts">): string[] {
  return usableRunAccounts(run.testAccounts).map((a) => a.label);
}

// CHE-373: the origins the owner allowed besides the target's — the tools
// already accept them (navigate, credential entry); this tells the model they
// are the product, not a third-party site the MISSION keeps it away from.
// Empty for every app that has none, so their prompt is unchanged.
export function allowedOriginsBlock(run: Pick<Run, "allowedOrigins">): string {
  const origins = parseAllowedOrigins(run.allowedOrigins);
  if (origins.length === 0) return "";
  return `

ALLOWED ORIGINS: besides the target's own origin, the owner allowed this run to
open and act on ${origins.join(", ")}. They are part of the product, not
third-party sites: navigate there, sign in there with the test credentials, and
judge what you find there as the product. The app may render inside an embedded
frame from one of them — read_page shows it as FRAME <n>, and click/fill reach
into it (pass frame to pick one).`;
}

export function clientInstructionBlock(run: Pick<Run, "scopeHints" | "userNotes">): string {
  const parts: string[] = [];
  if (run.scopeHints?.trim()) parts.push(`SCOPE LIMITS (authoritative):\n${run.scopeHints.trim()}`);
  if (run.userNotes?.trim()) parts.push(`CLIENT NOTES (authoritative):\n${run.userNotes.trim()}`);
  if (parts.length === 0) return "";
  return `\n\nThe client gave these instructions. They override your defaults — follow them strictly:\n\n${parts.join("\n\n")}`;
}

// Mapping from scratch: the budget discovery has always had.
const EXPLORATION_BUDGET = `EXPLORATION BUDGET: explore the main surfaces with roughly 15-25 tool calls,
then STOP and emit the JSON below. Do NOT over-explore — you do not need to
visit every page; once you can name 3-5 coherent journeys and the key services,
output the JSON immediately. Always finish with the JSON, never with a plan to
"explore more".`;

// CHE-133: the known map, rendered for the prompt, with the instruction that
// replaces EXPLORATION_BUDGET. Pure: anatomy and journeys are prose the model
// wrote on an earlier run, nothing here is substituted or interpolated beyond
// the run number and date — a `{{TEST_PASSWORD}}` that somehow ended up in a
// step label passes through as that literal string, exactly as every other
// prompt block treats it (the fill tool substitutes, the prompt never does).
export function knownMapBlock(known: KnownMap): string {
  const { anatomy } = known;
  const lines: string[] = [];
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

  lines.push(
    `KNOWN MAP — what we mapped on the last full check, Run #${known.runNumber}` +
      ` (walked ${known.walkedAt.slice(0, 10)}):`,
  );
  const pages = anatomy.pages.slice(0, KNOWN_MAP_CAPS.pages);
  if (pages.length) lines.push(`Pages:\n${list(pages)}`);
  const actions = anatomy.actions.slice(0, KNOWN_MAP_CAPS.actions);
  if (actions.length) lines.push(`Actions:\n${list(actions)}`);
  const services = anatomy.services
    .slice(0, KNOWN_MAP_CAPS.services)
    .map((s) => (s.role ? `${s.name} — ${s.role}` : s.name));
  if (services.length) lines.push(`External services:\n${list(services)}`);
  const tech = Object.entries(anatomy.tech)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0)
    .map(([k, v]) => `${k}: ${v}`);
  if (tech.length) lines.push(`Tech:\n${list(tech)}`);
  const journeys = known.journeys.slice(0, KNOWN_MAP_CAPS.journeys);
  if (journeys.length) {
    lines.push(
      "This app's journeys:\n" +
        journeys
          .map((j, i) => {
            // Steps for the best-established few; the rest by name, so every
            // journey is visible to be recognised and reused (CHE-247).
            const steps = i < KNOWN_MAP_CAPS.journeysWithSteps ? j.steps.slice(0, KNOWN_MAP_CAPS.steps) : [];
            const head = `${i + 1}. "${j.title}"${j.surface ? ` [${j.surface}]` : ""}`;
            return steps.length
              ? `${head}\n${steps.map((s, n) => `   ${n + 1}) ${s}`).join("\n")}`
              : head;
          })
          .join("\n"),
    );
  }

  lines.push(`This map is known to be accurate as of that run. CONFIRM it with a short pass
rather than mapping the app again: open the homepage and the pages the journeys
start from, read them, and glance at anything new in the navigation. Then output
the journeys: keep the known ones whose surfaces still exist (adapt their steps
to what you see now), replace any whose surface is gone, and add at most 2 for
genuinely new surfaces. When you keep a journey, REUSE ITS TITLE WORD FOR WORD —
these titles are how this app's journeys are tracked between checks, and a
rewording reads as a different journey. Budget 8-15 tool calls, then STOP and
emit the JSON below. Always finish with the JSON, never with a plan to
"explore more".`);

  return lines.join("\n\n");
}

// CHE-235: the price/conversion contract, plus what these journeys cost last
// time. The guide is shared verbatim with .claude/skills/journey-metrics —
// scripts/verify-journey-metrics.ts fails if the two drift, so the rules a
// coding agent reads and the rules our model is handed are one document.
//
// The stored numbers go in AFTER the guide on purpose: the guide's last section
// is "changing a number", and the numbers it governs read directly under it.
export function journeyMetricsBlock(known?: KnownMap | null): string {
  const lines = [JOURNEY_METRICS_GUIDE];
  const priced = (known?.journeys ?? []).filter((j) => j.metric || j.surface);
  if (priced.length) {
    lines.push(
      `WHAT THESE JOURNEYS COST LAST TIME — answer for each one whether it changed:\n` +
        priced
          .map(
            (j) =>
              `- "${j.title}" [${j.surface ?? "surface not recorded"}] — ${metricLine(
                asMetric(j.metric),
              )}`,
          )
          .join("\n"),
    );
  }
  lines.push(
    `Give every journey you propose a "surface": "app" when it crosses the ` +
      `product (sign up → first value), or the path of the page it belongs to ` +
      `("/settings") when it lives on one. A page can hold several journeys — ` +
      `changing a preference, uploading a file and pairing a device on the same ` +
      `settings page are three journeys, not three wordings of one.`,
  );
  return lines.join("\n\n");
}

// The stored metric arrives as the loose shape everything else uses; render it
// only when it is actually a pair of numbers.
function asMetric(metric: ProposedJourney["metric"]): JourneyMetric | null {
  if (!metric || typeof metric.price !== "number" || typeof metric.conversion !== "number") return null;
  return {
    price: metric.price,
    conversion: metric.conversion,
    note: typeof metric.note === "string" ? metric.note : "",
  };
}

// CHE-136: what the block shows of the app's history. Settled lines are
// already capped by composeKnowledge; these bound the other two lists.
export const KNOWLEDGE_CAPS = {
  changedPaths: 10,
  journeys: 5,
} as const;

// CHE-136: the AppKnowledge rendered for one of the three prompts. Pure —
// titles are prose an earlier run wrote or the owner marked, passed through
// verbatim; a `{{TEST_PASSWORD}}` in one stays that literal string, exactly as
// every other block treats it. Empty string when there is nothing to know.
//
// Two kinds of settled line, and they must not share a sentence: a finding the
// owner marked or the tracker canceled is a known condition and is never filed
// again; a finding whose fix was CONFIRMED from outside (reconcile.ts) is the
// opposite — if the symptom is back it is a regression, and the closing half
// of the tracker loop depends on synthesis writing it down so autofile can
// refile it. Telling the model "never file" about a confirmed fix would hide
// exactly the reappearance that loop exists to catch.
export function knowledgeBlock(
  k: AppKnowledge | null,
  phase: "discovery" | "walking" | "synthesis",
): string {
  if (!k) return "";
  const line = (s: { title: string; category: string | null }) =>
    `- ${s.title}${s.category ? ` (${s.category})` : ""}`;
  const settled = k.settled.filter((s) => s.why !== "resolved");
  const fixed = k.settled.filter((s) => s.why === "resolved");
  const changed = k.changedPaths.slice(0, KNOWLEDGE_CAPS.changedPaths);
  const sections: string[] = [];

  if (phase === "synthesis") {
    if (settled.length) {
      sections.push(
        "SETTLED BY THE OWNER — never file these as findings again, whatever the steps say; " +
          "if the same symptom is present, one clause in bottomLine ('a known condition') is " +
          "the most it gets:\n" +
          settled.map(line).join("\n"),
      );
    }
    if (fixed.length) {
      sections.push(
        "CONFIRMED FIXED on an earlier check — if the same symptom is present again it is a " +
          "regression: file it as a finding like any other, never soften it as a known condition:\n" +
          fixed.map(line).join("\n"),
      );
    }
    if (changed.length) {
      sections.push(
        "The following pages changed since the last check; findings there are new by default: " +
          changed.join(", "),
      );
    }
    return sections.join("\n\n");
  }

  sections.push("KNOWN ABOUT THIS APP:");
  if (settled.length) {
    sections.push(
      "Settled — already ruled by the owner or confirmed fixed; do NOT spend steps proving these " +
        "again. If you meet one, report the step as ok/skipped with one line saying it is a " +
        "known condition, and move on:\n" +
        settled.map(line).join("\n"),
    );
  }
  if (fixed.length) {
    sections.push(
      "Confirmed fixed on an earlier check — walk these normally; if the symptom is back, " +
        "report it as you would any failure:\n" +
        fixed.map(line).join("\n"),
    );
  }
  if (changed.length) {
    sections.push(
      "Changed since the last check — give these pages attention first:\n" +
        changed.map((p) => `- ${p}`).join("\n"),
    );
  }
  if (phase === "discovery" && k.journeys.length) {
    sections.push(
      "Last check's journeys and how they ended:\n" +
        k.journeys
          .slice(0, KNOWLEDGE_CAPS.journeys)
          .map((j) => `- "${j.title}" — ${j.status} (${j.walkedAt.slice(0, 10)})`)
          .join("\n"),
    );
  }
  // A heading with nothing under it says nothing.
  return sections.length > 1 ? sections.join("\n\n") : "";
}

// The block as it lands in the discovery/walking prompts: after the client's
// own instructions, or nothing at all — the prompt without knowledge is
// byte-identical to the prompt before knowledge existed.
function knowledgeTail(k: AppKnowledge | null | undefined, phase: "discovery" | "walking"): string {
  const block = knowledgeBlock(k ?? null, phase);
  return block ? `\n\n${block}` : "";
}

export function discoverySystem(run: Run, known?: KnownMap, knowledge?: AppKnowledge | null): string {
  return `${MISSION}

CURRENT PHASE: Discovery.
Goal: map the app and propose user journeys. Explore navigation, primary CTAs
and forms (do not submit anything irreversible). Identify:
- pages (paths you saw),
- actions users can take,
- external services (from network requests),
- tech stack signals,
- up to 5 coherent user journeys (4-10 steps each) that represent real user goals.

${known ? knownMapBlock(known) : EXPLORATION_BUDGET}

${journeyMetricsBlock(known)}

When done, respond with ONLY a JSON object, no prose:
{"journeys":[{"title":"...","steps":["...", "..."],"surface":"app" | "/settings",
  "price":6,"conversion":65,"metricNote":"..."}],
 "anatomy":{"pages":["/", ...],"actions":["...", ...],
  "services":[{"name":"...","role":"..."}],
  "tech":{"frontend":"...","hosting":"...","auth":"...","realtime":"..."}}}${focusBlock(run)}${
    run.focusAreas?.trim()
      ? "\n\nAt least one of your proposed journeys must cover EACH of the owner's" +
        " priority concerns above, with steps that verify it directly."
      : ""
  }${credentialsBlock(run)}${crudBlock(run)}${
    (run.testEmail && run.testPasswordEnc) || accountLabels(run).length
      ? "\n\nBecause test credentials are provided, one of your proposed journeys MUST be" +
        " signing in with them and reaching the core authenticated flow."
      : ""
  }${
    accountLabels(run).length
      ? "\n\nEvery priority concern that names a test account needs a journey signed in as" +
        ' that account, and its title must say which (e.g. "As admin: …").'
      : ""
  }${allowedOriginsBlock(run)}${clientInstructionBlock(run)}${knowledgeTail(knowledge, "discovery")}`;
}

export function walkingSystem(
  run: Run,
  journeyTitle: string,
  steps: string[],
  knowledge?: AppKnowledge | null,
): string {
  return `${MISSION}

CURRENT PHASE: Walking a journey.
Journey: "${journeyTitle}"
Planned steps (adapt if reality differs):
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

For EACH meaningful step: act, observe, then call report_step with an honest
status (ok / risky / confusing / broken / exposed / skipped) and what you tried
vs what happened. Take a screenshot before report_step so the step has evidence.

After the journey, call write_e2e_test ONCE with a Playwright spec (TypeScript,
@playwright/test) that replays this journey's happy path using role-based
locators and \`process.env.TARGET_URL\` as base URL. The spec must reflect what
actually works today — assert on what you observed, not on what should be.
Make interactions hydration-robust: wrap interact-then-assert pairs in
\`await expect(async () => { ...act...; await expect(...).toBeVisible({ timeout: 1_000 }); }).toPass({ timeout: 15_000 })\`
— React controlled forms silently drop input that lands before hydration.
Locator choice must match the page digest exactly: getByLabel only for fields
with label="...", getByPlaceholder for placeholder="..." fields.

Finish with a 1-2 sentence summary of what you found (plain text). If anything
was not ok, the FIRST sentence names the problem — the summary's job is "what's
wrong", never a recap of what works.${focusBlock(run)}${credentialsBlock(run)}${crudBlock(run)}${allowedOriginsBlock(run)}${clientInstructionBlock(run)}${knowledgeTail(knowledge, "walking")}`;
}
