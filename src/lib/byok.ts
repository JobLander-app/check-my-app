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
