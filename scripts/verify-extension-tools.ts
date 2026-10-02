import assert from "node:assert/strict";
import { ExtensionBrowser } from "../src/agent/extension-browser";
import { ExtensionRuntimeError } from "../src/agent/extension-error";
import { executeTool, browserToolsFor, type ToolEnv } from "../src/agent/tools";

async function main() {
const extension = Object.assign(Object.create(ExtensionBrowser.prototype), {
  identity: { extensionId: "hafhjepjihcimcljkdphpinannbdmnhf", targetUrl: "http://127.0.0.1:9091/" },
  browser: { isConnected: () => true }, popup: false, productReads: new Set<string>(),
}) as ExtensionBrowser;
let pageReads = 0;
const panel = { locator: () => panel, count: async () => 0, isVisible: async () => false };
const env = { extension, page: { locator: () => panel, evaluate: async () => { pageReads++; throw new Error("Fixture body must not be read"); } },
  knownUrls: new Set(["https://observed.example.test/help"]), networkLog: [], consoleLog: [],
} as unknown as ToolEnv;
extension.page = env.page;
assert.match(await executeTool(env, "read_page", {}), /No extension-owned panel/);
assert.match(await executeTool(env, "screenshot", {}), /No extension-owned panel/);
assert.equal(pageReads, 0, "Fixture text and screenshots are never product evidence");
assert.equal(extension.discoveryObservations(), "");
assert.match(await executeTool(env, "verify_links", { urls: ["https://guessed.example.test"] }), /not observed/);
assert.equal(await extension.tool(env, "verify_links", { urls: ["https://observed.example.test/help"] }), undefined);

Object.assign(extension, { browser: { isConnected: () => false }, runner: { fetch: async () => Response.json({ running: false }) } });
await assert.rejects(executeTool(env, "read_page", {}), ExtensionRuntimeError, "A disconnected owned browser aborts the loop instead of becoming a product result");
let restored = false;
Object.assign(extension, { runner: { fetch: async () => Response.json({ running: true, session: { popupTargetId: null } }) },
  connectPage: async () => { restored = true; extension.browser = { isConnected: () => true } as typeof extension.browser; } });
assert.match(await executeTool(env, "read_page", {}), /No extension-owned panel/);
assert.equal(restored, true, "A live owned browser can recover an interrupted page connection");
Object.assign(extension, { runner: { fetch: async () => Response.json({ running: true, session: { sessions: [{ state: "active" }] } }) } });
assert.match(await executeTool(env, "extension_open", {}), /extension_observe_session until complete/);
Object.assign(extension, { runner: { fetch: async () => new Response("gone", { status: 410 }) } });
await assert.rejects(executeTool(env, "extension_read", {}), ExtensionRuntimeError);
Object.assign(extension, { runner: { fetch: async () => { throw new Error("transport gone"); } } });
await assert.rejects(executeTool(env, "extension_read", {}), ExtensionRuntimeError);
Object.assign(extension, { browser: { isConnected: () => true }, popup: true,
  nodes: [{ ref: "native-start", role: "check box", name: "Show JobLander Insights", editable: false, protected: false }],
  identity: { extensionId: "hafhjepjihcimcljkdphpinannbdmnhf", scenario: "interview", allowSessions: true },
});
assert.match(await executeTool(env, "extension_click", { ref: "native-start" }), /Use extension_start_session/);
const reported = { status: "ok", observed: "Interview assistance is active." };
await extension.tool(env, "report_step", reported);
assert.equal(reported.status, "ok", "Routing to the available Start action does not taint a later confirmed step");
// CHE-401: a human-verification challenge in the extension's own popup is not
// pressed and not typed into — the native tools do not go through click/fill,
// so the refusal has to stand here too (Codex on #252). Nothing reaches the
// runner; an ordinary control beside it still does.
{
  let dispatched = 0;
  const before = { runner: extension.runner, nodes: extension.nodes, replayActions: extension.replayActions };
  Object.assign(extension, { replayActions: [], runner: { fetch: async () => { dispatched++; return Response.json({ ok: true }); } },
    nodes: [
      { ref: "n-human", role: "check box", name: "Verify you are human", editable: false, protected: false },
      { ref: "n-robot", role: "push button", name: "I'm not a robot", editable: false, protected: false },
      { ref: "n-captcha", role: "text", name: "Enter the characters you see in the image", editable: true, protected: false },
      { ref: "n-settings", role: "push button", name: "reCAPTCHA settings", editable: false, protected: false },
    ] });
  for (const [tool, ref] of [["extension_click", "n-human"], ["extension_click", "n-robot"], ["extension_fill", "n-captcha"]] as const) {
    const answer = await executeTool(env, tool, { ref, value: "x7Kp2" });
    assert.match(answer, /^Refused: .*human-verification challenge/, `${tool} ${ref}: ${answer}`);
    assert.match(answer, /our_capability/);
  }
  assert.equal(dispatched, 0, "A refused challenge control never reaches the runner");
  await executeTool(env, "extension_click", { ref: "n-settings" });
  assert.equal(dispatched, 1, "A product's own control about captchas is still pressed");
  Object.assign(extension, before);
}
const names = () => browserToolsFor(env).map(t => t.name);
assert.ok(names().includes("extension_start_session"));
assert.ok(!names().includes("extension_prepare_practice"));
assert.match(await executeTool(env, "extension_prepare_practice", {}), /outside the current scenario/);
Object.assign(extension.identity, { scenario: "practice" });
assert.ok(names().includes("extension_start_practice"));
assert.ok(!names().includes("extension_start_session"));
Object.assign(extension.identity, { allowSessions: false });
assert.ok(!names().some(name => ["extension_start_session", "extension_prepare_practice", "extension_start_practice"].includes(name)));
const unfinished = Object.assign(Object.create(ExtensionBrowser.prototype), { browser: { close: async () => {} }, runner: { expire: async () => {}, finalEvidence: async () => ({ disposed: true, session: { sessions: [{ state: "unverified" }] } }) } }) as ExtensionBrowser;
await assert.rejects(unfinished.finish(), ExtensionRuntimeError, "Unverified paid cleanup aborts the workflow without retrying the spent attempt");
let rejected = 0, accountCalls = 0;
Object.assign(extension, { popup: false, browser: { isConnected: () => true }, runner: { fetch: async () => { accountCalls++; return Response.json({ credentialRejected: true }); } } });
Object.assign(env, { testEmail: 'fixture@example.test', testPassword: 'fixture-password', credentials: { rejected: false }, onCredentialRejected: async () => { rejected++; } });
assert.match(await executeTool(env, 'extension_account_preflight', {}), /credentials were rejected/);
assert.match(await executeTool(env, 'extension_account_preflight', {}), /Valid test-account access/);
assert.equal(rejected, 1);
assert.equal(accountCalls, 1, 'Account rejection reaches the run-wide gate before another native call');
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => realTimeout(callback, Math.min(ms, 20), ...args)) as typeof setTimeout;
try {
  // The request itself is held, not just its signal. A Request's signal follows
  // the one it was built from through a listener the runtime drops once the
  // Request is collected, so a double that keeps only the signal is asserting
  // on garbage collection: CHE-245 failed here in 3 of 11 suite runs, never
  // alone. Holding the request is what a real transport does anyway.
  let signal: AbortSignal | undefined, held: Request | undefined;
  Object.assign(extension, { runner: { fetch: (request: Request) => { held = request; signal = request.signal; return new Promise(() => {}); } } });
  await assert.rejects(extension.call('/session/observe', {}), ExtensionRuntimeError, 'A transport ignoring AbortSignal must not hold the Workflow until its whole-phase deadline');
  assert.equal(held?.signal, signal);
  assert.equal(signal?.aborted, true, 'The cancel is issued before the caller is told, so a live request sees it');
  Object.assign(extension, { runner: { fetch: async (request: Request) => { held = request; signal = request.signal; return new Response(new ReadableStream({ start() {} })); } } });
  await assert.rejects(extension.call('/state'), ExtensionRuntimeError, 'The deadline covers an incomplete response body too');
  assert.equal(held?.signal, signal);
  assert.equal(signal?.aborted, true);
} finally { globalThis.setTimeout = realTimeout; }
Object.assign(extension, { popup: false, replayActions: [], browser: { isConnected: () => true },
  runner: { fetch: async () => Response.json({ runtimeFailed: true, complete: true, sessions: [] }) } });
Object.assign(extension.identity, { allowSessions: true, scenario: 'interview' });
await assert.rejects(executeTool(env, 'extension_observe_session', {}), ExtensionRuntimeError,
  'The native failure flag must abort immediately, even when the cleanup response is complete');
console.log("Extension tools: product-only observations, observed links and fatal runtime propagation pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
