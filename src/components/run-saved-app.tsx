"use client";

import { useActionState } from "react";
import { runSavedApp } from "@/app/dashboard/actions";
import { Button } from "./ui/button";

// `primary` is the App page's main action (CHE-358); elsewhere it is one of
// several and stays an outline.
export function RunSavedApp({ appId, primary = false }: { appId: string; primary?: boolean }) {
  const [state, action, pending] = useActionState(runSavedApp.bind(null, appId), null);
  return <form action={action} className="flex flex-col items-start gap-2">
    <Button
      type="submit"
      variant={primary ? "primary" : "outline"}
      disabled={pending}
      className={primary ? "h-9 px-3.5 py-0 text-sm" : "text-xs"}
    >
      {pending ? "Starting…" : primary ? "Run a check" : "Run check"}
    </Button>
    {state?.error && <p role="alert" className="max-w-xs text-xs text-status-broken">{state.error}</p>}
  </form>;
}
