import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// Dark deploy-log aesthetic. Status palette is product-canonical — see Mockups
// "Visual / brand notes": green ✅ ok · yellow 🟡 confusing · orange ⚠ risky ·
// red 🔴 broken · purple ⚠ exposed. Stick to these everywhere.
//
// CHE-414: two themes, one set of class names. Every colour a component asks
// for (`bg-ink-850`, `text-status-ok/40`) resolves to a CSS variable on <html>,
// and the variables are what a theme changes. The dark values are the product
// as it has always looked; the light ones are chosen so that every text token
// reads at 4.5:1 or better on every surface it can land on
// (scripts/verify-theme-tokens.ts computes the table). The server decides the
// theme from the `cma_theme` cookie and renders it as `data-theme` on <html>
// (src/lib/theme.ts); with no cookie the browser's own preference decides.
export const THEME_TOKENS = {
  ink: {
    950: { dark: "#08090c", light: "#f4f5f8" }, // page background
    900: { dark: "#0d0f14", light: "#fafbfc" }, // raised surface
    850: { dark: "#12151c", light: "#ffffff" }, // card
    800: { dark: "#181c25", light: "#eaedf2" }, // hover / inset
    750: { dark: "#1b2130", light: "#e2e6ee" }, // the sidebar's active item (CHE-351)
    700: { dark: "#232936", light: "#e1e5ec" }, // borders strong
    600: { dark: "#2e3545", light: "#cfd5df" }, // borders
  },
  fg: {
    DEFAULT: { dark: "#e8eaf0", light: "#14171f" },
    muted: { dark: "#9aa3b5", light: "#4b5566" },
    faint: { dark: "#5d6678", light: "#5b6474" },
    // Sidebar group labels: sentence case at 12px, never a tracked caps
    // eyebrow (owner, CHE-336).
    label: { dark: "#7d8699", light: "#545d6c" },
  },
  accent: {
    DEFAULT: { dark: "#4f8cff", light: "#1d4ed8" }, // primary action blue
    hover: { dark: "#3a7bff", light: "#1e40af" },
    soft: { dark: "#7db0ff", light: "#60a5fa" }, // the highlight in the progress shimmer
  },
  // What lies over the page behind a drawer: the page's own black in the dark,
  // a blue-black in the light, where the page colour would only wash it out.
  scrim: {
    DEFAULT: { dark: "#08090c", light: "#101828" },
  },
  status: {
    ok: { dark: "#3ecf6e", light: "#14703a" },
    confusing: { dark: "#e8c83b", light: "#7f5d00" },
    risky: { dark: "#ff8c42", light: "#ad3a08" },
    broken: { dark: "#ff5252", light: "#b91c1c" },
    exposed: { dark: "#b06bff", light: "#8b2fd6" },
  },
} as const;

export type ThemeName = "dark" | "light";

// `--ink-950`, `--fg`, `--fg-muted`, `--status-ok`: the group and the shade,
// the DEFAULT shade being the group alone.
export function tokenVariable(group: string, shade: string): string {
  return shade === "DEFAULT" ? `--${group}` : `--${group}-${shade}`;
}

// A hex colour as the "r g b" channels a variable holds, so Tailwind's
// `rgb(var(--x) / <alpha-value>)` keeps every `/50` opacity working.
export function channels(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
}

export function themeVariables(theme: ThemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [group, shades] of Object.entries(THEME_TOKENS)) {
    for (const [shade, value] of Object.entries(shades)) {
      vars[tokenVariable(group, shade)] = channels(value[theme]);
    }
  }
  return vars;
}

// Everything that is not a flat colour but still differs by theme: the card's
// resting shadow and the focus glow. Both read the variables above, so only the
// shadow's own black-or-white light has to be stated per theme.
const SURFACE: Record<ThemeName, Record<string, string>> = {
  dark: {
    // What a shadow is made of: pure black under dark surfaces, a cool
    // blue-black under light ones.
    "--shadow-ink": "0 0 0",
    "--shadow-card": "0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 8px 24px -12px rgb(var(--shadow-ink) / 0.6)",
    "--shadow-glow": "0 0 0 1px rgb(var(--accent) / 0.35), 0 0 24px -6px rgb(var(--accent) / 0.45)",
    // Film grain on the page — see body::before in globals.css.
    "--grain-opacity": "0.5",
    "color-scheme": "dark",
  },
  light: {
    "--shadow-ink": "16 24 40",
    "--shadow-card": "0 1px 0 0 rgb(255 255 255 / 0.6) inset, 0 8px 24px -12px rgb(var(--shadow-ink) / 0.12)",
    "--shadow-glow": "0 0 0 1px rgb(var(--accent) / 0.35), 0 0 24px -6px rgb(var(--accent) / 0.25)",
    // The grain is white noise, which a white page cannot show.
    "--grain-opacity": "0",
    "color-scheme": "light",
  },
};

// Clerk's sign-in and account menu read `--clerk-color-*` from the page, so
// they follow the theme with no appearance object and no script. Clerk parses
// each value as a colour of its own (to derive its hover and alpha shades), so
// these are flat hex values, not references to the variables above.
function clerkVariables(theme: ThemeName): Record<string, string> {
  const t = THEME_TOKENS;
  return {
    "--clerk-color-background": t.ink[850][theme],
    "--clerk-color-foreground": t.fg.DEFAULT[theme],
    "--clerk-color-muted-foreground": t.fg.muted[theme],
    "--clerk-color-muted": t.ink[800][theme],
    "--clerk-color-input": t.ink[900][theme],
    "--clerk-color-input-foreground": t.fg.DEFAULT[theme],
    // Clerk dilutes these two itself (its outlines are the border at 7–11%),
    // so both are the full-strength foreground, as its own black-or-white
    // defaults are — a pre-diluted grey here became no outline at all.
    "--clerk-color-border": t.fg.DEFAULT[theme],
    "--clerk-color-neutral": t.fg.DEFAULT[theme],
    "--clerk-color-primary": t.accent.DEFAULT[theme],
    "--clerk-color-primary-foreground": t.ink[950][theme],
    "--clerk-color-danger": t.status.broken[theme],
    "--clerk-color-success": t.status.ok[theme],
    "--clerk-color-warning": t.status.risky[theme],
    "--clerk-color-ring": t.accent.DEFAULT[theme],
  };
}

function themeBlock(theme: ThemeName): Record<string, string> {
  return { ...themeVariables(theme), ...SURFACE[theme], ...clerkVariables(theme) };
}

function tailwindColors(): Record<string, Record<string, string>> {
  const colors: Record<string, Record<string, string>> = {};
  for (const [group, shades] of Object.entries(THEME_TOKENS)) {
    colors[group] = {};
    for (const shade of Object.keys(shades)) {
      colors[group][shade] = `rgb(var(${tokenVariable(group, shade)}) / <alpha-value>)`;
    }
  }
  return colors;
}

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: tailwindColors(),
      boxShadow: {
        card: "var(--shadow-card)",
        glow: "var(--shadow-glow)",
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        blink: "blink 1.1s steps(1) infinite",
        shimmer: "shimmer 2.2s linear infinite",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.4", transform: "scale(0.85)" },
        },
      },
    },
  },
  plugins: [
    // The theme blocks, emitted from the one table above so the two light
    // blocks cannot drift apart: an explicit choice on <html>, and the
    // browser's preference when nothing was chosen.
    plugin(({ addBase }) => {
      addBase({
        ":root": themeBlock("dark"),
        ':root[data-theme="light"]': themeBlock("light"),
        "@media (prefers-color-scheme: light)": {
          ':root:not([data-theme="dark"])': themeBlock("light"),
        },
      });
    }),
  ],
};

export default config;
