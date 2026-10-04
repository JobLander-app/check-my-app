import * as React from "react";
import { cn } from "@/lib/utils";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2.5 text-sm text-fg outline-none transition-colors focus:border-accent focus:shadow-glow",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
