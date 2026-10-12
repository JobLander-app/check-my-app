// An app files into one tracker (CHE-438). IssueLink keeps only an issue key —
// "JOB-123", "SEC-4" — not which tracker it lives in, so when an app moves to
// another tracker (Linear ↔ Jira, or another Jira site) its in-flight links
// would be read and commented on through the new one: a missing issue at best,
// an unrelated issue that happens to share the key at worst.
//
// So a switch retires them. Each open or fixed link is written to the ledger
// as "superseded" (the same record CHE-101 keeps when a ticket is replaced, so
// the old identity is never lost) and removed; the next time the problem is
// seen it is filed afresh in the new tracker. Suppressed links stay: the owner
// ruled those not-a-bug, and the filer never sends them to any tracker.
// Resolved links stay too: a recurrence of one files a new ticket.

import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped } from "@/lib/tenant-db";

const IN_FLIGHT = ["open", "fixed"];

export async function retireTrackerLinks(
  db: PrismaClient,
  app: { id: string; teamId: string | null; ownerId: string | null; appSlug: string },
): Promise<number> {
  const links = await db.issueLink.findMany({ where: { appId: app.id, status: { in: IN_FLIGHT } } });
  for (const link of links) {
    await db.settledSignature.create({ ...alreadyScoped("settled signatures outlive the app they describe"),
      data: {
        ownerId: app.ownerId,
        teamId: app.teamId,
        appSlug: app.appSlug,
        dedupKey: link.dedupKey,
        externalIssueId: link.externalIssueId,
        outcome: "superseded",
        defectClass: link.defectClass,
      },
    });
  }
  if (links.length > 0) await db.issueLink.deleteMany({ where: { appId: app.id, status: { in: IN_FLIGHT } } });
  return links.length;
}
