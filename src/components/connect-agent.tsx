"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createApiKey } from "@/app/dashboard/actions";
import {
  CONNECT_GUIDE_PATH,
  agentConnected,
  clientConfig,
  firstPrompt,
  installCommand,
} from "@/lib/agent-connect";

// "This is the last time you need to be here" (CHE-317, owner 2026-09-27).
//
// The coding agent is the primary interface; this panel is the dashboard
// saying so. It sits at the top of the dashboard — which is also the screen
// onboarding ends on — and stays there, big, until one of the team's keys has
// actually been used. After that it shrinks to one line with the setup folded
// inside, for the second machine or the teammate.
//
// One click makes a key (the same createApiKey the API keys block uses) and
// drops it straight into the command, so there is nothing to assemble by hand.
// The raw key lives only in this component's state: it is shown once, exactly
// as in the API keys block.
//
// CHE-324: onboarding opens on this same panel, before the person has added
// anything by hand. What onboarding needs on top of the dashboard — the first
// prompt and a way out without an app — comes in as children, so the words
// and the key flow stay one component.
export function ConnectAgent({
  keys,
  children,
}: {
  keys: { lastUsedAt: string | null }[];
  children?: ReactNode;
}) {
  if (agentConnected(keys)) {
    return (
      <div className="mb-6">
        <details className="text-xs text-fg-faint">
          <summary className="cursor-pointer hover:text-fg-muted">
            <span className="text-status-ok">✓ Connected to your agent</span> · setup
          </summary>
          <div className="card mt-2 p-4">
            <CreateAndInstall />
          </div>
        </details>
        {children && <div className="card mt-3 p-4">{children}</div>}
      </div>
    );
  }

  return (
    <section className="card mb-8 border-accent/40 p-5 sm:p-6">
      <p className="section-label">connect your agent</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
        This is the last time you need to be here.
      </h2>
      <p className="mt-2 text-sm text-fg-muted">
        Connect CheckMyApp to your coding agent and stop clicking around to check things. From
        then on your agent adds your apps, writes the scenarios, starts the checks — and tells you
        what broke. It&apos;s going to like it here.
      </p>
      <div className="mt-5">
        <CreateAndInstall />
      </div>
      {children && <div className="mt-6 border-t border-ink-700 pt-5">{children}</div>}
    </section>
  );
}

// What to say to the agent first (CHE-324). The text is firstPrompt(), the
// same string scripts/verify-onboarding-agent-path.ts reads.
export function FirstPrompt({ url }: { url: string | null }) {
  const prompt = firstPrompt(url);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">Then tell your agent, in your own words — for example:</p>
        <CopyButton text={prompt} />
      </div>
      <p className="mt-1 select-all rounded-md border border-ink-700 p-3 text-[13px] leading-relaxed text-fg">
        {prompt}
      </p>
    </div>
  );
}

function CreateAndInstall() {
  const router = useRouter();
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3">
      {rawKey ? (
        <p className="text-xs text-status-ok">
          ✓ Key created and filled in below. Copy it now — it won&apos;t be shown again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                try {
                  const created = await createApiKey("Coding agent");
                  setRawKey(created.rawKey);
                  router.refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Couldn't create a key — please try again.");
                }
              })
            }
            className="rounded-md bg-accent px-4 py-2 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create key"}
          </button>
          <span className="text-xs text-fg-faint">then paste one line into your terminal</span>
        </div>
      )}
      {error && <p className="text-xs text-status-broken">{error}</p>}
      <AgentInstall rawKey={rawKey} />
    </div>
  );
}

// The install instructions for a given key — or for the placeholder, before
// one exists. Separate so the exact text a person copies can be rendered and
// checked on its own (scripts/verify-agent-panel.ts).
export function AgentInstall({ rawKey }: { rawKey: string | null }) {
  const command = installCommand(rawKey);
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-fg-muted">Claude Code</p>
          <CopyButton text={command} />
        </div>
        <code className="mt-1 block select-all break-all rounded-md border border-ink-700 p-3 font-mono text-[12px] leading-relaxed text-fg">
          {command}
        </code>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-faint hover:text-fg-muted">
          Cursor / other clients
        </summary>
        <div className="mt-2 flex justify-end">
          <CopyButton text={clientConfig(rawKey)} />
        </div>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-ink-700 p-3 font-mono text-[12px] text-fg">
          {clientConfig(rawKey)}
        </pre>
      </details>
      <Link href={CONNECT_GUIDE_PATH} className="inline-block text-xs text-accent hover:underline">
        How to connect your agent →
      </Link>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard refused (permissions, an old browser): the text is
          // select-all, so a click and Cmd+C still work.
        }
      }}
      className="shrink-0 font-mono text-[12px] text-accent hover:underline"
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}
