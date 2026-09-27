"use client";

import { useState } from "react";

// A command or config a reader is meant to paste somewhere (CHE-318 guides).
// The copy happens in the click handler and the "copied" label resets from the
// same handler's timer — there is nothing to synchronise with, so no effect.
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (insecure context, permissions): the text stays
      // selectable, which is the fallback.
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-faint">
          {label ?? "copy"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="font-mono text-[12px] text-fg-muted transition-colors hover:text-fg"
          aria-label={`Copy ${label ?? "code"}`}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6 text-fg">
        <code className="select-all">{code}</code>
      </pre>
    </div>
  );
}
