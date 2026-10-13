// CHE-464: one team's Shopify session browser, in a Cloudflare Container.
//
// Until now every Shopify check ran in one Chrome on one GCP VM, signed in by
// a person (spikes/shopify-session). CHE-461 measured the way out: the
// sign-in is three `.shopify.com` cookies, and those open the admin in a
// fresh Chrome on any machine and any address. So each team gets a Durable
// Object (named by its id) holding the team's cookie jar, and a container
// running the session host's stack (spikes/shopify-session/runner.mjs): the
// same session server and gate (lease.mjs), the same live view (viewer.mjs),
// the same probe (probe.mjs). The account's container limits are the only
// ceiling on how many teams check at once.
//
// What this object owns:
//   - the container's bearer, new for every start, so nothing but this object
//     reaches the session server;
//   - the team's jar, sealed with SESSION_JAR_KEY: put into every fresh Chrome
//     before anything is let through, read back after every check, probe and
//     sign-in. A jar with no sign-in in it never replaces one that has it;
//   - the hourly probe (`schedule`), whose line goes to D1 SessionProbe and,
//     on the way down from ok, to the owner's chat — the host's probe.jsonl
//     and Telegram rules (classify.mjs shouldNotify), per team.
//
// What it lets through from the Worker (`fetch`): the session server's /state,
// /lease and DevTools socket, for the agent (session-browser.ts), and the live
// view's socket, for a person on the sign-in page (routeLiveView below). The
// jar, the readiness and the probe routes are its own.
//
// Cookie values never leave this object and the container, and are never
// logged: what is said about a jar is jar-rules.mjs describeJar.

import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { AgentBindings } from "./env";
import { sendDeps } from "./signed-out";
import { AlreadySentError, sendRecorded } from "@/lib/telegram-send";
import { viewKeyFor } from "@/lib/session-view";
import { describeJar, holdsSignIn, jarOf } from "../../spikes/shopify-session/jar-rules.mjs";
import { shouldNotify } from "../../spikes/shopify-session/classify.mjs";
import { SESSION_TEAM_HEADER, SESSION_TEAM_ID } from "./session-address";
import { hex, openJar, probeMessage, proxyForTeam, sealJar, viewOrigin, type Cookie, type ProbeLine } from "./session-jar";

const SERVER_PORT = 9090;
const VIEW_PORT = 9091;
export const PROBE_EVERY_SECONDS = 60 * 60;

interface SealedJar {
  iv: string;
  data: string;
  savedAt: number;
  count: number;
  reason: string;
}
interface Ready {
  jarLoaded: boolean;
  lease: boolean;
  connected: boolean;
  person: boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

export class SessionRunner extends Container<AgentBindings> {
  defaultPort = SERVER_PORT;
  requiredPorts = [SERVER_PORT, VIEW_PORT];
  // A check's phases are minutes apart at most; the person's sign-in and a
  // check's DevTools socket keep it awake on their own (open sockets count).
  sleepAfter = "15m";
  private bringingUp?: Promise<string>;

  // ── what the Worker may ask ──

  override async fetch(request: Request): Promise<Response> {
    const team = request.headers.get(SESSION_TEAM_HEADER) ?? "";
    if (!(await this.claim(team))) return Response.json({ error: "Not this team's browser" }, { status: 403 });
    const url = new URL(request.url);
    const view = url.pathname === "/v1/view";
    const allowed = view || url.pathname === "/lease" || url.pathname === "/state" || /^\/v1\/devtools\/browser\/[^/]+$/.test(url.pathname);
    if (!allowed) return new Response(null, { status: 404 });
    let token: string;
    try {
      token = await this.bringUp(team);
    } catch (error) {
      console.error(`[session-runner] could not start the browser: ${message(error)}`);
      return Response.json({ error: "The session browser could not start" }, { status: 503 });
    }
    const headers = new Headers(request.headers);
    headers.delete(SESSION_TEAM_HEADER);
    // The live view's own gate is the person's view token; everything else is
    // ours, with this start's bearer.
    if (view) headers.delete("Authorization");
    else headers.set("Authorization", `Bearer ${token}`);
    const response = await this.containerFetch(new Request(request, { headers }), view ? VIEW_PORT : SERVER_PORT);
    // A check gave the browser back: what it left in the jar (Shopify
    // re-issues the session on every admin load) is the team's now.
    if (request.method === "DELETE" && url.pathname === "/lease" && response.ok) this.ctx.waitUntil(this.saveJar("release"));
    // A person is in: their sign-in is saved while they are, and once after.
    if (view && response.status === 101) this.ctx.waitUntil(this.watchSignIn());
    return response;
  }

  // The team's jar from elsewhere (the VM's Chrome, moving the live sign-in —
  // scripts/session-jar-import.mjs). Only a jar that holds a sign-in.
  async importJar(team: string, cookies: unknown): Promise<{ saved: number; loaded: boolean }> {
    if (!(await this.claim(team))) throw new Error("Not this team's browser");
    const jar = jarOf(cookies) as Cookie[];
    if (!holdsSignIn(jar)) throw new Error("The jar holds no sign-in");
    await this.keepJar(team, jar, "import");
    let loaded = false;
    const token = await this.ctx.storage.get<string>("token");
    if (token && this.ctx.container?.running) {
      await this.server(token, "PUT", "/jar", { cookies: jar });
      loaded = true;
    }
    await this.scheduleProbe(30);
    console.log(`[session-runner] jar imported: ${JSON.stringify(describeJar(jar))}`);
    return { saved: jar.length, loaded };
  }

  // Ours to read (the agent worker's /session/state): never a value.
  async describe(team: string): Promise<Record<string, unknown>> {
    if (!(await this.claim(team))) throw new Error("Not this team's browser");
    const sealed = await this.ctx.storage.get<SealedJar>("jar");
    const token = await this.ctx.storage.get<string>("token");
    const running = this.ctx.container?.running ?? false;
    const ready = running && token ? await this.readyState(token).catch(() => null) : null;
    const probes = await this.listSchedules("probe");
    return {
      team,
      running,
      ready,
      jar: sealed ? { savedAt: new Date(sealed.savedAt).toISOString(), count: sealed.count, reason: sealed.reason } : null,
      nextProbe: probes[0] ? new Date(probes[0].time * 1000).toISOString() : null,
    };
  }

  // The scheduler's tick: a team with a jar always has its next probe.
  async ensureProbe(team: string): Promise<boolean> {
    if (!(await this.claim(team))) return false;
    if (!(await this.ctx.storage.get("jar"))) return false;
    if ((await this.listSchedules("probe")).length > 0) return true;
    await this.scheduleProbe(60);
    return true;
  }

  // ── the hourly probe ──

  async probe(): Promise<void> {
    const team = await this.ctx.storage.get<string>("team");
    if (!team || !(await this.ctx.storage.get("jar"))) return;
    try {
      const app = await this.probeTarget(team);
      if (!app) return;
      const wasRunning = this.ctx.container?.running ?? false;
      let line: ProbeLine;
      try {
        const token = await this.bringUp(team);
        line = await this.server<ProbeLine>(token, "POST", "/probe", { url: app.url }, 240_000);
        await this.saveJar("probe");
        // Woken only for this: back to sleep, unless a check or a person
        // came in meanwhile.
        if (!wasRunning) {
          const ready = await this.readyState(token).catch(() => null);
          if (ready && !ready.lease && !ready.connected && !ready.person) await this.stop();
        }
      } catch (error) {
        line = { at: new Date().toISOString(), state: "error", url_host: null, url_path: null, ms: 0, detail: message(error) };
      }
      await this.record(team, app, line);
    } catch (error) {
      console.error(`[session-runner] probe failed: ${message(error)}`);
    } finally {
      await this.scheduleProbe(PROBE_EVERY_SECONDS);
    }
  }

  private async scheduleProbe(seconds: number): Promise<void> {
    this.deleteSchedules("probe");
    await this.schedule(seconds, "probe");
  }

  // The team's Shopify app to look at: its first, as the host looked at ours.
  private async probeTarget(team: string): Promise<{ appId: string; url: string } | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, targetUrl FROM App WHERE teamId = ? AND targetKind = 'session' AND targetUrl LIKE 'https://admin.shopify.com/store/%/apps/%' ORDER BY createdAt ASC LIMIT 1",
    )
      .bind(team)
      .first<{ id: string; targetUrl: string }>();
    return row ? { appId: row.id, url: row.targetUrl } : null;
  }

  private async record(team: string, app: { appId: string }, line: ProbeLine): Promise<void> {
    const rows = await this.env.DB.prepare("SELECT state, notified FROM SessionProbe WHERE teamId = ? ORDER BY at DESC LIMIT 48").bind(team).all<{ state: string; notified: number | null }>();
    const history = (rows.results ?? []).reverse().map((row) => ({ state: row.state, notified: row.notified === 1 }));
    let notified: boolean | null = null;
    let notifyError: string | null = null;
    if (shouldNotify(history, line.state)) {
      notifyError = await this.tell(team, app.appId, line);
      notified = notifyError === null;
    }
    await this.env.DB.prepare(
      "INSERT INTO SessionProbe (id, teamId, appId, at, state, urlHost, urlPath, ms, challenge, detail, proxyStatus, notified, notifyError) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        `sp${Date.now().toString(36)}${randomToken().slice(0, 10)}`,
        team,
        app.appId,
        line.at,
        line.state,
        line.url_host,
        line.url_path,
        Math.round(line.ms ?? 0),
        line.challenge ?? null,
        line.detail ?? null,
        line.proxy_status ?? null,
        notified === null ? null : notified ? 1 : 0,
        notifyError,
      )
      .run();
    console.log(`[session-runner] probe ${line.state}${notified !== null ? ` notified=${notified}` : ""}`);
  }

  // → null when the message went out (or had already), else why not.
  private async tell(team: string, appId: string, line: ProbeLine): Promise<string | null> {
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = this.env.OWNER_TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return "telegram not configured";
    const name = (await this.env.DB.prepare("SELECT name FROM Team WHERE id = ?").bind(team).first<{ name: string }>())?.name ?? team;
    const text = probeMessage(name, appId, line, this.env.APP_URL);
    try {
      const sent = await sendRecorded(sendDeps(this.env, token), chatId, text, `session-probe:${team}:${line.at}`);
      return sent.status === "sent" ? null : (sent.warning ?? "outcome unknown");
    } catch (error) {
      if (error instanceof AlreadySentError) return null;
      return message(error);
    }
  }

  // ── the browser ──

  private async claim(team: string): Promise<boolean> {
    if (!SESSION_TEAM_ID.test(team)) return false;
    const known = await this.ctx.storage.get<string>("team");
    if (known) return known === team;
    await this.ctx.storage.put("team", team);
    return true;
  }

  // The browser, started if it is not, and holding the team's jar. → this
  // start's bearer. One bring-up at a time: the calls that arrive meanwhile
  // wait for the same one.
  private bringUp(team: string): Promise<string> {
    this.bringingUp ??= this.bringUpOnce(team).finally(() => {
      this.bringingUp = undefined;
    });
    return this.bringingUp;
  }

  private async bringUpOnce(team: string): Promise<string> {
    let token = await this.ctx.storage.get<string>("token");
    const running = this.ctx.container?.running ?? false;
    if (!running || !token) {
      // A browser whose bearer this object does not hold is not ours to use.
      if (running) await this.destroy();
      token = randomToken();
      await this.ctx.storage.put("token", token);
      this.envVars = await this.environment(team, token);
      await this.startAndWaitForPorts({
        ports: [SERVER_PORT, VIEW_PORT],
        startOptions: { envVars: this.envVars },
        cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
      });
    }
    // A fresh Chrome has no cookies. The team's go in before anything else.
    const ready = await this.readyState(token);
    if (!ready.jarLoaded) {
      const sealed = await this.ctx.storage.get<SealedJar>("jar");
      let cookies: Cookie[] = [];
      if (sealed) {
        try {
          cookies = await openJar(this.env.SESSION_JAR_KEY, team, sealed);
        } catch (error) {
          // A jar that no longer opens is a team that signs in again.
          console.error(`[session-runner] the team's jar did not open: ${message(error)}`);
        }
      }
      await this.server(token, "PUT", "/jar", { cookies });
    }
    return token;
  }

  private async environment(team: string, token: string): Promise<Record<string, string>> {
    const out: Record<string, string> = { SESSION_SERVER_TOKEN: token, SESSION_SLOT: team, VIEW_ORIGINS: viewOrigin(this.env.APP_URL) };
    const viewSecret = this.env.SESSION_VIEW_SECRET?.trim();
    if (viewSecret) out.SESSION_VIEW_SECRET = await viewKeyFor(viewSecret, team);
    const proxy = await proxyForTeam(this.env.SESSION_PROXY_URL, team);
    if (proxy) out.PROXY_URL = proxy;
    return out;
  }

  private readyState(token: string): Promise<Ready> {
    return this.server<Ready>(token, "GET", "/ready", undefined, 10_000);
  }

  private async server<T>(token: string, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.containerFetch(
      new Request(`http://session${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }),
      SERVER_PORT,
    );
    if (!response.ok) throw new Error(`session server ${method} ${path}: HTTP ${response.status}`);
    return response.json<T>();
  }

  private async keepJar(team: string, jar: Cookie[], reason: string): Promise<void> {
    const sealed = await sealJar(this.env.SESSION_JAR_KEY, team, jar);
    await this.ctx.storage.put<SealedJar>("jar", { ...sealed, savedAt: Date.now(), count: jar.length, reason });
  }

  // The jar out of a running browser that was given the team's, kept when it
  // holds a sign-in. Never throws: a jar not saved now is saved next time.
  async saveJar(reason: string): Promise<void> {
    try {
      const team = await this.ctx.storage.get<string>("team");
      const token = await this.ctx.storage.get<string>("token");
      if (!team || !token || !this.ctx.container?.running) return;
      if (!(await this.readyState(token)).jarLoaded) return;
      const { cookies } = await this.server<{ cookies: Cookie[] }>(token, "GET", "/jar");
      const jar = jarOf(cookies) as Cookie[];
      if (!holdsSignIn(jar)) {
        console.log(`[session-runner] jar not kept (${reason}): no sign-in in it`);
        return;
      }
      await this.keepJar(team, jar, reason);
    } catch (error) {
      console.warn(`[session-runner] jar not kept (${reason}): ${message(error)}`);
    }
  }

  private async watchSignIn(): Promise<void> {
    this.deleteSchedules("viewSave");
    await this.schedule(60, "viewSave");
  }

  // Every minute while a person is in the browser, and once after they left.
  async viewSave(): Promise<void> {
    await this.saveJar("sign-in");
    const token = await this.ctx.storage.get<string>("token");
    const ready = token && this.ctx.container?.running ? await this.readyState(token).catch(() => null) : null;
    if (ready?.person) await this.schedule(60, "viewSave");
    else if (!(await this.listSchedules("probe")).length) await this.scheduleProbe(60);
  }

  // Asleep only when nobody is using it, and with the jar saved first.
  override async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) return;
    const token = await this.ctx.storage.get<string>("token");
    const ready = token ? await this.readyState(token).catch(() => null) : null;
    if (ready && (ready.lease || ready.connected || ready.person)) {
      this.renewActivityTimeout();
      return;
    }
    await this.saveJar("sleep");
    await this.stop();
  }

  override async onStop(params: StopParams): Promise<void> {
    console.log(`[session-runner] browser stopped: exitCode=${params.exitCode} reason=${params.reason}`);
  }

  override onError(error: unknown): unknown {
    console.error(`[session-runner] browser error: ${message(error)}`);
    return error;
  }
}


