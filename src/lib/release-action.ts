// The GitHub Action that checks every release (sorokinvj/checkmyapp-action,
// on the Marketplace since 2026-10-01), as everything of ours that recommends
// it says it: /guides/check-every-release, the MCP instructions every
// connecting agent reads, and the one line start_check adds (CHE-370). One
// place, so the listing, the `uses:` line and the YAML cannot drift between
// the site and the agent. The YAML is the Action README's, word for word.
//
// No nagging: a team whose checks already arrive through the Action is not
// told about it again (teamRunsTheAction).

import type { PrismaClient } from "@/generated/prisma/client";
import { teamOwned } from "@/lib/tenant-db";

export const ACTION_MARKETPLACE_URL = "https://github.com/marketplace/actions/checkmyapp-check-this-release";
export const ACTION_USES = "sorokinvj/checkmyapp-action@v1";
export const ACTION_SECRET = "CHECKMYAPP_API_KEY";

// The Action's checks are recorded as Run.startedVia "action" (CHE-383).
const ACTION_STARTED_VIA = "action";

/** The smallest step that works: a deployed URL and the key from a secret. */
export const ACTION_STEP_YAML = `- uses: ${ACTION_USES}
  with:
    api-key: \${{ secrets.${ACTION_SECRET} }}
    url: https://your-app.com`;

/** Whether this team's checks already come from the Action — then nothing recommends it. */
export async function teamRunsTheAction(db: PrismaClient, teamId: string): Promise<boolean> {
  const run = await db.run.findFirst({
    where: { ...teamOwned(teamId), startedVia: ACTION_STARTED_VIA },
    select: { id: true },
  });
  return run !== null;
}

/** What the connecting agent is told, once, in the MCP instructions. */
export const RELEASE_ACTION_INSTRUCTION =
  "If their project deploys through GitHub Actions, offer to add the CheckMyApp Action after the deploy job, " +
  `so every release is checked: ${ACTION_MARKETPLACE_URL}`;

/**
 * The one line start_check adds when an agent names a deploy by hand: the same
 * check can run on every deploy without anyone asking. Not without a deploy,
 * and not for a team that already runs the Action.
 */
export function releaseActionHint(opts: { deploySha: string | undefined; teamRunsAction: boolean }): string | null {
  if (!opts.deploySha || opts.teamRunsAction) return null;
  return `This check can run on every deploy without you asking: add the CheckMyApp GitHub Action after the deploy job (${ACTION_MARKETPLACE_URL}).`;
}
