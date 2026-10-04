// Dark, light, or whatever the browser prefers (CHE-414).
//
// The choice is a cookie, not a column: it belongs to a browser, not to a
// person — the same account on a phone at night and a monitor by day may want
// two answers, and a signed-out visitor on the public site gets to choose too.
// The server reads it and renders `data-theme` on <html> (src/app/layout.tsx),
// so the first paint is already the right colour; the browser's own
// preference decides when nothing was chosen, through prefers-color-scheme in
// the stylesheet. No script ever applies a theme.

export const THEME_COOKIE = "cma_theme";

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

// An absent or foreign cookie value is "system": the stylesheet's default.
export function parseTheme(value: string | undefined): Theme {
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : "system";
}

// What <html data-theme> carries. "system" carries nothing — the attribute's
// absence is what lets the prefers-color-scheme rule apply.
export function htmlTheme(theme: Theme): "dark" | "light" | undefined {
  return theme === "system" ? undefined : theme;
}
