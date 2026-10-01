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
};
