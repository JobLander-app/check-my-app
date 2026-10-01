// CHE-324: onboarding opens on the coding agent, not on a form. This proves,
// without a browser, Clerk or a D1:
//
//   1. the first onboarding screen offers two ways in, the agent first: the
//      CHE-317 panel with its headline, one-click key and install command, the
//      guide, a first prompt to paste, and "Done — go to dashboard"; then
//      "Add an app here", which leads to today's form;
//   2. the first prompt carries the person's own address when onboarding
//      knows one (?url= from a verdict), and the form link carries it on;
//   3. the page shows that screen first, keeps ?path=app and the CHE-320
//      extension link going straight to the form, and the dashboard's own
//      "+ Add app" goes to the form (its agent panel is already on top);
//   4. the agent path finishes without an app: nothing in the product sends
//      a person back to /onboarding, and the dashboard renders a team with
//      no apps;
//   5. the home page links to the guide, and the guide exists;
//   6. which way was chosen is captured as a catalogue event;
//   7. the words obey CLAUDE.md §1, and there is no useEffect.
//
// It renders the real components with react-dom/server.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-onboarding-agent-path.ts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { OnboardingChooser } from "@/components/onboarding-chooser";
import { CONNECT_GUIDE_PATH, EXAMPLE_APP_URL, firstPrompt, installCommand } from "@/lib/agent-connect";
import { ANALYTICS_EVENTS } from "@/lib/analytics";
import { hasEnvironmentLeak, hasHomework, narrationIn } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
function render(el: ReturnType<typeof createElement>): string {
  return renderToString(createElement(AppRouterContext.Provider, { value: router as never }, el));
}
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const HEADLINE = "This is the last time you need to be here.";

// ─── 1. Two ways in, the agent first ────────────────────────────────────────

const html = render(createElement(OnboardingChooser, { keys: [], url: null }));
const t = text(html);
const agentAt = t.indexOf(HEADLINE);
const manualAt = t.indexOf("Add an app here");
check("the agent path is on the first screen, with the CHE-317 headline", agentAt !== -1, t.slice(0, 300));
check("the 'Add an app here' path is on the first screen", manualAt !== -1);
check("…and the agent path comes first", agentAt !== -1 && manualAt !== -1 && agentAt < manualAt);
check("agent path: one-click Create key", t.includes("Create key"));
check("agent path: the install command (placeholder until a key exists)", t.includes(installCommand(null)));
check("agent path: Cursor / other clients", t.includes("Cursor / other clients"));
check("agent path: links the guide", html.includes(`href="${CONNECT_GUIDE_PATH}"`));
check("agent path: an example first prompt", t.includes(firstPrompt(null)), t);
check("agent path: the prompt adds an app, runs a check, fixes what it finds",
  /^Add my app .+ to CheckMyApp with the test account .+ Scenarios: .+ Then run a check and fix what it finds\.$/.test(firstPrompt(null)));
// CHE-351: the dashboard is Today (/home) inside the app shell.
check("agent path: 'Done — go to your apps' goes to /home",
  /<a[^>]*href="\/home"[^>]*>Done — go to your apps<\/a>/.test(html), html.match(/<a[^>]*>Done[^<]*<\/a>/)?.[0]);
check("manual path: leads to the form (?path=app)", /<a[^>]*href="\/onboarding\?path=app"[^>]*>Open the form →<\/a>/.test(html));
check("the agent path is the visually primary one (the accent-bordered card)",
  html.indexOf("border-accent/40") !== -1 && html.indexOf("border-accent/40") < html.indexOf("Add an app here"));

// A team whose key has been used: the panel is folded, the way out is still there.
const connected = text(render(createElement(OnboardingChooser, { keys: [{ lastUsedAt: "2026-09-27T10:00:00.000Z" }], url: null })));
check("connected team: 'Connected to your agent', no big headline", connected.includes("Connected to your agent") && !connected.includes(HEADLINE));
check("connected team: still the first prompt and Done", connected.includes(firstPrompt(null)) && connected.includes("Done — go to your apps"));

// ─── 2. The person's own address ────────────────────────────────────────────

const URL = "https://shop.example.org/app";
const withUrl = render(createElement(OnboardingChooser, { keys: [], url: URL }));
check("?url= goes into the first prompt", text(withUrl).includes(`Add my app ${URL} to CheckMyApp`));
check("…and on to the form", withUrl.includes(`href="/onboarding?path=app&amp;url=${encodeURIComponent(URL)}"`));
check("no ?url=: the prompt uses the example address", firstPrompt(null).includes(EXAMPLE_APP_URL) && firstPrompt("  ").includes(EXAMPLE_APP_URL));
check("a ?url= that is not an address does not end up in the prompt", firstPrompt("javascript:alert(1)").includes(EXAMPLE_APP_URL));

// ─── 3. The page ────────────────────────────────────────────────────────────

const page = source("src/app/onboarding/page.tsx");
check("the onboarding page renders the chooser first", /if \(path !== "app" && kind !== "extension"\) \{[\s\S]*<OnboardingChooser/.test(page));
check("…from the team's keys", /db\.apiKey\.findMany\(\{ where: \{ \.\.\.teamOwned\(team\.id\) \}/.test(page));
check("?path=app is still today's wizard", /<OnboardingWizard prefillUrl=\{url \?\? ""\}/.test(page));
check("CHE-320: the extension flag is still read", /await extensionCheckFor\(user\)/.test(page) && /extensionCheck && type === "extension"/.test(page));
const dashboard = source("src/app/(app)/home/page.tsx");
check("the dashboard's '+ Add app' goes to the form", /href="\/onboarding\?path=app"[\s\S]{0,200}\+ Add app/.test(dashboard));
check("the dashboard still links the extension form behind the flag", /\{extensionCheck && <Link href="\/onboarding\?type=extension"/.test(dashboard));

// ─── 4. Done without an app: nothing bounces ────────────────────────────────

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}
const bouncers = sources(join(process.cwd(), "src")).filter((f) =>
  /redirect\([^)]*["'`]\/onboarding|NextResponse\.redirect\([^)]*onboarding|router\.(push|replace)\([^)]*["'`]\/onboarding/.test(readFileSync(f, "utf8")),
);
check("nothing in the product redirects to /onboarding (no 'onboarded' gate to fail)", bouncers.length === 0, bouncers.join(", "));
check("the dashboard renders a team with no apps", /apps\.length === 0 \?/.test(dashboard) && !/redirect\(/.test(dashboard));

// ─── 5. The home page links to the guide ────────────────────────────────────

const home = source("src/app/page.tsx");
check("the home page links to the guide", /href=\{CONNECT_GUIDE_PATH\}/.test(home) && /Prefer your coding agent\?/.test(home));
check("the guide is a route", CONNECT_GUIDE_PATH === "/guides/connect-your-agent" && existsSync(join(process.cwd(), "src/app/guides/connect-your-agent/page.tsx")));

// ─── 6. Which way was chosen ────────────────────────────────────────────────

check("onboarding_path_chosen is a catalogue event", (ANALYTICS_EVENTS as readonly string[]).includes("onboarding_path_chosen"));
const chooser = source("src/components/onboarding-chooser.tsx");
check("…captured on the agent path's Done", /event="onboarding_path_chosen"\s+props=\{\{ path: "agent" \}\}\s+href="\/home"/.test(chooser));
check("…and on 'Add an app here'", /event="onboarding_path_chosen"\s+props=\{\{ path: "app" \}\}\s+href=\{manual\}/.test(chooser));

// ─── 7. §1 and the owner's rule ─────────────────────────────────────────────

const homeLine = "Prefer your coding agent? Connect it →";
// The narration detector reads "Done — …" as the envelope an agent wraps a
// verdict in ("Done — here is what I found"); on a button it is the button's
// name, so it is checked as prose without it. Homework and leaks are checked
// on everything.
const prose = t.replace("Done — go to your apps", "");
for (const [name, words] of [["onboarding first screen", t], ["home page line", homeLine]] as const) {
  const narration = narrationIn(words === t ? prose : words);
  check(`${name}: no homework`, !hasHomework(words));
  check(`${name}: no environment leak`, !hasEnvironmentLeak(words));
  check(`${name}: no machinery narration`, narration.length === 0, narration.join(" | "));
}
for (const f of ["src/components/onboarding-chooser.tsx", "src/components/connect-agent.tsx", "src/app/onboarding/page.tsx"]) {
  check(`no useEffect in ${f} (owner rule)`, !/useEffect/.test(source(f)));
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
