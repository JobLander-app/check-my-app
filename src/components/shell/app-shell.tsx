"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

// The signed-in frame (CHE-351): a 240px sidebar beside the page from 900px
// up; below that the sidebar is a drawer behind a menu button, and nothing on
// the page may be wider than the phone.
//
// The sidebar arrives already rendered by the server (src/app/(app)/layout.tsx):
// which groups exist depends on feature flags, and flags are read on the server
// only (CHE-381). This component holds one bit — is the drawer open — and is
// told nothing about why the sidebar looks the way it does. It closes when a
// link inside it is followed or Escape is pressed: both are events, so both are
// handled where they happen.
export function AppShell({
  sidebar,
  account,
  children,
}: {
  sidebar: React.ReactNode;
  account: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    // Escape is heard on the whole frame, not on the drawer: right after the
    // menu button opens it, focus is still on that button, outside the drawer.
    <div
      className="min-h-screen min-[900px]:flex"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-4 min-[900px]:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the menu"
          aria-expanded={open}
          aria-controls="app-sidebar"
          className="-ml-2 rounded-md px-2 py-1.5 text-lg leading-none text-fg-muted hover:bg-ink-800 hover:text-fg"
        >
          ☰
        </button>
        <Link href="/home" className="flex items-center gap-2 font-mono text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-[13px] font-semibold text-accent">
            ✓
          </span>
          checkmyapp
        </Link>
        <div className="flex w-8 justify-end">{account}</div>
      </div>

      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-ink-950/70 min-[900px]:hidden"
        />
      )}

      <aside
        id="app-sidebar"
        aria-label="Main"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className={cn(
          // The slide is the drawer's only: on a desktop the sidebar never moves.
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col overflow-y-auto border-r border-ink-700 bg-ink-900 max-[899px]:transition-transform max-[899px]:duration-200",
          "min-[900px]:visible min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:shrink-0 min-[900px]:translate-x-0",
          open ? "translate-x-0" : "invisible -translate-x-full",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close the menu"
          className="absolute right-2 top-3 rounded-md px-2 py-1 text-fg-muted hover:bg-ink-800 hover:text-fg min-[900px]:hidden"
        >
          ✕
        </button>
        {sidebar}
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
