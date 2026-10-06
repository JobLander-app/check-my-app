// CHE-406 verification: a control is refused for what it is, not for what the
// walk called it.
//
// Run #304 (checkmyapp.dev, 2026-10-02): five journeys stopped at the
// onboarding button "Save & start watching"; a sixth pressed it, by addressing
// it as `button[type=submit]`, and an app with a daily watch was created in
// our own product. The gate read the name the walk gave, and the walk gave none.
//
// The rules (src/agent/hands-off.ts), then the real tools (src/agent/tools.ts)
// on a real browser:
//   1. the rules: where they apply, what they hold, what they leave alone;
//   2. on our own product, in a run that may create (as checkmyapp.dev's is):
//      "Save & start watching" and "Re-check now" are refused however they are
//      addressed, nothing reaches the product, and a step then reported broken
//      is settled in code; "Save settings" — a create the run is allowed — and
//      a link are still pressed;
//   3. on our own product, in a run that only reads: a save and a removal are
//      refused by selector too, and the refusal offers no selector as a way round;
//   4. on a customer's app, in an ordinary run: nothing changed — the name is
//      what is tested, and a create refused by name still says how to press a
//      button that only reads.
// (Inside a person's signed-in session: scripts/verify-session-browser.ts.)
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-hands-off.ts
//        HANDS_OFF_CHANNEL=chrome … to run it on the system Chrome, as CI does

import { chromium, type Browser, type Page } from "playwright";
import { executeTool, prepareAgentPage, type ToolEnv } from "@/agent/tools";
import { COMMIT_VERBS, handsOffAddress, handsOffIn, handsOffRefusal, handsOffUnread, isActionAddress, isStrictPlace, REMOVE_VERBS, STATE_TOGGLE_VERBS, type HandsOffPlace } from "@/agent/hands-off";
import type { ControlSeen } from "@/agent/session-browser";
import { hasEnvironmentLeak, hasHomework, SELF_CHECK_REFUSED_OBSERVED } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const OURS = "https://checkmyapp.dev";
const THEIRS = "https://shop.test";

// Ids that say nothing of what the controls do: a selector must not be what
// gives a control away.
const write = (what: string) => `fetch('/api/write/${what}', { method: 'POST' })`;
const PAGES: Record<string, string> = {
  "/onboarding": `<!doctype html><title>Add your app</title>
    <form action="/api/write/app" method="post">
      <input id="f0" name="targetUrl" placeholder="https://your-app.com">
      <button id="c0">Save &amp; start watching</button>
    </form>`,
  "/dashboard/app": `<!doctype html><title>App settings</title>
    <a id="c4" href="/onboarding">Add your app</a>
    <button id="c1" onclick="${write("settings")}">Save settings</button>
    <button id="c2" onclick="${write("recheck")}"><span id="c2t">Re-check now</span></button>
    <button id="c3" onclick="${write("remove")}">Remove app</button>`,
};

async function launch(): Promise<Browser> {
  const channel = process.env.HANDS_OFF_CHANNEL;
  if (channel) return chromium.launch({ channel });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

type Env = ToolEnv & { page: Page; writes: string[] };

async function envAt(browser: Browser, site: string, path: string, writeAllowed: boolean): Promise<Env> {
  const context = await browser.newContext();
  const writes: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/write/")) {
      writes.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Written</title>" });
    }
    const body = url.origin === site ? PAGES[url.pathname] : undefined;
    return body === undefined ? route.fulfill({ status: 404, body: "not found" }) : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  const page = await context.newPage();
  const env = { page, writes, targetOrigin: site, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [], writeAllowed, testMarker: "CheckMyApp test r0" } as unknown as Env;
  await prepareAgentPage(env);
  const opened = await executeTool(env, "navigate", { url: `${site}${path}` });
  if (!opened.startsWith("Navigated")) throw new Error(`fixture did not load: ${opened}`);
  return env;
}

const control = (text: string, extra: Partial<ControlSeen> = {}): ControlSeen => ({ texts: [text], addresses: [], kind: "button", link: "", ...extra });
const held = (c: ControlSeen, place: HandsOffPlace) => handsOffIn(c, place)?.rule ?? null;

async function main() {
  // ── 1 — the rules ────────────────────────────────────────────────────────
  const ordinary: HandsOffPlace = { session: false, ownHost: false, writeAllowed: false };
  const session: HandsOffPlace = { session: true, ownHost: false, writeAllowed: false };
  const oursMayWrite: HandsOffPlace = { session: false, ownHost: true, writeAllowed: true };
  const oursReadOnly: HandsOffPlace = { session: false, ownHost: true, writeAllowed: false };

  check("a strict place is a person's session or our own product — nothing else", isStrictPlace(session) && isStrictPlace(oursMayWrite) && !isStrictPlace(ordinary));
  check("in an ordinary run on a customer's app the control is not read at all",
    ["Save", "Delete account", "Cancel subscription", "Re-check now", "Start free trial"].every((t) => held(control(t), ordinary) === null));
  check("our own product, a run that may create: \"Save & start watching\" is a toggle, \"Re-check now\" is ours alone to refuse, \"Save settings\" and \"Remove app\" are the run's to press",
    held(control("Save & start watching"), oursMayWrite) === "toggle" && held(control("Re-check now"), oursMayWrite) === "own_host" &&
      held(control("Save settings"), oursMayWrite) === null && held(control("Remove app"), oursMayWrite) === null,
    [held(control("Save & start watching"), oursMayWrite), held(control("Re-check now"), oursMayWrite), held(control("Save settings"), oursMayWrite), held(control("Remove app"), oursMayWrite)].join(" | "));
  check("our own product, a run that only reads: a save is a create, a removal is a removal",
    held(control("Save settings"), oursReadOnly) === "create" && held(control("Remove app"), oursReadOnly) === "remove");
  check("\"Export\" is guarded on our own product and nobody else's", held(control("Export specs"), oursMayWrite) === "own_host" && held(control("Export specs"), session) === null);
  const SESSION_HELD: [string, string][] = [
    ["Save", "create"], ["Add rule", "create"], ["Delete", "remove"], ["Remove country", "remove"], ["Uninstall app", "remove"], ["Block IP address", "remove"],
    ["Unblock", "remove"], ["Reset to defaults", "remove"], ["Update", "commit"], ["Apply changes", "commit"], ["Confirm", "commit"], ["Approve charge", "commit"],
    ["Start free trial", "commit"], ["Select plan", "commit"], ["Accept terms", "commit"], ["Enable protection", "toggle"], ["Cancel subscription", "toggle"], ["Upgrade", "toggle"],
    ["Unpublish", "remove"], ["Mark as fulfilled", "commit"], ["Connect account", "commit"], ["Pin app", "commit"], ["Unpin", "commit"],
  ];
  check("a person's session: the ways a button says it saves, removes, commits or toggles",
    SESSION_HELD.every(([t, rule]) => held(control(t), session) === rule), SESSION_HELD.filter(([t, rule]) => held(control(t), session) !== rule).map(([t]) => `${t}=${held(control(t), session)}`).join(" | "));
  const SESSION_FREE = ["View details", "Search", "Apply filter", "Next", "Show more", "Blocked countries", "Blocklist", "Orders", "Updates", "Removed visitors", "Protection dashboard", "Team access", "Close", "Refresh",
    "Connected accounts", "Connection status", "Pinned apps", "Bookmarks", "PIN code", "Discard"];
  check("a person's session: what only reads or only names a page is not held",
    SESSION_FREE.every((t) => held(control(t), session) === null), SESSION_FREE.filter((t) => held(control(t), session) !== null).join(" | "));
  check("the control is read by every name it has: its text, its accessible name, its value",
    held({ texts: ["×", "Remove country"], addresses: [], kind: "button" }, session) === "remove" && held({ texts: ["Save"], addresses: [], kind: "input:submit" }, session) === "create");
  check("a switch changes a setting when pressed, whatever it is called — in a session", held(control("VPN traffic", { kind: "switch" }), session) === "switch" && held(control("VPN traffic", { kind: "switch" }), oursReadOnly) === null);
  check("a link that opens a form is reading; one that leads nowhere is a button",
    held(control("Add product", { kind: "a", link: "/admin/products/new" }), session) === null && held(control("Orders", { kind: "a", link: "/admin/orders" }), session) === null &&
      held(control("Add rule", { kind: "a", link: "#" }), session) === "create" && held(control("Delete", { kind: "a", link: "javascript:void(0)" }), session) === "remove" && held(control("Delete", { kind: "a", link: "" }), session) === "remove");
  // Codex on #261, round 1.
  check("a link whose words say it changes something is not clicked — the walk is sent to its address, where no script of the link's runs",
    held(control("Cancel subscription", { kind: "a", link: "/billing" }), session) === "link" && held(control("Delete", { kind: "a", link: "/items/42" }), session) === "link" &&
      held(control("Block countries", { kind: "a", link: "https://admin.shop.test/apps/x/countries" }), session) === "link" && held(control("Export", { kind: "a", link: "/runs/1/specs" }), oursMayWrite) === "link" &&
      /open that page by its address with navigate/.test(handsOffRefusal({ rule: "link", what: "Block countries" })));
  check("a link, or a form, that leads to an address naming an action is not opened at all — whatever its words",
    held(control("Details", { kind: "a", link: "/orders/7/cancel" }), session) === "address" && held(control("Go", { kind: "a", link: "/admin/post.php?post=1&action=trash" }), session) === "address" &&
      held(control("OK", { kind: "button", addresses: ["/items/42/delete"] }), session) === "address" && held(control("Details", { kind: "a", link: "/orders/7/cancel" }), ordinary) === null);
  const ACTIONS = ["/delete/42", "/orders/7/cancel", "/admin?action=trash", "https://x.test/apps/1/uninstall", "/users/42/block", "/users/3/deactivate", "/keys/9/revoke?next=/", "/keys/9/reset", "/plan/upgrade#now", "/charges/5/approve"];
  // A segment that only begins with a verb is a page's name — said here so the
  // limit is on record: "/cancel-subscription" would be read as a page too.
  const PAGES_ONLY = ["/removed-items", "/cancellation-policy", "/settings/disabled-features", "/blog/how-to-delete-a-rule", "/dashboard?removed=shop.test", "/apps/x/block-countries",
    "/apps/easy-block-customer-ip-country", "/archived", "/trashcan-guide", "/guides/connect-your-agent", "/updates", "/orders/7"];
  check("addresses: a segment, or a query key or value, that IS the verb — never one that only begins with it or holds it",
    ACTIONS.every((a) => isActionAddress(a, THEIRS)) && !PAGES_ONLY.some((a) => isActionAddress(a, THEIRS)),
    [...ACTIONS.filter((a) => !isActionAddress(a, THEIRS)), ...PAGES_ONLY.filter((a) => isActionAddress(a, THEIRS))].join(" | "));
  // Codex on #261, round 3: a link refused for its word is sent to its address,
  // so the address is refused for the same word. Read off the lists themselves:
  // every single-word verb of the toggle, remove and commit lists.
  // The list's own alternatives, split where they are alternatives of the list
  // and not of a group inside one ("start (?:free )?trial", "(?:select|choose) plan").
  const singleWords = (verbs: RegExp) => {
    const inner = verbs.source.replace(/^\\b\(/, "").replace(/\)\\b$/, "");
    const out: string[] = [];
    let depth = 0;
    let word = "";
    for (const ch of `${inner}|`) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "|" && depth === 0) {
        out.push(word);
        word = "";
      } else word += ch;
    }
    return out.filter((w) => /^[a-z]+$/.test(w));
  };
  const listed = [...singleWords(STATE_TOGGLE_VERBS), ...singleWords(REMOVE_VERBS), ...singleWords(COMMIT_VERBS)];
  const missing = listed.filter((w) => !isActionAddress(`/things/42/${w}`, THEIRS) || !isActionAddress(`/admin?action=${w}`, THEIRS));
  check("addresses: every single-word verb the gates hold on a link is held as an address too — a refused link's address is no way round",
    listed.length > 30 && ["enable", "block", "reset", "ban", "disconnect", "unlink", "revert", "approve", "connect"].every((w) => listed.includes(w)) && missing.length === 0,
    `${listed.length} verbs read; missing: ${missing.join(", ")}`);
  check("a link called \"Block user\" that leads to /users/42/block is not opened by a click, and not by its address",
    held(control("Block user", { kind: "a", link: "/users/42/block" }), session) === "address" && handsOffAddress(`${THEIRS}/users/42/block`, session)?.rule === "address" &&
      held(control("Block countries", { kind: "a", link: "/app/block-countries" }), session) === "link" && handsOffAddress(`${THEIRS}/app/block-countries`, session) === null);
  check("a control that could not be read is not pressed in a strict place — and is, as before, anywhere else",
    handsOffUnread(session)?.rule === "unreadable" && handsOffUnread(oursMayWrite)?.rule === "unreadable" && handsOffUnread(ordinary) === null &&
      /could not be read/.test(handsOffRefusal({ rule: "unreadable", what: "the control" })) && /"our_capability"/.test(handsOffRefusal({ rule: "unreadable", what: "the control" })));
  check("the same for an address the walk types: refused in a strict place, nowhere else",
    handsOffAddress(`${THEIRS}/orders/7/cancel`, session)?.rule === "address" && handsOffAddress(`${OURS}/api/x/delete`, oursMayWrite)?.rule === "address" &&
      handsOffAddress(`${THEIRS}/orders/7/cancel`, ordinary) === null && handsOffAddress(`${THEIRS}/orders/7`, session) === null);
  const BOTH: [string, string][] = [["Save and continue", "create"], ["Confirm and next", "commit"], ["Delete and refresh", "remove"], ["Save & show preview", "create"], ["Find and remove duplicates", "remove"]];
  const READS = ["Apply filter", "Apply filters", "Reset filters", "Clear all filters", "Remove filter", "Add filter", "Show next", "Continue", "Refresh preview", "Search", "Sign in"];
  check("a word that only reads does not cancel a verb beside it: \"Save and continue\" saves; \"Apply filter\" filters",
    BOTH.every(([t, rule]) => held(control(t), session) === rule) && READS.every((t) => held(control(t), session) === null),
    [...BOTH.filter(([t, rule]) => held(control(t), session) !== rule).map(([t]) => `${t}=${held(control(t), session)}`), ...READS.filter((t) => held(control(t), session) !== null)].join(" | "));
  // CHE-407's replay of 483 customer clicks: the one false hold of the strict
  // gates was an FAQ accordion, "How do I get a refund?". A question is read.
  const QUESTIONS = ["How do I get a refund?", "Can I cancel my subscription?", "What happens when I delete a rule?", "Why was my order flagged?", "Need to reset your password?",
    // …with the accordion's own glyph after it, as innerText has it (Codex on #277, round 2).
    "How do I get a refund? +", "How do I get a refund?▾", "Can I cancel my subscription? ›"];
  // …and a question is one by its words, not its punctuation (Codex on #277):
  // a button that deletes with a question mark on it still deletes.
  const PUNCTUATED: [string, string][] = [["Delete account?", "remove"], ["Cancel subscription?", "toggle"], ["Save changes?", "create"], ["Really uninstall?", "remove"], ["Delete account? ×", "remove"]];
  check("a question is asked, not done: an FAQ heading that names a verb is not held — the same words as a command still are, question mark or not",
    QUESTIONS.every((t) => held(control(t), session) === null) && held(control("Refund"), session) === "commit" && held(control("Cancel my subscription"), session) === "toggle" &&
      held({ texts: ["How do I get a refund?", "Refund"], addresses: [], kind: "button" }, session) === "commit" &&
      PUNCTUATED.every(([t, rule]) => held(control(t), session) === rule),
    [...QUESTIONS.filter((t) => held(control(t), session) !== null).map((t) => `${t}=${held(control(t), session)}`),
      ...PUNCTUATED.filter(([t, rule]) => held(control(t), session) !== rule).map(([t]) => `${t}=${held(control(t), session)}`)].join(" | "));
  check("a button with no name at all is not pressed in a person's account — and is, as before, anywhere else",
    held({ texts: [], addresses: [], kind: "button" }, session) === "unnamed" && held({ texts: [], addresses: [], kind: "input:submit" }, session) === "unnamed" &&
      held({ texts: [], addresses: [], kind: "" }, session) === null && held({ texts: [], addresses: [], kind: "a", link: "/x" }, session) === null &&
      held({ texts: [], addresses: [], kind: "button" }, oursReadOnly) === null && held({ texts: [], addresses: [], kind: "button" }, ordinary) === null);
  check("a tab is reading", held(control("Order protection", { kind: "tab" }), session) === null && held(control("Order protection", { kind: "button" }), session) === "create");
  check("a field is not a press: its placeholder and its label are not judged",
    ["input:text", "input:search", "input:email", "textarea", "select"].every((kind) => held(control("Add a note…", { kind }), session) === null) &&
      ["input:submit", "input:button"].every((kind) => held(control("Add a note", { kind }), session) === "create"));
  // Codex on #261, round 2.
  const sessionMayWrite: HandsOffPlace = { session: true, ownHost: false, writeAllowed: true };
  const ON_OFF_KINDS = ["switch", "checkbox", "radio", "input:checkbox", "input:radio", "menuitemcheckbox"];
  check("a checkbox and a radio button are settings too: pressed, they change what was set — whatever they are called",
    ON_OFF_KINDS.every((kind) => held(control("Email alerts", { kind }), session) === "switch") && ON_OFF_KINDS.every((kind) => held(control("Email alerts", { kind }), ordinary) === null),
    ON_OFF_KINDS.filter((kind) => held(control("Email alerts", { kind }), session) !== "switch").join(" | "));
  check("permission to create a test record is not permission to flip a setting or press a nameless button in a person's account",
    held(control("Email alerts", { kind: "switch" }), sessionMayWrite) === "switch" && held(control("Email alerts", { kind: "input:checkbox" }), sessionMayWrite) === "switch" &&
      held({ texts: [], addresses: [], kind: "button" }, sessionMayWrite) === "unnamed" && held(control("Pause protection"), sessionMayWrite) === "toggle" &&
      held(control("Save"), sessionMayWrite) === null,
    [held(control("Email alerts", { kind: "switch" }), sessionMayWrite), held({ texts: [], addresses: [], kind: "button" }, sessionMayWrite), held(control("Save"), sessionMayWrite)].join(" | "));
  const paragraph = "Rules you save here apply to every visitor. You can add, update or delete a rule at any time, and block or unblock a country from the list.";
  check("text longer than a label is a container's, and names no control", held({ texts: [paragraph], addresses: [], kind: "" }, session) === null && held({ texts: [paragraph, "Delete"], addresses: [], kind: "button" }, session) === "remove");
  check("words: a word inside a longer one is not the verb",
    !["Blocked", "Blocklist", "Updates", "Removed", "Installer", "Payment history", "Application", "Resetting"].some((w) => REMOVE_VERBS.test(w) || COMMIT_VERBS.test(w)),
    ["Blocked", "Blocklist", "Updates", "Removed", "Installer", "Payment history", "Application", "Resetting"].filter((w) => REMOVE_VERBS.test(w) || COMMIT_VERBS.test(w)).join(" | "));
  const told = (["own_host", "toggle", "create", "remove", "commit", "switch", "unnamed"] as const).map((rule) => handsOffRefusal({ rule, what: "Save" }));
  check("what the walk is told: refused, skipped / not_applicable, no other way to press it — and nothing of ours, no homework",
    told.every((t) => t.startsWith("Refused: ") && t.includes('"not_applicable"') && /Do not press it by another name, another selector or another route/.test(t) && !/CSS selector instead/.test(t) && !hasEnvironmentLeak(t) && !hasHomework(t)),
    told.find((t) => hasEnvironmentLeak(t) || hasHomework(t)) ?? "");
  const toldAddress = handsOffRefusal({ rule: "address", what: "/orders/7/cancel" });
  check("…and of an address that names an action: not by a click, not by typing it, not by another route",
    toldAddress.startsWith('Refused: the address "/orders/7/cancel"') && toldAddress.includes('"not_applicable"') && /Do not reach it by a click, by typing it or by another route/.test(toldAddress) &&
      !hasEnvironmentLeak(toldAddress) && !hasHomework(toldAddress), toldAddress);

  // The same in the tool itself: a control that cannot be asked what it is —
  // here, a hand-made one with no way to ask — is not pressed on our own
  // product, and is pressed, as it always was, on a customer's.
  const unread = (origin: string) => {
    let pressed = 0;
    const locator = { first: () => locator, count: async () => 1, or: () => locator, elementHandle: async () => null, click: async () => void pressed++ };
    const page = {
      url: () => `${origin}/dashboard`, goto: async () => ({ status: () => 200 }), waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => 0,
      addInitScript: async () => {}, on: () => {}, getByRole: () => locator, getByText: () => locator, locator: () => locator,
    };
    const env = { page, targetOrigin: origin, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [], writeAllowed: true } as unknown as ToolEnv;
    return { env, pressed: () => pressed };
  };
  const oursUnread = unread(OURS);
  const refusedUnread = await executeTool(oursUnread.env, "click", { selector: "#anything" });
  check("the click tool, our own product: a control that could not be read is refused, not pressed",
    refusedUnread.startsWith("Refused:") && /could not be read/.test(refusedUnread) && oursUnread.pressed() === 0, `${refusedUnread.slice(0, 80)} | pressed ${oursUnread.pressed()}`);
  const theirsUnread = unread(THEIRS);
  const pressedUnread = await executeTool(theirsUnread.env, "click", { selector: "#anything" });
  check("…and on a customer's app, in an ordinary run, it is pressed as before", !pressedUnread.startsWith("Refused:") && theirsUnread.pressed() > 0, `${pressedUnread.slice(0, 80)} | pressed ${theirsUnread.pressed()}`);

  const browser = await launch();
  try {
    // ── 2 — our own product, a run that may create (checkmyapp.dev's own) ──
    const ours = await envAt(browser, OURS, "/onboarding", true);
    const pressed = await executeTool(ours, "click", { selector: "form button" });
    check("run #304's click: \"Save & start watching\" addressed as the form's button is refused",
      pressed.startsWith("Refused:") && pressed.includes("Save & start watching") && ours.page.url() === `${OURS}/onboarding`, pressed.slice(0, 120));
    const byId = await executeTool(ours, "click", { selector: "#c0" });
    check("…and by its id", byId.startsWith("Refused:"), byId.slice(0, 80));
    const byName = await executeTool(ours, "click", { role: "button", name: "Save & start watching" });
    check("…and by its name, as before", byName.startsWith("Refused:"), byName.slice(0, 80));
    check("nothing reached the product: no app was created", ours.writes.length === 0, ours.writes.join(", "));
    const written: Record<string, unknown>[] = [];
    ours.onReportStep = async (step) => {
      written.push({ ...step });
    };
    await executeTool(ours, "report_step", { label: "Register the app", status: "broken", attempted: "Pressed the form's button", observed: "The button does nothing: the app is never registered." });
    check("a step reported broken after the refusal is settled in code: skipped, not applicable, the fixed sentence",
      written[0]?.status === "skipped" && written[0]?.unverifiedReason === "not_applicable" && written[0]?.observed === SELF_CHECK_REFUSED_OBSERVED, JSON.stringify(written[0]));
    await executeTool(ours, "navigate", { url: `${OURS}/dashboard/app` });
    const recheck = await executeTool(ours, "click", { selector: "#c2t" });
    check("\"Re-check now\", clicked on the text inside the button by selector, is refused — it would start a paid check",
      recheck.startsWith("Refused:") && recheck.includes("Re-check now") && ours.writes.length === 0, `${recheck.slice(0, 80)} | ${ours.writes.join(", ")}`);
    const saved = await executeTool(ours, "click", { selector: "#c1" });
    check("\"Save settings\" is pressed: this run may create and change its own test record",
      saved.startsWith("Clicked") && ours.writes.join() === "POST /api/write/settings", `${saved.slice(0, 60)} | ${ours.writes.join(", ")}`);
    const followed = await executeTool(ours, "click", { selector: "#c4" });
    check("a link called \"Add your app\" is followed: opening the form is reading", followed.startsWith("Clicked") && ours.page.url() === `${OURS}/onboarding`, `${followed.slice(0, 60)} → ${ours.page.url()}`);
    await ours.page.context().close();

    // ── 3 — our own product, a run that only reads ─────────────────────────
    const reading = await envAt(browser, OURS, "/dashboard/app", false);
    const noSave = await executeTool(reading, "click", { selector: "#c1" });
    const noRemove = await executeTool(reading, "click", { selector: "#c3" });
    const noSaveByName = await executeTool(reading, "click", { role: "button", name: "Save settings" });
    check("a save and a removal are refused by selector, and the refusal by name offers no selector as the way round",
      noSave.startsWith("Refused:") && noRemove.startsWith("Refused:") && noSaveByName.startsWith("Refused:") && !/CSS selector instead/.test(noSaveByName) && reading.writes.length === 0,
      [noSave, noRemove, noSaveByName].map((r) => r.slice(0, 50)).join(" | "));
    await reading.page.context().close();

    // ── 4 — a customer's app, an ordinary run: as it was ───────────────────
    const theirs = await envAt(browser, THEIRS, "/dashboard/app", false);
    const theirsByName = await executeTool(theirs, "click", { role: "button", name: "Save settings" });
    check("a create refused by name still says how to press a button that only reads", theirsByName.startsWith("Refused:") && /CSS selector instead/.test(theirsByName), theirsByName.slice(-120));
    const theirsBySelector = await executeTool(theirs, "click", { selector: "#c1" });
    check("…and addressed by selector it is pressed — the half this change leaves as it was",
      theirsBySelector.startsWith("Clicked") && theirs.writes.join() === "POST /api/write/settings", `${theirsBySelector.slice(0, 60)} | ${theirs.writes.join(", ")}`);
    const theirsWritten: Record<string, unknown>[] = [];
    theirs.onReportStep = async (step) => {
      theirsWritten.push({ ...step });
    };
    await executeTool(theirs, "report_step", { label: "Save the settings", status: "broken", attempted: "Pressed Save settings", observed: "Saving answers with an error page." });
    check("…and a customer's step is never rewritten by a refusal of ours", theirsWritten[0]?.status === "broken" && theirsWritten[0]?.observed === "Saving answers with an error page.", JSON.stringify(theirsWritten[0]));
    await theirs.page.context().close();
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nverify-hands-off: all checks passed" : `\nverify-hands-off: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
