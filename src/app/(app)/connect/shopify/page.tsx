import { requireUser } from "@/lib/auth";
import { ConnectShopifyForm } from "@/components/connect-shopify-form";
import { CONNECT_COPY } from "@/lib/sign-in-copy";

// CHE-333: connecting a Shopify app starts from its store, not from an
// address — the app lives inside the store's admin. Next: sign in to the store
// on our page, then choose the app (health/apps/[appId]/sign-in).
export default async function ConnectShopifyPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{CONNECT_COPY.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-fg-muted">{CONNECT_COPY.intro}</p>
      <ConnectShopifyForm />
    </div>
  );
}
