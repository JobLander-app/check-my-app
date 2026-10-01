import type { Config } from "tailwindcss";

// Dark deploy-log aesthetic. Status palette is product-canonical — see Mockups
// "Visual / brand notes": green ✅ ok · yellow 🟡 confusing · orange ⚠ risky ·
// red 🔴 broken · purple ⚠ exposed. Stick to these everywhere.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        ink: {
          950: "#08090c", // page background
          900: "#0d0f14", // raised surface
          850: "#12151c", // card
          800: "#181c25", // hover / inset
          750: "#1b2130", // the sidebar's active item (CHE-351)
          700: "#232936", // borders strong
          600: "#2e3545", // borders
        },
        fg: {
          DEFAULT: "#e8eaf0",
          muted: "#9aa3b5",
          faint: "#5d6678",
          // Sidebar group labels: sentence case at 12px, never a tracked caps
          // eyebrow (owner, CHE-336).
          label: "#7d8699",
        },
        accent: {
          DEFAULT: "#4f8cff", // primary action blue
          hover: "#3a7bff",
        },
        status: {
          ok: "#3ecf6e",
          confusing: "#e8c83b",
          risky: "#ff8c42",
          broken: "#ff5252",
          exposed: "#b06bff",
        },
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        glow: "0 0 0 1px rgba(79,140,255,0.35), 0 0 24px -6px rgba(79,140,255,0.45)",
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
  plugins: [],
};

export default config;
