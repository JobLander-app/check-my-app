// CHE-436: BYOK — a team that brings its own OpenRouter API key.
//
// When a team has Team.openrouterKeyEnc set, every run they start copies the
// encrypted key onto Run.byokKeyEnc. The agent worker decrypts it at run start
// and uses it as the OpenRouter key instead of the worker binding — the team
// pays their own OpenRouter account; the run is free on our balance.
//
// "BYOK" means the run's cost comes off their key, not ours. The price is
// therefore $0 for every run that carries byokKeyEnc (enforced in pricing.ts).

import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The encrypted BYOK key for a team, or null if the team has no BYOK key.
 * Called when creating a run so the key is captured at creation time.
 */
export async function teamByokKeyEnc(
  db: PrismaClient,
  teamId: string | null | undefined,
): Promise<string | null> {
  if (!teamId) return null;
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { openrouterKeyEnc: true },
  });
  return team?.openrouterKeyEnc ?? null;
}

// CHE-448: what anyone on the team is shown of the key. Enough to tell two keys
// apart, never enough to use one; the full key never leaves the server.
export function maskKey(key: string): string {
  const k = key.trim();
  return k.length < 12 ? "…" : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export type KeyCheck = { ok: true } | { ok: false; reason: string };

const CHECK_TIMEOUT_MS = 10_000;
const NO_ANSWER = "OpenRouter did not answer. Nothing was saved — try again in a minute.";

// OpenRouter answers GET /api/v1/key with 200 and the key's details for a key it
// accepts, and 401 for one it does not (checked 2026-10-11). Only a 200 that
// carries those details counts: anything else proves nothing about the key. A
// provisioning or management key is accepted there but cannot call a model.
export async function checkOpenRouterKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const k = key.trim();
  if (!k.startsWith("sk-or-")) return { ok: false, reason: "That is not an OpenRouter key — they start with sk-or-." };
  let res: Response;
  try {
    res = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: NO_ANSWER };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "OpenRouter did not accept this key. Nothing was saved." };
  if (!res.ok) return { ok: false, reason: `OpenRouter answered ${res.status}. Nothing was saved — try again in a minute.` };
  const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
  const data = body?.data;
  if (!data || typeof data !== "object" || typeof data.usage !== "number") return { ok: false, reason: NO_ANSWER };
  if (data.is_provisioning_key || data.is_management_key) {
    return { ok: false, reason: "This is an OpenRouter management key; it cannot run models. Create an ordinary API key and paste that one." };
  }
  return { ok: true };
}

// Store a team's key only after OpenRouter has accepted it. The one place the
// "checked, then stored" order lives, so it is tested by calling it.
export async function saveTeamKey(
  db: PrismaClient,
  teamId: string,
  key: string,
  deps: { check?: (key: string) => Promise<KeyCheck>; encrypt: (plain: string) => string },
): Promise<{ ok: true; masked: string } | { ok: false; reason: string }> {
  const k = key.trim();
  if (!k) return { ok: false, reason: "Paste the key first." };
  const verdict = await (deps.check ?? checkOpenRouterKey)(k);
  if (!verdict.ok) return verdict;
  await db.team.update({ where: { id: teamId }, data: { openrouterKeyEnc: deps.encrypt(k) } });
  return { ok: true, masked: maskKey(k) };
}

// What the Team page says about a stored key: its masked form, or that it can
// no longer be read (the encryption secret changed) and must be replaced.
export function storedKeyView(enc: string | null | undefined, decrypt: (blob: string) => string): { masked: string } | { unreadable: true } | null {
  if (!enc) return null;
  try {
    return { masked: maskKey(decrypt(enc)) };
  } catch {
    return { unreadable: true };
  }
}
