// CHE-100 verification, run by us and not by the owner.
//
// The first version of this check was an instruction: "save a wrong password in
// settings, run a check, then put the right one back". That is homework handed
// to the person who is paying for a product whose whole promise is that they
// don't do this themselves — the same failure rule §1 forbids toward customers,
// pointed at the owner instead.
//
// So it runs here. The one-attempt rule is enforced entirely by three
// deterministic pieces, and all three are exercised below through the real
// executeTool entry point with a stub page — no browser, no money, no credential
// anywhere near a real product:
//   1. an auth rejection is recognised from the request log as a machine fact;
//   2. once recognised, the password is never typed into a field again;
//   3. and a sign-in control is never clicked again.
//
// CHE-172 adds the premise all three rest on: the credential that reaches the
// field is the clean one. Run #142's nav model wrote " {{TEST_PASSWORD}}" with
// a leading space, the product answered 401 to a password beginning with a
// space, and the one-attempt rule then correctly refused every further sign-in
// — on a rejection that was our own typing. So (5): whitespace around a
// placeholder is stripped before substitution, and the recorded action
// (CHE-129) carries the bare placeholder.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-credential-gate.ts

import { executeTool, credentialRejection, type RecordedAction, type ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// Enough of a page for the gates, which all decide before touching the browser.
function stubEnv(rejected: boolean): ToolEnv {
  return {
    page: { url: () => "https://target.test/login" },
    targetOrigin: "https://target.test",
    testEmail: "qa@target.test",
    testPassword: "s3cret-value",
    networkLog: [],
    consoleLog: [],
    credentials: { rejected },
  } as unknown as ToolEnv;
}

// CHE-172: a page whose one field remembers what was typed into it, so the
// assertion is on the bytes the product would have received.
function fillingEnv(): { env: ToolEnv; received: () => string | null } {
  let filled: string | null = null;
  const locator = {
    first: () => locator,
    or: () => locator,
    fill: async (v: string) => {
      filled = v;
    },
    inputValue: async () => filled,
  };
  const page = {
    url: () => "https://target.test/login",
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByRole: () => locator,
    locator: () => locator,
  };
  const env = {
    page,
    targetOrigin: "https://target.test",
    testEmail: "qa@target.test",
    testPassword: "s3cret-value",
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
    actionTrail: [],
  } as unknown as ToolEnv;
  return { env, received: () => filled };
}

async function main() {
  // 1 — recognising the rejection, and refusing to recognise the things that
  // merely look like one. JOB-906 and JOB-902 both answered 401 and were real
  // defects of the customer's; if either tripped this, we would go blind to a
  // whole class of genuine bugs.
  const cases: [string, string[], boolean][] = [
    ["stale password on a sign-in POST", ["POST https://t.dev/api/auth/email-signin → 401"], true],
    ["Clerk sign-in", ["POST https://t.dev/v1/client/sign_ins → 403"], true],
    ["oauth token exchange", ["POST https://t.dev/oauth/token → 401"], true],
    ["guest session check (JOB-906 — a real bug)", ["GET https://t.dev/api/auth/verify-session → 401"], false],
    ["anonymous analytics (JOB-902 — a real bug)", ["POST https://t.dev/api/analytics/track → 401"], false],
    ["successful sign-in", ["POST https://t.dev/api/auth/email-signin → 200"], false],
    ["rate limited, not rejected", ["POST https://t.dev/api/auth/email-signin → 429"], false],
    ["authors listing", ["POST https://t.dev/api/authors/12 → 403"], false],
  ];
  for (const [name, log, expect] of cases) {
    const got = credentialRejection(log);
    check(`detect: ${name}`, Boolean(got) === expect, got ?? "no rejection");
  }

  // 2 — after a rejection, the password cannot be typed again. This is the half
  // that actually stopped the Firebase lockout: refusing the click alone can be
  // routed around with a different control or the Enter key.
  const refusedFill = await executeTool(stubEnv(true), "fill", {
    label: "Password",
    value: "{{TEST_PASSWORD}}",
  });
  check(
    "after rejection: filling the password is refused",
    refusedFill.startsWith("Refused:") && refusedFill.includes("missing_access"),
    refusedFill.slice(0, 70),
  );

  // 3 — and a sign-in control is not clicked again.
  const refusedClick = await executeTool(stubEnv(true), "click", { name: "Sign in" });
  check(
    "after rejection: clicking sign in is refused",
    refusedClick.startsWith("Refused:") && refusedClick.includes("missing_access"),
    refusedClick.slice(0, 70),
  );

  // 4 — and the gate stays narrow. A run whose credential is fine must behave
  // exactly as before; a silent loss of the signed-in half is the worst way for
  // this to fail, because nothing looks wrong.
  // The pass condition is that it reached the browser at all: the stub page has
  // no locator methods, so an error from there proves the gate let it through.
  // A refusal, or the "no test credentials" branch, would mean it did not.
  const healthyFill = await executeTool(stubEnv(false), "fill", {
    label: "Password",
    value: "{{TEST_PASSWORD}}",
  });
  check(
    "healthy run: the password still reaches the field",
    !healthyFill.startsWith("Refused:") && !healthyFill.includes("No test credentials"),
    healthyFill.slice(0, 70),
  );

  // 5 — CHE-172: whitespace around a placeholder never reaches the field. Each
  // padded spelling fills the clean secret, byte for byte, and the recorded
  // action carries the bare placeholder — a replay must not redo the padding.
  const padded: Array<[string, string, string]> = [
    [" {{TEST_PASSWORD}}", "s3cret-value", "{{TEST_PASSWORD}}"],
    ["{{TEST_PASSWORD}} ", "s3cret-value", "{{TEST_PASSWORD}}"],
    ["\t{{TEST_EMAIL}}\n", "qa@target.test", "{{TEST_EMAIL}}"],
  ];
  for (const [value, expectField, expectRecorded] of padded) {
    const { env, received } = fillingEnv();
    const result = await executeTool(env, "fill", { label: "Field", value });
    const action = (env.actionTrail as RecordedAction[])[0];
    check(
      `padded placeholder ${JSON.stringify(value)} fills the clean value exactly`,
      result === "Filled (credential substituted server-side)." && received() === expectField,
      `field received ${JSON.stringify(received())}`,
    );
    check(
      `padded placeholder ${JSON.stringify(value)} is recorded as the bare placeholder`,
      action?.kind === "fill" && action.value === expectRecorded,
      JSON.stringify(action),
    );
  }
  // A placeholder next to other text is the model's real intent, however odd,
  // and stays exactly what it was: the normalisation is for padding only.
  {
    const { env, received } = fillingEnv();
    await executeTool(env, "fill", { label: "Field", value: "{{TEST_EMAIL}}x" });
    const action = (env.actionTrail as RecordedAction[])[0];
    check(
      'a placeholder with other text ("{{TEST_EMAIL}}x") is filled as written',
      received() === "qa@target.testx" && action?.kind === "fill" && action.value === "{{TEST_EMAIL}}x",
      `field received ${JSON.stringify(received())}, recorded ${JSON.stringify(action?.kind === "fill" ? action.value : action)}`,
    );
  }

  // 6 — CHE-372: the store password follows the same one-attempt rule. A
  // store that turns it away is not asked again — not by the next page of this
  // phase, not by a phase that starts already knowing (storeAccess seeded from
  // Run.storePasswordRejected), and not through the fill tool.
  {
    const submitted: string[] = [];
    let url = "about:blank";
    const field = {
      first: () => field,
      count: async () => (url.endsWith("/password") ? 1 : 0),
      fill: async (v: string) => void submitted.push(v),
      press: async () => {},
    };
    const page = {
      url: () => url,
      // Every page of a locked store is its password page; a wrong password
      // keeps it so.
      goto: async () => {
        url = "https://target.test/password";
        return { status: () => 200 };
      },
      waitForURL: async () => {
        throw new Error("Timeout");
      },
      waitForLoadState: async () => {},
      evaluate: async () => 0,
      locator: () => field,
    };
    let persisted = 0;
    const env = {
      page,
      targetOrigin: "https://target.test",
      networkLog: [],
      consoleLog: [],
      actionTrail: [],
      storePassword: "stale-store-pw",
      storeAccess: { rejected: false },
      onStorePasswordRejected: async () => void persisted++,
    } as unknown as ToolEnv;
    const first = await executeTool(env, "navigate", { url: "https://target.test/" });
    check("store password: the first locked page gets exactly one attempt",
      submitted.length === 1 && persisted === 1 && first.includes("missing_access"), `${submitted.length} ${first.slice(0, 80)}`);
    await executeTool(env, "navigate", { url: "https://target.test/cart" });
    await executeTool(env, "navigate", { url: "https://target.test/collections/all" });
    check("store password: after the rejection, no later page submits it again",
      submitted.length === 1 && persisted === 1, `${submitted.length} submissions`);
    const typed = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}" });
    check("store password: nor can the model type into the store's password form",
      typed.startsWith("Refused:") && submitted.length === 1, typed.slice(0, 80));

    const nextPhase = { ...env, storeAccess: { rejected: true }, actionTrail: [] } as unknown as ToolEnv;
    await executeTool(nextPhase, "navigate", { url: "https://target.test/" });
    check("store password: a phase that starts knowing it was rejected never submits it",
      submitted.length === 1 && persisted === 1, `${submitted.length} submissions`);
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
