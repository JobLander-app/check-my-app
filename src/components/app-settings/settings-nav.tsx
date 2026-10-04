"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The settings sub-navigation (CHE-359). The current section comes from the
// address as it renders — no state, no effect.
export function SettingsNav({ base, sections }: { base: string; sections: { key: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1.5">
      {sections.map((s) => {
        const href = `${base}/${s.key}`;
        const current = pathname === href;
        return (
          <Link
            key={s.key}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-full border px-3.5 text-[13px] ${
              current ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
            } ${s.key === "remove" ? "sm:ml-auto" : ""}`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
