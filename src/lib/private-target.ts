// An address that only exists inside somebody's own network cannot be checked
// from outside it — and must be refused before a check starts, not reported.
//
// CHE-390. Run #292 (2026-10-02): the first check of a new account was pointed at
// https://192.168.0.197:53317, a dev server on the owner's LAN. Nothing of ours
// can reach that; every request was answered 403 on the way, and the verdict
// called the app "Broken — entire origin returns 403 Forbidden", took $0.28 of
// the account's free credit and told the owner to change their server's access
// rules. A claim about the customer's product resting on our own incapacity
// (CLAUDE.md §8), about an app we never saw.
//
// Decided from the address alone, with no lookup: the URL parser has already
// turned every spelling of an IPv4 address (decimal, hex, short forms) into
// dotted form, so the literal is what is compared. A public name that resolves
// to a private address is not caught here.

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;

function privateV4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    // Not routed on the internet at all: documentation, benchmarking, protocol
    // assignments, multicast and the reserved top of the space.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 ||
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateV6(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const ip = host.slice(1, -1).toLowerCase();
  if (ip === "::" || ip === "::1") return true;
  // An IPv4 address carried in IPv6 (::ffff:c0a8:c5 is 192.168.0.197).
  const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip); // unique local, link-local
}

/** True when the address can only be opened from inside the owner's own network or machine. */
export function isPrivateTarget(url: string): boolean {
  let host: string;
  try {
    // "localhost." is localhost: the URL parser keeps the root dot.
    host = new URL(url).hostname.replace(/\.$/, "");
  } catch {
    return false; // not an address at all: another rule's refusal
  }
  return LOCAL_NAMES.test(host) || privateV4(host) || privateV6(host);
}

/**
 * The same question for a stored check, app or watch: its target, and for an
 * extension the page it is opened on (extensionConfig.companionUrl — the store
 * link itself is public).
 */
export function holdsPrivateTarget(row: { targetUrl: string; extensionConfig?: string | null }): boolean {
  if (isPrivateTarget(row.targetUrl)) return true;
  if (!row.extensionConfig) return false;
  try {
    const companion = (JSON.parse(row.extensionConfig) as { companionUrl?: unknown }).companionUrl;
    return typeof companion === "string" && companion !== "" && isPrivateTarget(companion);
  } catch {
    return false;
  }
}

// What the person who pasted it is told — on the form, in the API's answer and
// to a coding agent over MCP. It says what to paste instead.
export const PRIVATE_TARGET_MESSAGE =
  "That address only works inside your own network. Paste the public address of your app — the one your users open.";
