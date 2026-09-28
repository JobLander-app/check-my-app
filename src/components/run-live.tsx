"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PHASE_LABELS, PHASE_ORDER, type RunEvent, type RunPhase } from "@/lib/types";
import { RunFailed } from "@/components/run-failed";

interface Snapshot {
  status: string;
  events: RunEvent[] | null;
  verdict: string | null;
  currentAction: string | null;
  liveScreenshotUrl: string | null;
}

const ICON: Record<RunEvent["icon"], { glyph: string; className: string }> = {
  ok: { glyph: "✓", className: "text-status-ok" },
  info: { glyph: "•", className: "text-fg-faint" },
  notable: { glyph: "⚡", className: "text-status-risky" },
  working: { glyph: "⏳", className: "text-accent" },
  warn: { glyph: "⚠", className: "text-status-confusing" },
};

const PHASE_BLURB: Record<RunPhase, string> = {
  replay: "Re-checking the pages we already know, before spending on a full check…",
  connecting: "Booting the agent and checking we can reach your app…",
  surface_scan: "Loading the homepage, detecting your stack…",
  walking: "Walking each discovered journey end-to-end…",
  discovery: "Mapping your app's user journeys…",
  anatomy: "Assembling pages, actions, services and tech…",
  writing: "Synthesizing the verdict…",
};

// Screen 2 — In-progress. Half product, half theatre: deploy-log feed on the
// left, the agent's live browser screenshot on the right. Subscribes to SSE and
// redirects to the verdict when the run completes.
export function RunLive({
  publicId,
  appSlug,
  runNumber,
  startedAt,
  notifyEmail,
  isExtension = false,
}: {
  publicId: string;
  appSlug: string;
  runNumber: number;
  startedAt: string;
  notifyEmail: string | null;
  isExtension?: boolean;
}) {
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${publicId}/stream`);
    es.addEventListener("snapshot", (e) => setSnap(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("done", (e) => {
      es.close();
      const status = (e as MessageEvent).data;
      if (status === "completed" || status === "partial") {
        router.push(`/verdict/${publicId}`);
      } else {
        // CHE-329: failed or canceled — the server page renders the ending
        // (src/components/run-failed.tsx), with the price and the retry it
        // alone can decide.
        router.refresh();
      }
    });
    es.addEventListener("error", () => es.close());
    return () => es.close();
  }, [publicId, router]);

  const phase = (snap?.status ?? "connecting") as RunPhase;
  const phaseIndex = Math.max(0, PHASE_ORDER.indexOf(phase));
  const pct = Math.round(((phaseIndex + 0.5) / PHASE_ORDER.length) * 100);
  const events = snap?.events ?? [];
  const started = new Date(startedAt);
  const estimated = new Date(started.getTime() + 2 * 60 * 60 * 1000);
  // Fixed locale: this renders on both server and client, and locale-dependent
  // output would cause a hydration mismatch (e.g. "09:43 PM" vs "21:43").
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  // The moment between the stream saying "failed" and the refreshed page
  // arriving: the same card, saying only what is true of every failed run.
  if (snap?.status === "failed") return <RunFailed free={false} retry={null} />;

  return (
    <div className="stagger space-y-5">
      {/* Header row: target, run number, progress */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mono text-lg text-fg">{appSlug}</p>
          <p className="font-mono text-xs text-fg-faint">
            Started {fmt(started)} · Estimated {fmt(estimated)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xs text-fg-faint">Run #{runNumber}</p>
          <p className="font-mono text-sm text-fg-muted">{pct}%</p>
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
        <div
          className="progress-active h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Phase banner */}
      <div className="rounded-xl border border-accent/30 bg-accent/10 px-5 py-4">
        <p className="font-medium text-fg">
          {isExtension && phase === "surface_scan" ? "Opening your extension…" : isExtension && phase === "discovery" ? "Mapping your extension's user journeys…" : PHASE_BLURB[phase] ?? "Starting up…"}
        </p>
        <p className="mt-0.5 font-mono text-xs text-fg-muted">
          Phase {phaseIndex + 1} of {PHASE_ORDER.length} — {PHASE_LABELS[phase] ?? "Connecting"}
        </p>
      </div>

      <div className={`grid gap-4 ${isExtension ? "" : "lg:grid-cols-[1.2fr_1fr]"}`}>
        <div className={`card flex min-h-[320px] flex-col p-4 ${isExtension ? "min-w-0" : ""}`}>
          <p className="section-label mb-3">What we&apos;re doing</p>
          <ul className="flex-1 space-y-0.5 overflow-y-auto">
            {events.length === 0 && (
              <li className="log-line cursor text-fg-faint">Starting up</li>
            )}
            {events.map((ev, i) => {
              const icon = ICON[ev.icon];
              const last = i === events.length - 1;
              return (
                <li key={i} className={`log-line ${last ? "text-fg" : ""} ${isExtension ? "[overflow-wrap:anywhere]" : ""}`}>
                  <span className="mr-2 text-fg-faint">
                    {new Date(ev.at).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className={`mr-1.5 ${icon.className}`}>{icon.glyph}</span>
                  {ev.text}
                </li>
              );
            })}
          </ul>
          {isExtension && snap?.currentAction && (
            <p className="mt-3 rounded-lg bg-ink-900 p-3 text-sm text-fg-muted">
              {snap.currentAction}
            </p>
          )}
        </div>

        {!isExtension && <div className="card flex flex-col p-4">
          <p className="section-label mb-3">What the agent sees</p>
          <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
            {snap?.liveScreenshotUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={snap.liveScreenshotUrl}
                alt="Live screenshot of the agent's browser"
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="font-mono text-xs text-fg-faint">
                  waiting for first frame…
                </span>
              </div>
            )}
            <span className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-ink-950/80 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-status-ok">
              <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-status-ok" />
              live
            </span>
          </div>
          {snap?.currentAction && (
            <div className="mt-3 rounded-lg bg-ink-900 p-3">
              <p className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">
                Agent currently
              </p>
              <p className="mt-1 text-sm italic text-fg-muted">
                &ldquo;{snap.currentAction}&rdquo;
              </p>
            </div>
          )}
        </div>}
      </div>

      <p className="text-center font-mono text-[13px] text-fg-faint">
        {notifyEmail ? <>Close this tab — we&apos;ll email {notifyEmail} when done.</> : "You can return to this page to see the result."}
      </p>
    </div>
  );
}
