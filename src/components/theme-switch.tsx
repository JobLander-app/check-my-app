import { setThemeAction } from "@/app/(app)/settings/account/actions";
import { THEME_LABELS, THEMES, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Three buttons, one pressed (CHE-414). Each is its own form posting the
// server action, so the choice is an event handled where it happens and the
// page comes back already recoloured; nothing on the client watches anything.
export function ThemeSwitch({ current }: { current: Theme }) {
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-lg border border-ink-600 bg-ink-900 p-0.5">
      {THEMES.map((theme) => (
        <form key={theme} action={setThemeAction.bind(null, theme)}>
          <button
            type="submit"
            aria-pressed={theme === current}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              theme === current ? "bg-ink-750 font-medium text-fg" : "text-fg-muted hover:bg-ink-800 hover:text-fg",
            )}
          >
            {THEME_LABELS[theme]}
          </button>
        </form>
      ))}
    </div>
  );
}
