// CHE-464: the pure half of a team's session browser (session-runner.ts) — no
// container runtime here, so scripts/verify-session-runner.ts runs these exact
// functions in Node.

import { jarOf } from "../../spikes/shopify-session/jar-rules.mjs";
import { shouldNotify } from "../../spikes/shopify-session/classify.mjs";

export type Cookie = Record<string, unknown>;

// ── the jar, sealed ──
//
// AES-GCM under a key derived from SESSION_JAR_KEY, with the slot as the
// associated data: a jar copied into another slot's object does not open.

const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function jarKey(secret: string | undefined): Promise<CryptoKey> {
  const value = secret?.trim();
  if (!value || value.length < 32) throw new Error("internal: SESSION_JAR_KEY is not set");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session-jar:${value}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJar(secret: string | undefined, slot: string, jar: Cookie[]): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(slot) },
    await jarKey(secret),
    new TextEncoder().encode(JSON.stringify(jar)),
  );
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}

export async function openJar(secret: string | undefined, slot: string, sealed: { iv: string; data: string }): Promise<Cookie[]> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(sealed.iv), additionalData: new TextEncoder().encode(slot) },
    await jarKey(secret),
    unb64(sealed.data),
  );
  return jarOf(JSON.parse(new TextDecoder().decode(plain))) as Cookie[];
}

// One slot, one sticky residential session. The upstream's password carries
// `_session-<id>`; each slot's is derived from it, so one person's exit
// address never moves because of another's (CHE-426's rule, per person since
// CHE-482). A URL with no session part is used as it is; no URL means direct
// egress.
export async function proxyForSlot(url: string | undefined, slot: string): Promise<string | null> {
  const raw = url?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !parsed.username) return null;
  const password = decodeURIComponent(parsed.password);
  if (!/_session-[A-Za-z0-9]{1,32}/.test(password)) return raw;
  const session = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session-proxy:${slot}`)))).slice(0, 8);
  parsed.password = password.replace(/_session-[A-Za-z0-9]{1,32}/, `_session-${session}`);
  return parsed.toString();
}

export interface ProbeLine {
  at: string;
  state: string;
  url_host: string | null;
  url_path: string | null;
  ms: number;
  challenge?: string;
  detail?: string;
  proxy_status?: number;
}

const REASON: Record<string, string> = {
  login_page: "Shopify показывает страницу входа",
  captcha: "Shopify показывает капчу",
  "2fa": "Shopify просит код двухфакторной проверки",
  error: "проба второй час подряд не может открыть админку",
};

// Whose sign-in a probe looked at: the team's name and the person's address,
// as the owner reads them.
export interface ProbeWho {
  team: string;
  person: string;
}

// What the owner reads when a person's sign-in or the egress went down.
export function probeMessage(who: ProbeWho, appId: string, line: ProbeLine, appUrl?: string): string {
  if (line.state === "proxy") {
    const why =
      line.proxy_status === 407
        ? "отклоняет наш логин (407): учётные данные в секрете SESSION_PROXY_URL воркера checkmyapp-agent не совпадают с IPRoyal"
        : "не пропускает трафик (402): кончился оплаченный трафик, нужно пополнить IPRoyal — https://dashboard.iproyal.com/";
    return (
      `Резидентный прокси Shopify-сессий (IPRoyal) ${why} (${line.at}).\n` +
      "Входить в Shopify заново не нужно. Пока прокси стоит, проверки Shopify-аппов падают как наш сбой и ничего не публикуют."
    );
  }
  const base = (appUrl ?? "https://checkmyapp.dev").replace(/\/+$/, "");
  return (
    `Вход в Shopify у ${who.person} (команда «${who.team}») закончился: ${REASON[line.state] ?? line.state} (${line.at}).\n` +
    `Войти заново может только ${who.person}: ${base}/health/apps/${appId}/sign-in\n` +
    "Отвечать не нужно — проба сама увидит, что вход снова на месте."
  );
}

// One probe line into D1 SessionProbe, and the owner told when the session
// host's rule says so (classify.mjs shouldNotify): once per drop from ok, once
// per proxy outage. `tell` sends, and answers null or why it could not.
//
// The history is everything since the last ok: shouldNotify looks back to it
// for a drop, and through the whole run of proxy lines for an outage. A fixed
// window forgot the one message of an outage longer than itself and sent it
// again (Codex on #338).
//
// CHE-482: the history is one person's in one team — another person's sign-in
// ending is not a reason to tell, or not to tell, about this one.
export async function recordProbe(
  DB: D1Database,
  owner: { teamId: string; userId: string },
  appId: string,
  line: ProbeLine,
  tell: () => Promise<string | null>,
): Promise<{ notified: boolean | null }> {
  const { teamId, userId } = owner;
  const rows = await DB.prepare(
    "SELECT state, notified FROM SessionProbe WHERE teamId = ? AND userId = ? AND at >= COALESCE((SELECT MAX(at) FROM SessionProbe WHERE teamId = ? AND userId = ? AND state = 'ok'), '') ORDER BY at DESC LIMIT 5000",
  )
    .bind(teamId, userId, teamId, userId)
    .all<{ state: string; notified: number | null }>();
  const history = (rows.results ?? []).reverse().map((row) => ({ state: row.state, notified: row.notified === 1 }));
  let notified: boolean | null = null;
  let notifyError: string | null = null;
  if (shouldNotify(history, line.state)) {
    notifyError = await tell();
    notified = notifyError === null;
  }
  await DB.prepare(
    "INSERT INTO SessionProbe (id, teamId, userId, appId, at, state, urlHost, urlPath, ms, challenge, detail, proxyStatus, notified, notifyError) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `sp${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(6)))}`,
      teamId,
      userId,
      appId,
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
  return { notified };
}

// The origin a live view may be opened from: the app's own.
export function viewOrigin(appUrl: string | undefined): string {
  try {
    return new URL(appUrl ?? "https://checkmyapp.dev").origin;
  } catch {
    return "https://checkmyapp.dev";
  }
}
