"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createApiKey, revokeApiKey } from "@/app/dashboard/actions";

// Dashboard "API keys" block (CHE-52). Create shows the raw key exactly once
// (only its hash is stored); revoke deletes the row. Keys let a coding agent
// start checks as this owner: Authorization: Bearer cma_… on POST /api/checks.
//
// Every plan can create a key (CHE-316, owner 2026-09-27): the coding agent is
// the primary interface, so the form is never behind an upgrade. The plan still
// bounds what a key can spend, through the same run quota as this dashboard.
export function ApiKeys({
  keys,
}: {
  keys: { id: string; name: string; lastUsedAt: string | null; createdAt: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<{ name: string; rawKey: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="mt-10">
      <p className="section-label">api keys</p>
      <div className="card mt-2 p-5">
        <p className="text-xs text-fg-faint">
          Let a coding agent (CI hook, MCP server) run checks as you:{" "}
          <code className="font-mono">Authorization: Bearer cma_…</code> on{" "}
          <code className="font-mono">POST /api/checks</code>. See{" "}
          <Link href="/guides/connect-your-agent" className="text-accent hover:underline">
            Connect your coding agent
          </Link>
          . Included on every plan; a check started with a key counts against your
          team&apos;s plan like any other.
        </p>

        {newKey && (
          <div className="mt-4 rounded-md border border-ink-700 p-3">
            <p className="text-xs text-fg-muted">
              Key “{newKey.name}” created — copy it now, it won&apos;t be shown again:
            </p>
            <code className="mt-1 block select-all break-all font-mono text-[13px] text-accent">
              {newKey.rawKey}
            </code>
          </div>
        )}

        {keys.length > 0 && (
          <ul className="mt-4 space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between">
                <div>
                  <span className="font-mono text-sm text-fg">{k.name}</span>
                  <span className="ml-2 text-xs text-fg-faint">
                    {k.lastUsedAt
                      ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await revokeApiKey(k.id);
                      router.refresh();
                    })
                  }
                  className="font-mono text-[13px] text-fg-faint hover:text-status-broken hover:underline"
                >
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const created = await createApiKey(name || "API key");
              setNewKey({ name: created.name, rawKey: created.rawKey });
              setName("");
              router.refresh();
            });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name, e.g. post-deploy hook"
            maxLength={100}
            className="flex-1 rounded border border-ink-700 bg-transparent px-2 py-1.5 font-mono text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "…" : "Create key"}
          </button>
        </form>
      </div>
    </section>
  );
}
