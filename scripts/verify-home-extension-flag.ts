// CHE-320: the Chrome-extension check is behind the PostHog flag
// `home-extension-check` — off for the public, on for the owner; off for test
// accounts, which the self-check signs in with (CHE-334). This proves,
// without a browser, a server or PostHog:
//
//   1. the server-rendered home form carries no extension option when the
//      flag is off, and carries it when the flag is on — including when a Web
//      Store link arrives as ?url=, the one way in that is not the toggle;
//   2. the flag reader fails closed: no person, an HTTP error, a timeout, a
//      malformed body or a missing flag are all "off", and an anonymous
//      visitor costs no request at all;
//   3. the home page, onboarding and the dashboard all read the same flag.
//
// It renders the real component with react-dom/server — the HTML a visitor
// receives before any script runs, which is exactly where a flag read in the
// browser would have leaked the option.
//
// --live additionally asks the real PostHog project: the owner's e-mail gets
// the flag, a test account and a stranger do not. Not in CI (network).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-home-extension-flag.ts [--live]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SubmitForm } from "@/components/submit-form";
import {
  HOME_EXTENSION_CHECK_FLAG,
  POSTHOG_FLAGS_URL,
  buildFlagsPayload,
  evaluateFlag,
  flagEnabledIn,
  type FlagFetch,
} from "@/lib/feature-flags";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

// ─── 1. What the server sends ───────────────────────────────────────────────

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };

function renderHome(props: { initialUrl?: string; extensionCheck?: boolean }): string {
  return renderToString(
    createElement(AppRouterContext.Provider, { value: router as never }, createElement(SubmitForm, props)),
  );
}

const STORE_LINK = "https://chromewebstore.google.com/detail/some-extension/abcdefghijklmnopabcdefghijklmnop";

const off = renderHome({ extensionCheck: false });
check("flag off: no product-type toggle in the HTML", !off.includes("Product type"));
check("flag off: no 'Chrome extension' option in the HTML", !off.includes("Chrome extension"));
check("flag off: the website form is still there", off.includes("Show me my app"));

const unset = renderHome({});
check("no flag passed at all: hidden (the default is off)", !unset.includes("Chrome extension"));

const on = renderHome({ extensionCheck: true });
check("flag on: the product-type toggle is in the HTML", on.includes("Product type"));
check("flag on: the 'Chrome extension' option is in the HTML", on.includes("Chrome extension"));

const offLink = renderHome({ extensionCheck: false, initialUrl: STORE_LINK });
check("flag off + ?url=<store link>: the form does not switch to extension mode", !offLink.includes("Check my extension"));
check("flag off + ?url=<store link>: no extension settings", !/chrome extension/i.test(offLink));
check("flag off + ?url=<store link>: refused in plain words", offLink.includes("Chrome Web Store links can"));

const onLink = renderHome({ extensionCheck: true, initialUrl: STORE_LINK });
check("flag on + ?url=<store link>: extension mode, as before", onLink.includes("Check my extension"));

// ─── 2. The flag reader fails closed ────────────────────────────────────────

const person = { distinctId: "user_owner", email: "owner@example.com", isTestAccount: false };

function fakeFetch(respond: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) {
  const calls: { url: string; body: unknown }[] = [];
  const impl: FlagFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return respond();
  };
  return { impl, calls };
}
const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body });
const enabled = (value: boolean) => ({ flags: { [HOME_EXTENSION_CHECK_FLAG]: { key: HOME_EXTENSION_CHECK_FLAG, enabled: value } } });

// Quiet the reader's own warnings while it is being fed failures on purpose.
const warn = console.warn;
console.warn = () => {};

async function flagChecks(): Promise<void> {
  {
    const f = fakeFetch(reply(200, enabled(true)));
    check("anonymous visitor: off", (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, null, f.impl)) === false);
    check("…and no request is made for them", f.calls.length === 0, `${f.calls.length} calls`);
  }
  {
    const f = fakeFetch(reply(200, enabled(true)));
    check("PostHog says enabled: on", (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, person, f.impl)) === true);
    check("the request goes to the flags endpoint", f.calls[0]?.url === POSTHOG_FLAGS_URL, f.calls[0]?.url);
    const body = f.calls[0]?.body as ReturnType<typeof buildFlagsPayload>;
    check(
      "…as the Clerk id, with email as a person property",
      body.distinct_id === "user_owner" && body.person_properties.email === "owner@example.com",
      JSON.stringify(body),
    );
  }
  {
    // CHE-334: the self-check signs in as the test account and must see what
    // a stranger sees — even when PostHog would say yes.
    const f = fakeFetch(reply(200, enabled(true)));
    const testAccount = { distinctId: "user_dogfood", email: "dogfood+clerk_test@example.com", isTestAccount: true };
    check("test account (the self-check's): off, as a stranger", (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, testAccount, f.impl)) === false);
    check("…and no request is made for it", f.calls.length === 0, `${f.calls.length} calls`);
  }
  const offCases: [string, () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>][] = [
    ["PostHog says disabled", reply(200, enabled(false))],
    ["the flag is missing from the answer (deleted, renamed)", reply(200, { flags: {} })],
    ["HTTP 500", reply(500, enabled(true))],
    ["a body that is not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })],
    ["the network fails or times out", async () => { throw new DOMException("timed out", "TimeoutError"); }],
  ];
  for (const [name, respond] of offCases) {
    check(`${name}: off`, (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, person, fakeFetch(respond).impl)) === false);
  }
  check("a truthy non-boolean is not 'enabled'", !flagEnabledIn({ flags: { [HOME_EXTENSION_CHECK_FLAG]: { enabled: "true" } } }, HOME_EXTENSION_CHECK_FLAG));
}

// ─── 3. Every way in reads the same flag ────────────────────────────────────

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function wiringChecks(): void {
  const home = source("src/app/page.tsx");
  check("the home page evaluates the flag on the server", /await viewerExtensionCheck\(\)/.test(home));
  check("…and hands it to the form", /<SubmitForm[^>]*extensionCheck=\{extensionCheck\}/.test(home));

  const onboarding = source("src/app/onboarding/page.tsx");
  check("onboarding evaluates the flag", /await extensionCheckFor\(user\)/.test(onboarding));
  check("…and ?type=extension only counts when it is on", /extensionCheck && type === "extension"/.test(onboarding));

  const actions = source("src/app/onboarding/actions.ts");
  check("saving a Web Store link from onboarding asks the flag too", /isExtension && !\(await extensionCheckFor\(user\)\)/.test(actions));

  const dashboard = source("src/app/(app)/home/page.tsx");
  check("the dashboard's '+ Add extension' link is behind the flag", /\{extensionCheck && <Link href="\/onboarding\?type=extension"/.test(dashboard));

  const declared = source("scripts/posthog-flags.ts");
  check("posthog:setup declares the flag under the key the app reads", /key: HOME_EXTENSION_CHECK_FLAG,\s*audience: "owner"/.test(declared));
}

// ─── Live (optional) ────────────────────────────────────────────────────────

async function liveChecks(): Promise<void> {
  const ask = (email: string, isTestAccount: boolean) =>
    evaluateFlag(HOME_EXTENSION_CHECK_FLAG, { distinctId: `verify-che-320-${email}`, email, isTestAccount });
  check("live: the owner's e-mail gets the flag", (await ask("sorokinvj@gmail.com", false)) === true);
  check("live: a test account does not (CHE-334)", (await ask("someone@example.com", true)) === false);
  check("live: a stranger does not", (await ask("stranger@example.com", false)) === false);
}

(async () => {
  await flagChecks();
  console.warn = warn;
  wiringChecks();
  if (process.argv.includes("--live")) await liveChecks();
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
