// Owner API keys (CHE-52). Raw key format: `cma_<32 random hex>`; only its
// SHA-256 hex digest is stored (ApiKey.keyHash), so a DB leak never leaks keys.
// Web Crypto throughout: these run in the workerd web worker on every
// key-authenticated request.

import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped, publicRow } from "@/lib/tenant-db";

export const API_KEY_RE = /^cma_[0-9a-f]{32}$/;

// 16 random bytes → 32 hex chars. Raw key is returned ONCE, at creation.
export function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `cma_${toHex(bytes)}`;
}

export async function hashApiKey(raw: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return toHex(new Uint8Array(digest));
}

// Bearer token from an Authorization header, or null if it isn't ours.
export function extractApiKey(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m || !API_KEY_RE.test(m[1])) return null;
  return m[1];
}

// Resolve a request's API key to the whole grant: who minted it, which TEAM it
// acts for, and what it may do (CHE-263). Touches lastUsedAt so the dashboard
// can show which keys are alive. Null = no key, or one we do not know.
//
// Before this, a key resolved to a person and inherited that person's whole
// authority — which is how `POST /api/runs/{id}/recheck` came to refuse the
// owner's own key (CHE-246): nothing decided what a key may do, so the answer
// depended on which helper a route happened to call.
export async function resolveApiKeyGrant(db: PrismaClient, req: Request) {
  const raw = extractApiKey(req);
  if (!raw) return null;
  const keyHash = await hashApiKey(raw);
  const key = await db.apiKey.findUnique({ ...publicRow(),
    where: { keyHash },
    include: { owner: true, team: true },
  });
  if (!key) return null;
  const now = new Date();
  if (shouldTouchLastUsed(key.lastUsedAt, now)) {
    await db.apiKey.update({ ...alreadyScoped("already read in this request"), where: { id: key.id }, data: { lastUsedAt: now } });
  }
  return { user: key.owner, team: key.team, scope: key.scope, keyId: key.id };
}

// lastUsedAt is written on the first use and then at most once an hour
// (CHE-317). The dashboard reads it as "has an agent ever connected" and shows
// it as a date, so an hour is exact enough — and an agent polling a run every
// 30 seconds no longer costs a D1 write per poll.
export const LAST_USED_TOUCH_MS = 60 * 60 * 1000;

export function shouldTouchLastUsed(lastUsedAt: Date | null | undefined, now: Date): boolean {
  return !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= LAST_USED_TOUCH_MS;
}

// Back-compat for callers that only want the person. Kept so the change to the
// grant shape is one file at a time rather than a rewrite of every caller.
export async function resolveApiKeyOwner(db: PrismaClient, req: Request) {
  return (await resolveApiKeyGrant(db, req))?.user ?? null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
