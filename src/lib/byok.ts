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

// OpenRouter answers GET /api/v1/key with 200 for a key it accepts and 401 for
// one it does not (checked 2026-10-11). A provisioning or management key is
// accepted there but cannot call a model, so every check would fail later.
export async function checkOpenRouterKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const k = key.trim();
  if (!k.startsWith("sk-or-")) return { ok: false, reason: "That is not an OpenRouter key — they start with sk-or-." };
  let res: Response;
  try {
    res = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${k}` } });
  } catch {
    return { ok: false, reason: "OpenRouter did not answer. Nothing was saved — try again in a minute." };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "OpenRouter did not accept this key. Nothing was saved." };
  if (!res.ok) return { ok: false, reason: `OpenRouter answered ${res.status}. Nothing was saved — try again in a minute.` };
  const body = (await res.json().catch(() => null)) as { data?: { is_provisioning_key?: boolean; is_management_key?: boolean } } | null;
  if (body?.data?.is_provisioning_key || body?.data?.is_management_key) {
    return { ok: false, reason: "This is an OpenRouter management key; it cannot run models. Create an ordinary API key and paste that one." };
  }
  return { ok: true };
}
