"use client";

import { usePathname } from "next/navigation";
import { isAppShellPath } from "@/lib/app-shell";

// The public site's header, everywhere except inside the signed-in app, which
// has its sidebar instead (CHE-351). The root layout cannot see route groups,
// so the address decides — from the list the (app) group is checked against.
export function SiteHeaderGate({ children }: { children: React.ReactNode }) {
  return isAppShellPath(usePathname()) ? null : children;
}
