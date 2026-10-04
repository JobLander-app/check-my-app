// CHE-402 verification: a model's own "&amp;" comes off where its words come in.
//
// Run #298 (prod): the page was read as `BUTTONS: "Add login & notes
// (optional)"`; the model asked to click `"Add login &amp; notes (optional)"`.
// The click found no such button — reported as a control we could not drive —
// and the step was stored and shown as `Expand "Add login &amp; notes
// (optional)"`.
//
//   1. the rule: one level of "&amp;", only when the text shows the model was
//      escaping, and no other entity touched (a finding that quotes entity text
//      a page really shows keeps its evidence);
//   2. a tool call's input and a structured answer, string by string;
//   3. a model's whole answer: tool calls and text, thinking left as it came;
//   4. every answer passes through it (createWithRetry);
//   5. the real tools on a real browser: the click that failed in #298 presses
//      the button, and the step it reports is stored with "&".
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-model-ampersand.ts
//        MODEL_AMPERSAND_CHANNEL=chrome … to run it on the system Chrome, as CI does

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type Page } from "playwright";
import { createWithRetry } from "@/agent/core";
import { createOnRoutes } from "@/agent/llm";
import { executeTool, prepareAgentPage, type ReportedStep, type ToolEnv } from "@/agent/tools";
import { inOwnWords, ownWords, ownWordsDeep, ownWordsInAnswer } from "@/lib/model-text";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const SITE = "https://shop.test";
const PAGE = `<!doctype html><title>Check</title>
  <button id="more" onclick="this.dataset.pressed = 'yes'; document.getElementById('panel').hidden = false">Add login &amp; notes (optional)</button>
  <div id="panel" hidden><label for="n">Notes</label><input id="n"></div>`;

async function launch(): Promise<Browser> {
  const channel = process.env.MODEL_AMPERSAND_CHANNEL;
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

// A model's answer, as the SDK hands it over.
function answer(content: unknown[]): Anthropic.Message {
  return { id: "msg_1", type: "message", role: "assistant", model: "m", content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
}

async function main() {
  // ── 1 — the rule ─────────────────────────────────────────────────────────
  for (const [written, meant, why] of [
    ['Expand "Add login &amp; notes (optional)"', 'Expand "Add login & notes (optional)"', "run #298's label"],
    ["Terms &amp; Conditions", "Terms & Conditions", "joblander.app #209"],
    ["Save &amp; start watching", "Save & start watching", "the discovery click of the same run"],
    ["AT&amp;T &amp; Co", "AT&T & Co", "every ampersand escaped, each one level"],
    // meetbashar.com #216: the page really shows "&gt;&gt;" and "&#39;" as text — that is the finding.
    ["&amp;gt;&amp;gt; And they weren&amp;#39;t ready", "&gt;&gt; And they weren&#39;t ready", "a quote of entity text the page shows keeps that text exactly"],
    ["A &amp;amp; B", "A &amp; B", "a page that shows a literal &amp;, quoted by a model that escapes: one level, not two"],
    // Not escaping: the model wrote its ampersands bare, so an entity beside one is a quote.
    ["Terms & Conditions shows 'Tom &amp; Jerry'", "Terms & Conditions shows 'Tom &amp; Jerry'", "beside a bare &, an &amp; is something it quoted"],
    ["R&D page: the heading reads &amp;", "R&D page: the heading reads &amp;", "the same, with the bare & inside a word"],
    ["a && b &amp; c", "a && b &amp; c", "the same, in code"],
    // Nothing of the model's own to take off.
    ["The panel renders &gt;&gt; and &#39; as text", "The panel renders &gt;&gt; and &#39; as text", "other entities are never decoded"],
    ["Tom & Jerry", "Tom & Jerry", "a bare ampersand"],
    ["", "", "nothing"],
    ["&amp", "&amp", "not an entity without its semicolon"],
  ] as const) {
    const got = ownWords(written);
    check(`rule: ${why}`, got === meant, `${JSON.stringify(written)} → ${JSON.stringify(got)}`);
  }

  // ── 2 — string by string ─────────────────────────────────────────────────
  const input = { role: "button", name: "Add login &amp; notes (optional)", nth: 2, exact: true, more: [{ label: "Q&A shows &amp;" }, "B &amp; C", null] };
  const cleaned = ownWordsDeep(input);
  check("a tool call's input: each string judged on its own, everything else as it was",
    JSON.stringify(cleaned) === JSON.stringify({ role: "button", name: "Add login & notes (optional)", nth: 2, exact: true, more: [{ label: "Q&A shows &amp;" }, "B & C", null] }),
    JSON.stringify(cleaned));
  check("…and the model's own object is not written over", input.name === "Add login &amp; notes (optional)");
  const structured = '{"journeys":[{"title":"Terms &amp; Conditions","note":"R&D shows &amp; in the heading"}],"count":2}';
  check("a structured answer: one field's bare & says nothing about another's",
    ownWordsInAnswer(structured) === '{"journeys":[{"title":"Terms & Conditions","note":"R&D shows &amp; in the heading"}],"count":2}', ownWordsInAnswer(structured));
  check("prose is judged line by line",
    ownWordsInAnswer("Opened Terms &amp; Conditions.\nThe R&D page shows &amp; in its heading.") === "Opened Terms & Conditions.\nThe R&D page shows &amp; in its heading.");
  check("prose that only starts like JSON is still prose", ownWordsInAnswer("{not json} A &amp; B") === "{not json} A & B");

  // ── 3 — a whole answer ───────────────────────────────────────────────────
  const thinking = { type: "thinking", thinking: "The button is called Add login &amp; notes.", signature: "sig-abc" };
  const message = answer([
    thinking,
    { type: "text", text: "I'll expand Add login &amp; notes." },
    { type: "tool_use", id: "toolu_1", name: "click", input: { role: "button", name: "Add login &amp; notes (optional)" } },
  ]);
  const own = inOwnWords(message);
  const blocks = own.content as unknown as Record<string, unknown>[];
  check("an answer: the tool call's input and the text are in the model's own words",
    (blocks[2].input as { name: string }).name === "Add login & notes (optional)" && blocks[1].text === "I'll expand Add login & notes." && blocks[2].id === "toolu_1");
  check("an answer: a thinking block is the very object that came — it is signed, and it is sent back", blocks[0] === (thinking as unknown));
  const plain = answer([{ type: "text", text: "Tom & Jerry" }, { type: "tool_use", id: "t", name: "read_page", input: {} }]);
  check("an answer with nothing to take off is returned as it came", inOwnWords(plain) === plain);

  // ── 4 — every answer passes through it ───────────────────────────────────
  const through = await createWithRetry(async () => message);
  check("createWithRetry hands back the answer in the model's own words",
    ((through.content as unknown as Record<string, unknown>[])[2].input as { name: string }).name === "Add login & notes (optional)");
  // The verdict's model answers by another road (createOnRoutes — synthesis
  // and the bottom line's rewrite), which the first version of this change
  // missed (Codex on #257): its findings and bottom lines kept the escaping.
  const verdict = answer([{ type: "text", text: '{"bottomLine":"Sign-up &amp; billing work.","findings":[{"title":"Terms &amp; Conditions link is dead","quote":"R&D shows &amp;"}]}' }]);
  const routed = await createOnRoutes([{ model: "m", client: { messages: { create: async () => verdict } } } as never], { max_tokens: 1, messages: [] });
  check("createOnRoutes hands back the verdict model's answer in its own words too",
    (routed.message.content as unknown as { text: string }[])[0].text === '{"bottomLine":"Sign-up & billing work.","findings":[{"title":"Terms & Conditions link is dead","quote":"R&D shows &amp;"}]}',
    (routed.message.content as unknown as { text: string }[])[0].text);
  // One level means once: an answer that somehow meets both boundaries keeps
  // a page's literal "&amp;".
  const quoted = inOwnWords(answer([{ type: "text", text: "The heading reads A &amp;amp; B" }]));
  const twice = inOwnWords(await createWithRetry(async () => quoted));
  check("an answer passed through twice loses one level, not two", (twice.content as unknown as { text: string }[])[0].text === "The heading reads A &amp; B",
    (twice.content as unknown as { text: string }[])[0].text);
  // …and nothing calls a model any other way: every messages.create in the
  // codebase is inside one of the two. Searched in every source file, not in
  // the two I happened to think of.
  const sources = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file));
  const loose: string[] = [];
  let calls = 0;
  for (const file of sources) {
    const text = readFileSync(join(process.cwd(), "src", file), "utf8");
    for (const match of text.matchAll(/\.messages\.create\(/g)) {
      calls++;
      const before = text.slice(Math.max(0, match.index - 160), match.index);
      const viaRetry = /createWithRetry\(\s*(?:async\s*)?\(\)\s*=>\s*[\w.]*$/.test(before);
      const viaRoutes = /inOwnWords\(await route\.client$/.test(before);
      if (!viaRetry && !viaRoutes) loose.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  check("every model call in the codebase answers through one of the two boundaries", calls >= 5 && loose.length === 0, `${calls} calls; outside: ${loose.join(", ") || "none"}`);

  // ── 5 — the click that failed, and the step that was stored ──────────────
  const browser = await launch();
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE }));
    const page: Page = await context.newPage();
    const written: ReportedStep[] = [];
    const env = {
      page, targetOrigin: SITE, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [],
      onReportStep: async (step: ReportedStep) => { written.push({ ...step }); },
    } as unknown as ToolEnv;
    await prepareAgentPage(env);
    await executeTool(env, "navigate", { url: `${SITE}/` });
    const digest = await executeTool(env, "read_page", {});
    check("the page is read with a bare & — the escaping is not the page's", digest.includes("Add login & notes (optional)") && !digest.includes("&amp;"));

    const asWritten = { role: "button", name: "Add login &amp; notes (optional)" };
    const before = await executeTool(env, "click", asWritten);
    check("as the model wrote it, the click finds no such button (what run #298 met)",
      !before.startsWith("Clicked") && (await page.locator("#more").getAttribute("data-pressed")) === null, before.slice(0, 90));
    if (env.undrivenControls) env.undrivenControls.length = 0;

    const call = inOwnWords(answer([{ type: "tool_use", id: "toolu_2", name: "click", input: asWritten }]));
    const after = await executeTool(env, "click", (call.content as unknown as { input: Record<string, unknown> }[])[0].input);
    check("in the model's own words, the same call presses it", after.startsWith("Clicked") && (await page.locator("#more").getAttribute("data-pressed")) === "yes", after.slice(0, 90));

    const report = inOwnWords(answer([{ type: "tool_use", id: "toolu_3", name: "report_step", input: {
      label: 'Expand "Add login &amp; notes (optional)"', status: "ok",
      attempted: 'Clicked the "Add login &amp; notes (optional)" disclosure.', observed: "The panel opened and shows a Notes field.",
    } }]));
    await executeTool(env, "report_step", (report.content as unknown as { input: Record<string, unknown> }[])[0].input);
    check("the step is stored with the button's own name",
      written[0]?.label === 'Expand "Add login & notes (optional)"' && written[0]?.attempted === 'Clicked the "Add login & notes (optional)" disclosure.',
      JSON.stringify({ label: written[0]?.label, attempted: written[0]?.attempted }));
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nverify-model-ampersand: all checks passed" : `\nverify-model-ampersand: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
