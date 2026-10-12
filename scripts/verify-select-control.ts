// A dropdown is a control a person drives by hand, and `fill` must too.
//
// Run #160 (checkmyapp.dev) walked the onboarding form, whose cadence menu is a
// native <select>. Playwright's fill() refuses a <select> ("not an <input>"),
// the tool read that as a control it could not drive, and the step was filed on
// our board as "Checker cannot drive a control that a person can operate by
// hand" — and re-filed on every run since. The menu takes an option with one
// choice by hand; so must the walk.
//
// Pure: a stub page, no browser, no network, no model, no database.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-select-control.ts

import { executeTool, type RecordedAction, type ToolEnv, type UndrivenControl } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const CADENCE = [
  { value: "daily", label: "Every day", disabled: false },
  { value: "weekly", label: "Every week", disabled: false },
  { value: "paused", label: "Paused", disabled: true },
];

// A <select> as Playwright sees it: fill() throws the message it throws for
// anything that is not a text control, selectOption() works.
function stubPage(opts: { sticks?: boolean } = {}) {
  let value = "daily";
  let filled = false;
  const locator = {
    first: () => locator,
    or: () => locator,
    count: async () => 1,
    elementHandle: async () => null,
    evaluate: async (fn: (el: unknown) => unknown) => {
      const src = String(fn);
      // Told apart by what each question asks of the element. Anything else the
      // tool asks (how the control is marked up) has no answer on a stub.
      if (src.includes(".options")) return CADENCE;
      if (src.includes("HTMLInputElement")) return true; // isTextControl: a select is something fill() names
      if (src.includes("HTMLSelectElement")) return true; // isSelectControl
      return null;
    },
    fill: async () => {
      filled = true;
      throw new Error("locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element");
    },
    selectOption: async (o: { value: string }) => {
      if (opts.sticks !== false) value = o.value;
    },
    inputValue: async () => value,
  };
  return {
    url: () => "https://checkmyapp.dev/onboarding?path=app",
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    locator: () => locator,
    chosen: () => value,
    fillWasTried: () => filled,
  };
}

function stubEnv(opts: { sticks?: boolean } = {}) {
  return {
    page: stubPage(opts),
    targetOrigin: "https://checkmyapp.dev",
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
    actionTrail: [],
    undrivenControls: [],
  } as unknown as ToolEnv & { page: ReturnType<typeof stubPage> };
}

async function main() {
  // 1 — by what the menu shows.
  {
    const env = stubEnv();
    const result = await executeTool(env, "fill", { label: "Frequency", value: "Every week" });
    check("a <select> is filled by its visible text", result === "Filled.", result);
    check("…the option behind that text is the one chosen", env.page.chosen() === "weekly", env.page.chosen());
    check("…without asking fill() to take a <select>", !env.page.fillWasTried());
    const trail = env.actionTrail as RecordedAction[];
    check("…the action is on the trail, so a replay does it again", trail.length === 1 && trail[0].kind === "fill");
    check("…and nothing is recorded as undriven", (env.undrivenControls as UndrivenControl[]).length === 0);
  }

  // 2 — by the value behind it, in any case.
  {
    const env = stubEnv();
    const result = await executeTool(env, "fill", { label: "Frequency", value: "WEEKLY" });
    check("a <select> is filled by its option value", result === "Filled." && env.page.chosen() === "weekly", result);
  }

  // 3 — a value that names no option is the model's mistake, answered with the
  // menu, and the control is not recorded as one we could not drive.
  {
    const env = stubEnv();
    const result = await executeTool(env, "fill", { label: "Frequency", value: "Hourly" });
    check("an unknown option is refused with the menu's options", /Every day/.test(result) && /Every week/.test(result) && /Nothing was selected/.test(result), result);
    check("…a disabled option is not offered", !/Paused/.test(result), result);
    check("…nothing was chosen", env.page.chosen() === "daily");
    check("…and it is not a control we could not drive", (env.undrivenControls as UndrivenControl[]).length === 0);
  }

  // 4 — a choice that does not stick is a control we could not drive, and says so.
  {
    const env = stubEnv({ sticks: false });
    const result = await executeTool(env, "fill", { label: "Frequency", value: "Every week" });
    check("a choice that did not stick is not reported as Filled.", result !== "Filled.", result.slice(0, 80));
    check("…it is recorded as undriven", (env.undrivenControls as UndrivenControl[]).length === 1);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
