import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { ApiKeys } from "@/components/api-keys";
import { ConnectAgent } from "@/components/connect-agent";

// Agent and API keys (CHE-351 shell): the agent panel and the team's keys,
// which sat at the top and the bottom of the old dashboard. CHE-356 redraws it.
export default async function ApiKeysPage() {
  const { db, team } = await requireUser();
  const apiKeys = await db.apiKey.findMany({
    where: { ...teamOwned(team.id) },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Agent and API keys</h1>
      <ConnectAgent keys={apiKeys.map((k) => ({ lastUsedAt: k.lastUsedAt?.toISOString() ?? null }))} />
      <ApiKeys
        keys={apiKeys.map((k) => ({
          id: k.id,
          name: k.name,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
