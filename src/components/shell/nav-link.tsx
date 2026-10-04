"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// A sidebar item that knows whether it is the page you are on (CHE-351). The
// answer comes from the URL as it renders — usePathname, not an effect — so the
// highlight is right in the server HTML and on every client navigation.
export function NavLink({
  href,
  exact = false,
  className,
  children,
}: {
  href: string;
  exact?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || (!exact && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
        active ? "bg-ink-750 text-fg" : "text-fg-muted hover:bg-ink-800 hover:text-fg",
        className,
      )}
    >
      {children}
    </Link>
  );
}
