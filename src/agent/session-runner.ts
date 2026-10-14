// CHE-464: one person's Shopify session browser in one team, in a Cloudflare
// Container.
//
// Until now every Shopify check ran in one Chrome on one GCP VM, signed in by
// a person (spikes/shopify-session). CHE-461 measured the way out: the
// sign-in is three `.shopify.com` cookies, and those open the admin in a
// fresh Chrome on any machine and any address. So each slot gets a Durable
// Object (named by the slot) holding its cookie jar, and a container running
// the session host's stack (spikes/shopify-session/runner.mjs): the same
// session server and gate (lease.mjs), the same live view (viewer.mjs), the
// same probe (probe.mjs). The account's container limits are the only ceiling
// on how many people check at once.
//
// CHE-482: a slot is one PERSON in one team (sessionSlot,
// src/lib/session-view.ts), not the team. A Shopify sign-in is a person's own
// account; with one browser per team, the second person to sign in replaced
// the first one's sign-in. A store is checked in the slot of whoever
// connected it — a dev store is that person's test account.
//
// What this object owns:
//   - the container's bearer, new for every start, so nothing but this object
//     reaches the session server;
//   - the slot's jar, sealed with SESSION_JAR_KEY: put into every fresh Chrome
//     before anything is let through, read back after every check, probe and
//     sign-in. A jar with no sign-in in it never replaces one that has it;
//   - the hourly probe (`schedule`), whose line goes to D1 SessionProbe and,
//     on the way down from ok, to the owner's chat — the host's probe.jsonl
//     and Telegram rules (classify.mjs shouldNotify), per person.
//
// What it lets through from the Worker (`fetch`): the session server's /state,
// /lease and DevTools socket, for the agent (session-browser.ts), and the live
// view's socket, for a person on the sign-in page (routeLiveView). The jar,
// the readiness and the probe routes are its own.
//
// Cookie values never leave this object and the container, and are never
// logged: what is said about a jar is jar-rules.mjs describeJar. The one
// exception is handOver, which gives a jar to another object of this class.

import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { AgentBindings } from "./env";
import { sendDeps } from "./signed-out";
import { AlreadySentError, sendRecorded } from "@/lib/telegram-send";
import { SESSION_SLOT, slotParts, viewKeyFor } from "@/lib/session-view";
import { describeJar, holdsSignIn, jarOf } from "../../spikes/shopify-session/jar-rules.mjs";
import { SESSION_SLOT_HEADER } from "./session-address";
import { hex, openJar, probeMessage, proxyForSlot, recordProbe, sealJar, viewOrigin, type Cookie, type ProbeLine } from "./session-jar";

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
    const slot = request.headers.get(SESSION_SLOT_HEADER) ?? "";
    if (!(await this.claim(slot))) return Response.json({ error: "Not this slot's browser" }, { status: 403 });
    const url = new URL(request.url);
    const view = url.pathname === "/v1/view";
    const allowed = view || url.pathname === "/lease" || url.pathname === "/state" || /^\/v1\/devtools\/browser\/[^/]+$/.test(url.pathname);
    if (!allowed) return new Response(null, { status: 404 });
    let token: string;
    try {
      token = await this.bringUp(slot);
    } catch (error) {
      console.error(`[session-runner] could not start the browser: ${message(error)}`);
      return Response.json({ error: "The session browser could not start" }, { status: 503 });
    }
    const headers = new Headers(request.headers);
    headers.delete(SESSION_SLOT_HEADER);
    // The live view's own gate is the person's view token; everything else is
    // ours, with this start's bearer.
    if (view) headers.delete("Authorization");
    else headers.set("Authorization", `Bearer ${token}`);
    const response = await this.containerFetch(new Request(request, { headers }), view ? VIEW_PORT : SERVER_PORT);
    // A check gave the browser back: what it left in the jar (Shopify
    // re-issues the session on every admin load) is the slot's now.
    if (request.method === "DELETE" && url.pathname === "/lease" && response.ok) this.ctx.waitUntil(this.saveJar("release"));
    // A person is in: their sign-in is saved while they are, and once after.
    if (view && response.status === 101) this.ctx.waitUntil(this.watchSignIn());
    return response;
  }

  // The slot's jar from elsewhere (POST /session/jar, or another slot's
  // object handing its own over — handOver). Only a jar that holds a sign-in.
  async importJar(slot: string, cookies: unknown): Promise<{ saved: number; loaded: boolean }> {
    if (!(await this.claim(slot))) throw new Error("Not this slot's browser");
    const jar = jarOf(cookies) as Cookie[];
    if (!holdsSignIn(jar)) throw new Error("The jar holds no sign-in");
    await this.keepJar(slot, jar, "import");
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

  // CHE-482: this slot's sign-in given to another slot, and nothing kept here.
  // For a sign-in made before sessions were a person's — a team's object,
  // named by the team's id — moved to the slot of the person who made it.
  // Object to object: the cookies never pass through a request handler.
  async handOver(from: string, to: string): Promise<{ saved: number; loaded: boolean }> {
    if (from === to || !SESSION_SLOT.test(to)) throw new Error("internal: hand over to another slot");
    if (!(await this.claim(from))) throw new Error("Not this slot's browser");
    const sealed = await this.ctx.storage.get<SealedJar>("jar");
    if (!sealed) throw new Error("This slot keeps no sign-in to hand over");
    const jar = await openJar(this.env.SESSION_JAR_KEY, from, sealed);
    const moved = await this.env.SESSION_RUNNER!.getByName(to).importJar(to, jar);
    await this.ctx.storage.delete("jar");
    this.deleteSchedules("probe");
    if (this.ctx.container?.running) await this.destroy();
    console.log(`[session-runner] jar handed over: ${JSON.stringify(describeJar(jar))}`);
    return moved;
  }

  // Ours to read (the agent worker's /session/state): never a value.
  async describe(slot: string): Promise<Record<string, unknown>> {
    if (!(await this.claim(slot))) throw new Error("Not this slot's browser");
    const sealed = await this.ctx.storage.get<SealedJar>("jar");
    const token = await this.ctx.storage.get<string>("token");
    const running = this.ctx.container?.running ?? false;
    const ready = running && token ? await this.readyState(token).catch(() => null) : null;
    const probes = await this.listSchedules("probe");
    return {
      slot,
      running,
      ready,
      jar: sealed ? { savedAt: new Date(sealed.savedAt).toISOString(), count: sealed.count, reason: sealed.reason } : null,
      nextProbe: probes[0] ? new Date(probes[0].time * 1000).toISOString() : null,
    };
  }

  // The scheduler's tick: a slot with a jar always has its next probe.
  async ensureProbe(slot: string): Promise<boolean> {
    if (!(await this.claim(slot))) return false;
    if (!(await this.ctx.storage.get("jar"))) return false;
    if ((await this.listSchedules("probe")).length > 0) return true;
    await this.scheduleProbe(60);
    return true;
  }

  // ── the hourly probe ──

  async probe(): Promise<void> {
    const slot = await this.ctx.storage.get<string>("slot");
    if (!slot || !(await this.ctx.storage.get("jar"))) return;
    // A slot that names no person (a team's, from before CHE-482) is never
    // probed and never loses its jar here: it waits to be handed over.
    const owner = slotParts(slot);
    if (!owner) {
      console.log("[session-runner] probe skipped: this slot names no person");
      return;
    }
    let rearm = true;
    try {
      const app = await this.probeTarget(owner);
      if (!app) {
        // The person has no Shopify store left in the team: nothing to watch,
        // nothing wakes this object again (the scheduler visits slots that
        // have one), and the sign-in kept for checking it goes too (Codex on
        // #338). A new store is signed in to afresh, which keeps a jar and
        // arms the probe.
        rearm = false;
        await this.ctx.storage.delete("jar");
        if (this.ctx.container?.running) await this.destroy();
        console.log("[session-runner] no Shopify store left: the probe stops and the jar is dropped");
        return;
      }
      const wasRunning = this.ctx.container?.running ?? false;
      let line: ProbeLine;
      try {
        const token = await this.bringUp(slot);
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
      await this.record(owner, app, line);
    } catch (error) {
      console.error(`[session-runner] probe failed: ${message(error)}`);
    } finally {
      if (rearm) await this.scheduleProbe(PROBE_EVERY_SECONDS);
    }
  }

  private async scheduleProbe(seconds: number): Promise<void> {
    this.deleteSchedules("probe");
    await this.schedule(seconds, "probe");
  }

  // The person's Shopify store to look at: their first in the team.
  private async probeTarget(owner: { teamId: string; userId: string }): Promise<{ appId: string; url: string } | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, targetUrl FROM App WHERE teamId = ? AND ownerId = ? AND targetKind = 'session' AND targetUrl LIKE 'https://admin.shopify.com/store/%/apps/%' ORDER BY createdAt ASC LIMIT 1",
    )
      .bind(owner.teamId, owner.userId)
      .first<{ id: string; targetUrl: string }>();
    return row ? { appId: row.id, url: row.targetUrl } : null;
  }

  private async record(owner: { teamId: string; userId: string }, app: { appId: string }, line: ProbeLine): Promise<void> {
    const { notified } = await recordProbe(this.env.DB, owner, app.appId, line, () => this.tell(owner, app.appId, line));
    console.log(`[session-runner] probe ${line.state}${notified !== null ? ` notified=${notified}` : ""}`);
  }

  // → null when the message went out (or had already), else why not.
  private async tell(owner: { teamId: string; userId: string }, appId: string, line: ProbeLine): Promise<string | null> {
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = this.env.OWNER_TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return "telegram not configured";
    const team = (await this.env.DB.prepare("SELECT name FROM Team WHERE id = ?").bind(owner.teamId).first<{ name: string }>())?.name ?? owner.teamId;
    const person = (await this.env.DB.prepare("SELECT email FROM User WHERE id = ?").bind(owner.userId).first<{ email: string }>())?.email ?? owner.userId;
    const text = probeMessage({ team, person }, appId, line, this.env.APP_URL);
    try {
      const sent = await sendRecorded(sendDeps(this.env, token), chatId, text, `session-probe:${owner.teamId}:${owner.userId}:${line.at}`);
      return sent.status === "sent" ? null : (sent.warning ?? "outcome unknown");
    } catch (error) {
      if (error instanceof AlreadySentError) return null;
      return message(error);
    }
  }

  // ── the browser ──

  private async claim(slot: string): Promise<boolean> {
    if (!SESSION_SLOT.test(slot)) return false;
    const known = await this.ctx.storage.get<string>("slot");
    if (known) return known === slot;
    await this.ctx.storage.put("slot", slot);
    return true;
  }

  // The browser, started if it is not, and holding the slot's jar. → this
  // start's bearer. One bring-up at a time: the calls that arrive meanwhile
  // wait for the same one.
  private bringUp(slot: string): Promise<string> {
    this.bringingUp ??= this.bringUpOnce(slot).finally(() => {
      this.bringingUp = undefined;
    });
    return this.bringingUp;
  }

  private async bringUpOnce(slot: string): Promise<string> {
    let token = await this.ctx.storage.get<string>("token");
    const running = this.ctx.container?.running ?? false;
    if (!running || !token) {
      // A browser whose bearer this object does not hold is not ours to use.
      if (running) await this.destroy();
      token = randomToken();
      await this.ctx.storage.put("token", token);
      this.envVars = await this.environment(slot, token);
      await this.startAndWaitForPorts({
        ports: [SERVER_PORT, VIEW_PORT],
        startOptions: { envVars: this.envVars },
        cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
      });
    }
    // A fresh Chrome has no cookies. The slot's go in before anything else.
    const ready = await this.readyState(token);
    if (!ready.jarLoaded) {
      const sealed = await this.ctx.storage.get<SealedJar>("jar");
      let cookies: Cookie[] = [];
      if (sealed) {
        try {
          cookies = await openJar(this.env.SESSION_JAR_KEY, slot, sealed);
        } catch (error) {
          // A jar that no longer opens is a person who signs in again.
          console.error(`[session-runner] the slot's jar did not open: ${message(error)}`);
        }
      }
      await this.server(token, "PUT", "/jar", { cookies });
    }
    return token;
  }

  private async environment(slot: string, token: string): Promise<Record<string, string>> {
    const out: Record<string, string> = { SESSION_SERVER_TOKEN: token, SESSION_SLOT: slot, VIEW_ORIGINS: viewOrigin(this.env.APP_URL) };
    const viewSecret = this.env.SESSION_VIEW_SECRET?.trim();
    if (viewSecret) out.SESSION_VIEW_SECRET = await viewKeyFor(viewSecret, slot);
    const proxy = await proxyForSlot(this.env.SESSION_PROXY_URL, slot);
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

  private async keepJar(slot: string, jar: Cookie[], reason: string): Promise<void> {
    const sealed = await sealJar(this.env.SESSION_JAR_KEY, slot, jar);
    await this.ctx.storage.put<SealedJar>("jar", { ...sealed, savedAt: Date.now(), count: jar.length, reason });
  }

  // The jar out of a running browser that was given the slot's, kept when it
  // holds a sign-in. Never throws: a jar not saved now is saved next time.
  async saveJar(reason: string): Promise<void> {
    try {
      const slot = await this.ctx.storage.get<string>("slot");
      const token = await this.ctx.storage.get<string>("token");
      if (!slot || !token || !this.ctx.container?.running) return;
      if (!(await this.readyState(token)).jarLoaded) return;
      const { cookies } = await this.server<{ cookies: Cookie[] }>(token, "GET", "/jar");
      const jar = jarOf(cookies) as Cookie[];
      if (!holdsSignIn(jar)) {
        console.log(`[session-runner] jar not kept (${reason}): no sign-in in it`);
        return;
      }
      await this.keepJar(slot, jar, reason);
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
