"use client";

import { useActionState } from "react";
import { connectShopifyApp } from "@/app/(app)/connect/shopify/actions";
import { CONNECT_COPY } from "@/lib/sign-in-copy";
import { Button } from "./ui/button";

export function ConnectShopifyForm() {
  const [state, action, pending] = useActionState(connectShopifyApp, null);
  return (
    <form action={action} className="mt-6 flex max-w-xl flex-col gap-3">
      <label htmlFor="link" className="text-sm font-medium">{CONNECT_COPY.label}</label>
      <input
        id="link"
        name="link"
        type="text"
        inputMode="url"
        required
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder={CONNECT_COPY.placeholder}
        className="rounded border border-ink-700 bg-transparent px-3 py-2 text-sm"
      />
      <Button type="submit" variant="primary" disabled={pending} className="h-9 self-start px-3.5 py-0 text-sm">
        {pending ? CONNECT_COPY.submitting : CONNECT_COPY.submit}
      </Button>
      {state?.error && <p role="alert" className="text-sm text-status-broken">{state.error}</p>}
    </form>
  );
}
