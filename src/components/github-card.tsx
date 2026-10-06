import Link from "next/link";
import { RELEASE_GUIDE_PATH } from "@/lib/release-action";

// GitHub, on the team's Integrations page and on an app's Integrations
// section (CHE-413): the one thing GitHub does for a customer is run a check
// of every release from their CI, through the GitHub Action. Connected means a
// check has arrived that way; nothing else is promised here. One component so
// the two screens cannot say two different things.
export function GitHubCard({ connected, scope = "app" }: { connected: boolean; scope?: "team" | "app" }) {
  return (
    <div className="card flex items-start justify-between gap-4 p-5">
      <div className="space-y-1">
        {/* CHE-369: "GitHub Action", now that the GitHub App sits next to it
            on Integrations — two cards both called "GitHub" read as one. */}
        <p className="text-sm font-medium text-fg">
          GitHub Action <span className="text-xs font-normal text-fg-faint">· checks from your CI</span>
        </p>
        {connected ? (
          <p className="text-xs text-status-ok">
            ✓ Connected — {scope === "team" ? "release checks arrive from your CI." : "this app's release checks arrive from your CI."}
          </p>
        ) : (
          <p className="text-xs text-fg-faint">
            Not connected. A check runs from your CI on every release through the GitHub Action — see{" "}
            <Link href={RELEASE_GUIDE_PATH} className="text-accent hover:underline">
              Check every release
            </Link>
            .
          </p>
        )}
      </div>
      {!connected && (
        <Link
          href={RELEASE_GUIDE_PATH}
          className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
        >
          Set up →
        </Link>
      )}
    </div>
  );
}
