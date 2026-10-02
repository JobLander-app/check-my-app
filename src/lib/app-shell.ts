// The signed-in app's address space (CHE-351, epic CHE-348 direction C).
//
// Every page under src/app/(app) renders inside the sidebar shell and without
// the public site's header. The route group decides the first; the header
// cannot see route groups, so it asks this list. scripts/verify-app-shell.ts
// holds the two to each other: every top-level folder of (app) is here, and
// nothing here lacks its folder.
export const APP_SHELL_PREFIXES = ["/home", "/health", "/release", "/product", "/settings"] as const;

export function isAppShellPath(pathname: string): boolean {
  return APP_SHELL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export { MOVED_ROUTES } from "./moved-routes.mjs";

export const appPath = {
  page: (appId: string) => `/health/apps/${appId}`,
  settings: (appId: string) => `/health/apps/${appId}/settings`,
  schedule: (appId: string) => `/health/apps/${appId}/settings/schedule`,
  section: (appId: string, section: string) => `/health/apps/${appId}/settings/${section}`,
  check: (appId: string, runNumber: number) => `/health/apps/${appId}/checks/${runNumber}`,
};

// Where a check opens from inside the app (CHE-371): on its app's page tree,
// with the sidebar. A check that belongs to no saved app (a preview, a one-off
// address) has no such page and opens on its public permalink — which is also
// the link to share, for every check.
export function checkHref(run: { appId: string | null; runNumber: number; publicId: string }): string {
  return run.appId ? appPath.check(run.appId, run.runNumber) : `/verdict/${run.publicId}`;
}
