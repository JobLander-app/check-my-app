import type { Browser, Page, Locator } from "@cloudflare/playwright";
import type { AgentEnv } from "./env";
import type { ToolEnv } from "./tools";
import { accountRejected, markAccountRejected, placeholderLabels, prepareAgentPage, scrubSecrets, normalizeFillValue, UNDRIVEN_INSTRUCTION } from "./tools";
import { DEFAULT_ACCOUNT_LABEL } from "@/lib/test-accounts";
import { assertExtensionIdentity, extensionCleanupComplete, extensionToolAllowed, gateExtensionStep, type ExtensionIdentity, type ExtensionRunnerInput, type ExtensionSession } from "./extension-contract";
import type { ExtensionRunner } from "./extension-runner";
import { ExtensionRuntimeError, extensionOperation } from "./extension-error";
import type { ExtensionFinalEvidence } from "./extension-evidence";
import { extensionReplaySpec, type ExtensionReplayAction, type NativeReplayControl } from "./extension-replay";
import type { RecordedAction } from "./tools";

const sessions = new WeakMap<Browser, ExtensionBrowser>();
export const extensionBrowserFor = (browser: Browser) => sessions.get(browser);

interface NativeNode { ref: string; name: string; role: string; editable: boolean; protected: boolean; enabled?: boolean; placeholder?: string }

// The popup and page are two mutually exclusive connections. Opening another
// inspector while Chrome's native popup is active changes lastFocusedWindow
// and breaks tabCapture even though login/read still appear to work.
export class ExtensionBrowser {
  browser!: Browser;
  page!: Page;
  popup = false;
  private nodes: NativeNode[] = [];
  private credentialFilled = false;
  private pendingReason?: "missing_access" | "our_capability";
  private finishPromise?: Promise<void>;
  private productReads = new Set<string>();
  private replayActions: ExtensionReplayAction[] = [];
  private constructor(private runner: DurableObjectStub<ExtensionRunner>, readonly identity: ExtensionSession) {}

  static async open(env: AgentEnv, input: ExtensionRunnerInput, expected?: ExtensionIdentity): Promise<ExtensionBrowser> {
    if (!env.bindings.EXTENSION_RUNNER) throw new Error("internal: extension executor binding is unavailable");
    const runner = env.bindings.EXTENSION_RUNNER.getByName(input.ownerRunId);
    const identity = await runner.openSession(input);
    const session = new ExtensionBrowser(runner, identity);
    try {
      assertExtensionIdentity(identity, expected);
      await session.connectPage();
      return session;
    } catch (error) { await runner.expire(); throw error; }
  }

  async call<T>(path: string, input?: unknown): Promise<T> {
    return extensionOperation(async signal => {
      const response = await this.runner.fetch(new Request(`http://runner${path}`, {
        signal,
        method: input === undefined ? "GET" : "POST",
        ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
      })).catch(() => { throw new ExtensionRuntimeError("The owned extension executor disconnected"); });
      if (!response.ok) {
        const message = `Extension operation unavailable: ${(await response.text()).slice(0, 300)}`;
        if (response.status === 410 || response.status >= 500) throw new ExtensionRuntimeError(message);
        throw new Error(message);
      }
      return response.json<T>();
    }, path === "/session/observe" ? 45_000 : 120_000);
  }

  private async connectPage(env?: ToolEnv): Promise<void> {
    const { connect } = await import("@cloudflare/playwright");
    const endpoint = { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.runner.fetch(new Request(input, init)) };
    const options = { sessionId: this.identity.sessionId, persistent: true };
    this.browser = await connect(endpoint, options);
    sessions.set(this.browser, this);
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Extension profile context is unavailable");
    const root = await this.browser.newBrowserCDPSession();
    try {
      const { targetInfo } = await root.send("Target.getTargetInfo", { targetId: this.identity.targetTabId });
      const candidates = context.pages().filter(page => page.url() === targetInfo.url && !page.url().startsWith("chrome-extension:"));
      let selected: Page | undefined;
      for (const candidate of candidates) {
        const channel = await context.newCDPSession(candidate);
        try {
          if ((await channel.send("Target.getTargetInfo")).targetInfo.targetId === this.identity.targetTabId) selected = candidate;
        } finally { await channel.detach(); }
      }
      if (!selected) throw new Error("The owned extension target tab is unavailable");
      this.page = selected;
      if (env) { env.page = selected; await prepareAgentPage(env); }
    } finally { await root.detach(); }
  }

  async tool(env: ToolEnv, name: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (name === "report_step" && this.pendingReason) {
      gateExtensionStep(input, this.pendingReason);
      this.pendingReason = undefined;
    }
    if (!name.startsWith("extension_")) {
      if (!this.popup && !this.browser.isConnected()) await this.restorePage(env);
      if (this.popup && ["navigate", "read_page", "click", "fill", "screenshot"].includes(name)) return "The native popup is active. Use extension_read / extension_click / extension_fill, or extension_close to return to its target tab.";
      if (name === "verify_links" && (input.urls as string[] | undefined)?.some(url => !env.knownUrls?.has(url))) return "These URLs were not observed in the extension. No product observation was made.";
      if (this.syntheticCompanion && ["read_page", "screenshot", "navigate"].includes(name)) {
        if (name === "navigate") return "The companion tab is already open. Its page is a test input, not a product surface.";
        const panel = this.page.locator("#joblander-extension-host").locator("#joblander-extension-root");
        if (this.identity.extensionId !== "hafhjepjihcimcljkdphpinannbdmnhf" || !await panel.count() || !await panel.isVisible()) return "No extension-owned panel is visible on the companion tab. Use extension_open to inspect the product controls.";
        if (name === "screenshot") return JSON.stringify({ ...await this.publishScreenshot(env, await panel.screenshot(), input), surface: "extension-panel" });
        const text = scrubSecrets(env, await panel.innerText());
        this.rememberProductRead({ surface: "extension-panel", text });
        return JSON.stringify({ surface: "extension-panel", text });
      }
      return undefined;
    }
    if (!extensionToolAllowed(this.identity, name)) return "This action is outside the current scenario. Continue with the tools available for this journey.";
    try {
      let result: unknown;
      if (name === "extension_open") {
        if (!this.popup) {
          const state = await this.call<{ running: boolean; session: { sessions: Array<{ state: string }>; billing?: { assessment?: unknown } } }>("/state");
          if (state.session.sessions.some(s => s.state !== "stopped") || state.session.sessions.length > 0 && !state.session.billing?.assessment) {
            return "The owned session or its minute accounting is still active. Use extension_observe_session until complete before reopening the popup.";
          }
          await this.browser.close();
          result = await this.call("/popup", { targetId: this.identity.targetTabId });
          this.popup = true;
          this.replayActions.push({ kind: "open" });
        }
        result = await this.read(env);
      } else if (name === "extension_close") {
        if (this.popup) {
          await this.call("/popup/close", {});
          this.popup = false;
          this.nodes = [];
          this.replayActions.push({ kind: "close" });
          await this.connectPage(env);
        } else if (!this.browser.isConnected()) await this.restorePage(env);
        result = { surface: "target-tab", url: this.page.url() };
      } else if (name === "extension_read") result = await this.read(env);
      else if (name === "extension_click" || name === "extension_fill") {
        const node = this.nodes.find(n => n.ref === input.ref);
        if (!node || !this.popup) throw new Error("Read the native popup to obtain a current control reference");
        // A request for the known Start control has an available owned action.
        // Routing it there is not a failed product interaction: carrying that
        // refusal into report_step marked a later confirmed Start as skipped.
        if (name === "extension_click" && this.identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf" && node.name === "Show JobLander Insights") {
          return extensionToolAllowed(this.identity, "extension_start_session")
            ? "Use extension_start_session to start interview assistance with its Stop limit."
            : "This scenario does not include starting interview assistance.";
        }
        // CHE-322: an extension signs in with the one default account — the
        // runner's replay can reproduce no other (extension-replay.ts), and no
        // named account is ever snapshotted onto an extension run.
        const defaultRejected = accountRejected(env.credentials, DEFAULT_ACCOUNT_LABEL);
        if (name === "extension_click" && defaultRejected && /log.?in|sign.?in/i.test(node.name)) return this.missingAccess("The saved credentials were already rejected. This step requires missing_access.");
        let value = normalizeFillValue(String(input.value ?? ""));
        const recordedValue = scrubSecrets(env, value);
        const credential = name === "extension_fill" && placeholderLabels(value).length > 0;
        if (credential) {
          if (placeholderLabels(value).some(l => l !== DEFAULT_ACCOUNT_LABEL)) return this.missingAccess("Extension checks sign in with the default test account only. Use {{TEST_EMAIL}} / {{TEST_PASSWORD}}.");
          if (defaultRejected) return this.missingAccess("The saved credentials were already rejected. This step requires missing_access.");
          if ((value.includes("{{TEST_EMAIL}}") && !env.testEmail) || (value.includes("{{TEST_PASSWORD}}") && !env.testPassword)) return this.missingAccess("Test credentials are missing. Skip this step with missing_access; do not submit an empty sign-in form.");
          // The runner binds this field to the exact installed extension URL;
          // URL.origin === 'null' must never authorize credential substitution.
          value = value.replaceAll("{{TEST_EMAIL}}", env.testEmail ?? "").replaceAll("{{TEST_PASSWORD}}", env.testPassword ?? "");
          this.credentialFilled = true;
        }
        this.nodes = this.nodes.filter(n => n.ref !== node.ref);
        result = await this.call("/popup/action", { ref: input.ref, operation: name === "extension_fill" ? "fill" : "click", ...(name === "extension_fill" ? { value, credential } : {}) });
        const control: NativeReplayControl = { role: node.role, name: node.name, editable: Boolean(node.editable), protected: Boolean(node.protected) };
        this.replayActions.push(name === "extension_fill" ? { kind: "native-fill", control, value: recordedValue } : { kind: "native-click", control });
        const surface = { kind: "native_popup" as const, extensionId: this.identity.extensionId, targetId: this.identity.targetTabId };
        const urlAfter = `chrome-extension://${this.identity.extensionId}/${this.identity.popupPath}`;
        env.actionTrail?.push(name === "extension_fill"
          ? { kind: "fill", label: node.name || node.role, value: recordedValue, surface, outcome: { urlAfter } }
          : { kind: "click", role: node.role, name: node.name, surface, outcome: { urlAfter, navigated: null, requests: null, mutations: null } });
      } else if (name === "extension_audio_preflight") {
        if (this.popup) return "Close the native popup before checking the audio fixture.";
        const preflight = await this.call<{ passed: boolean }>("/fixture/preflight", {});
        result = { ready: preflight.passed, evidenceType: "test-input-only" };
        if (preflight.passed) this.replayActions.push({ kind: "audio" });
      } else if (name === "extension_account_preflight") {
        if (this.popup) return "Close the native popup before opening the account balance.";
        if (!env.testEmail || !env.testPassword || accountRejected(env.credentials, DEFAULT_ACCOUNT_LABEL)) return this.missingAccess("Valid test-account access is required for the balance and session history.");
        result = await this.call("/account/preflight", { email: env.testEmail, password: env.testPassword });
        if ((result as { credentialRejected?: boolean }).credentialRejected) {
          if (markAccountRejected(env, DEFAULT_ACCOUNT_LABEL)) await env.onCredentialRejected?.("account sign-in: explicit credential rejection", DEFAULT_ACCOUNT_LABEL);
          return this.missingAccess("The saved test account credentials were rejected. Account access is required to continue.");
        }
        this.rememberProductRead(result);
        const practice = (result as { practice?: unknown }).practice;
        if (practice) this.rememberProductRead(practice);
        this.replayActions.push({ kind: "account" });
        result = { minutesAvailable: (result as { balance: number }).balance, sessionHistory: "visible" };
      } else if (name === "extension_screenshot") {
        if (!this.popup) return "Use screenshot for the target tab, or open the native popup first.";
        const buffer = await extensionOperation(async signal => {
          const response = await this.runner.fetch(new Request("http://runner/popup.png", { signal }));
          if (!response.ok) throw new Error("A redacted native screenshot is unavailable");
          return Buffer.from(await response.arrayBuffer());
        }, 45_000);
        result = await this.publishScreenshot(env, buffer, input);
      } else if (name === "extension_start_session") {
        if (!this.identity.allowSessions) return this.missingAccess("Session-start permission and a test account are required for this step. It remains skipped with missing_access.");
        if (!this.popup) return "Open the native popup on the target tab before starting its session.";
        result = await this.call("/session/start", {});
        this.replayActions.push({ kind: "start" });
        result = { started: true, session: "Interview assistance is active." };
        this.popup = false;
        await this.connectPage(env);
      } else if (name === "extension_prepare_practice") {
        if (this.popup) return "Close the extension popup before preparing the practice page.";
        result = await this.call("/practice/preflight", {});
        this.rememberProductRead(result);
        this.replayActions.push({ kind: "practice-prepare" });
      } else if (name === "extension_start_practice") {
        if (!this.identity.allowSessions) return this.missingAccess("Session-start permission and a test account are required for practice.");
        if (this.popup) return "Close the extension popup before starting practice.";
        result = await this.call("/practice/start", {});
        this.replayActions.push({ kind: "practice-start" });
        result = { started: true, session: "Practice is active with the microphone on." };
      } else if (name === "extension_observe_session") {
        result = await this.call("/session/observe", {});
        const terminal = (result as { complete?: boolean }).complete === true;
        const previous = this.replayActions.at(-1);
        if (previous?.kind === "observe") previous.terminal ||= terminal;
        else this.replayActions.push({ kind: "observe", terminal });
        this.rememberProductRead({ surface: "extension-panel", ...result as object });
        result = this.sessionReading(result);
      } else if (name === "extension_stop_sessions") {
        await this.browser.close();
        await this.call("/popup/close", {});
        this.popup = false;
        result = await this.call("/session/stop", { minimumSeconds: 120 });
        const deferred = (result as { deferred?: boolean }).deferred === true;
        if (!deferred) this.replayActions.push({ kind: "stop" });
        result = { ...this.sessionReading(result), ...(deferred ? { observation: "The two-minute observation window is still active. Use extension_observe_session before ending the session." } : {}) };
        await this.connectPage(env);
      } else return "Unknown extension tool";
      return scrubSecrets(env, JSON.stringify(result));
    } catch (error) {
      if (error instanceof ExtensionRuntimeError) throw error;
      if (!this.popup && !this.browser.isConnected()) await this.restorePage(env);
      const reason = error instanceof Error ? error.message : String(error);
      this.pendingReason = "our_capability";
      env.undrivenControls?.push({ hand: name === "extension_fill" ? "fill" : "click", target: "extension control", reason });
      return scrubSecrets(env, `${reason}. The extension control ${UNDRIVEN_INSTRUCTION}`);
    }
  }

  private async publishScreenshot(env: ToolEnv, buffer: Buffer, input: Record<string, unknown>) {
    const wanted = env.visionScreenshots || (env.visionTriggers && input.look === true);
    if (wanted) env.pendingScreenshotPngB64 = buffer.toString("base64");
    return { screenshotUrl: await env.onScreenshot?.(buffer) ?? null, ...(wanted ? { imageAttached: true } : {}) };
  }

  private sessionReading(raw: unknown) {
    const view = raw as { sessions: Array<{ name: string; state: string; elapsedSeconds?: number; applicationStopObserved: boolean }>;
      questionAndAnswers: unknown[]; practiceConversation?: unknown[]; minuteAccounting: string; minutesUsed?: number; complete: boolean; runtimeFailed?: boolean };
    if (view.runtimeFailed) throw new ExtensionRuntimeError("The owned extension runtime failed during session cleanup");
    return { sessions: view.sessions.map(s => `${s.name}: ${s.applicationStopObserved ? "ended with confirmation" : s.state}${s.elapsedSeconds === undefined ? "" : ` after ${s.elapsedSeconds} seconds`}.`),
      answers: view.questionAndAnswers,
      practiceConversation: view.practiceConversation ?? [],
      minutes: view.minuteAccounting === "confirmed" ? `${view.minutesUsed} minutes used. The balance remained unchanged after the session ended.` : view.complete ? "Minute-by-minute charges and final rounding were not confirmed. Report this accounting assertion as skipped; the final accounting step records its coverage gap." : "The account balance follow-up is still pending. Use extension_observe_session again.",
      complete: view.complete };
  }

  private async restorePage(env: ToolEnv): Promise<void> {
    const state = await this.call<{ running: boolean; session?: { popupTargetId?: string | null } }>("/state");
    if (!state.running || state.session?.popupTargetId) throw new ExtensionRuntimeError("The owned extension page connection cannot be restored");
    await this.connectPage(env).catch(() => { throw new ExtensionRuntimeError("The owned extension page connection could not be restored"); });
  }

  private missingAccess(message: string): string {
    this.pendingReason = "missing_access";
    return message;
  }

  private async read(env: ToolEnv) {
    const result = await this.call<{ nodes: NativeNode[] }>("/popup/read");
    this.nodes = result.nodes;
    const names = [...new Set(this.nodes.filter(n => !n.editable && !n.protected && /button|check box|combo box/.test(n.role))
      .map(n => scrubSecrets(env, n.name)).filter(name => name && !name.includes("{{") && !name.includes("[existing document]")))];
    if (names.length) this.replayActions.push({ kind: "native-expect", names });
    if (this.credentialFilled && this.nodes.some(n => /invalid (?:login|credentials|password|email)|incorrect (?:email|password)|wrong password|too many (?:attempts|requests)|auth\/(?:invalid-credential|wrong-password|user-not-found)/i.test(n.name))) {
      if (markAccountRejected(env, DEFAULT_ACCOUNT_LABEL)) await env.onCredentialRejected?.("native sign-in: explicit credential rejection", DEFAULT_ACCOUNT_LABEL);
    }
    this.rememberProductRead({ surface: "native-popup", controls: this.nodes.map(n => ({
      role: n.role, name: scrubSecrets(env, n.name || n.placeholder || ""), editable: n.editable, protected: n.protected, enabled: n.enabled,
    })) });
    if (this.identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf"
      && this.nodes.some(n => /^(?:Show|Showing) JobLander Insights$/.test(n.name))) this.identity.popupSignedIn = true;
    return {
      surface: "native-popup",
      url: `chrome-extension://${this.identity.extensionId}/${this.identity.popupPath}`,
      controls: this.nodes.map(n => `${n.ref} ${n.role} ${JSON.stringify(n.name || n.placeholder || "")}${n.editable ? " [editable]" : ""}${n.protected ? " [password]" : ""}${n.enabled === false ? " [disabled]" : ""}`),
    };
  }

  private get syntheticCompanion(): boolean { return this.identity.targetUrl === "http://127.0.0.1:9091/"; }

  private rememberProductRead(read: unknown): void {
    if (this.productReads.size < 60) this.productReads.add(JSON.stringify(read));
  }

  discoveryObservations(): string {
    return [...this.productReads].join("\n");
  }

  recordPageAction(action: RecordedAction): void { this.replayActions.push({ kind: "page", action }); }

  async exportSpec(title: string): Promise<string> {
    await this.finish();
    const final = await this.finalEvidence();
    return extensionReplaySpec(title, this.identity, this.replayActions, final.session?.productResult?.confirmed === true,
      final.session?.billing?.assessment?.status === "confirmed" && final.session.billing.assessment.twoMinuteSteps === true);
  }

  async guardClick(target: Locator): Promise<string | null> {
    const fixtureRefusal = await this.guardFixtureControl(target);
    if (fixtureRefusal) return fixtureRefusal;
    // Resolve the actual DOM control, including labels and nested icons, so a
    // CSS selector cannot bypass the session ledger by omitting its name.
    const { label, practiceControl } = await target.evaluate(el => {
      const control = el.closest("button,label,[role=button],[role=checkbox]") ?? el;
      const label = [control.textContent, control.getAttribute("aria-label"), control.getAttribute("title")].filter(Boolean).join(" ").trim();
      return { label,
        practiceControl: control.getRootNode() === document && (control.getAttribute("role") === "checkbox" || control.matches("input[type=checkbox]") || control.tagName === "BUTTON" && !label),
      };
    });
    const onPractice = this.identity.targetUrl.startsWith("https://joblander.app/") && /\/practice\/?$/.test(new URL(this.identity.targetUrl).pathname);
    if (onPractice && practiceControl || /\b(start|begin|record|capture|insights|practice|end session|stop session)\b/i.test(label)) {
      this.pendingReason = this.identity.allowSessions ? "our_capability" : "missing_access";
      return "Session controls require extension_start_session / extension_start_practice / extension_stop_sessions and their owned Stop sequence.";
    }
    return null;
  }

  async guardFixtureControl(target: Locator): Promise<string | null> {
    if (!this.syntheticCompanion) return null;
    const owned = this.identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf" && await target.evaluate(el => {
      let root = el.getRootNode();
      while (root instanceof ShadowRoot) {
        if (root.host.id === "joblander-extension-host") return true;
        root = root.host.getRootNode();
      }
      return false;
    });
    if (owned) return null;
    this.pendingReason = "our_capability";
    return "The selected control belongs to the test input, not to the extension.";
  }

  async finish(): Promise<void> {
    this.finishPromise ??= this.dispose();
    return this.finishPromise;
  }
  async finalEvidence(): Promise<ExtensionFinalEvidence> { return this.runner.finalEvidence(); }
  private async dispose(): Promise<void> {
    await this.browser?.close().catch(() => {});
    await this.runner.expire();
    const final = await this.runner.finalEvidence();
    if (!final.disposed || !final.session || !extensionCleanupComplete(final.session)) throw new ExtensionRuntimeError("The owned extension session cleanup is unverified; no verdict may be published");
    if (final.session.runtimeFailure) throw new ExtensionRuntimeError("The owned extension browser ended before cleanup; no verdict may be published");
  }
}
