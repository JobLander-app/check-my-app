import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "outline" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-ink-950 font-semibold hover:bg-accent-hover disabled:bg-ink-700 disabled:text-fg-faint",
  ghost: "bg-transparent text-fg-muted hover:bg-ink-800 hover:text-fg",
  outline: "border border-ink-600 bg-ink-850 text-fg hover:border-ink-700 hover:bg-ink-800",
  danger:
    "border border-status-broken/40 bg-status-broken/10 text-status-broken hover:bg-status-broken/20",
};

// The classes a Button renders with, for a link that has to look like one
// (`<Link className={buttonClass("outline")}>`) — one definition, not a copy.
export function buttonClass(variant: Variant = "primary", className?: string) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm transition-colors disabled:cursor-not-allowed",
    variants[variant],
    className,
  );
}

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(({ className, variant = "primary", ...props }, ref) => (
  <button ref={ref} className={buttonClass(variant, className)} {...props} />
));
Button.displayName = "Button";
