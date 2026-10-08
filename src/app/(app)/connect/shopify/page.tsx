import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ConnectShopifyForm } from "@/components/connect-shopify-form";
import { CONNECT_COPY } from "@/lib/sign-in-copy";
import { teamHasFeature } from "@/lib/team-features";

// CHE-333: connecting a Shopify app starts from its store, not from an
// address — the app lives inside the store's admin. Next: sign in to the store
// on our page, then choose the app (health/apps/[appId]/sign-in).
//
// CHE-433: only for a team given the "shopify" feature; for any other team the
// page does not exist.
export default async function ConnectShopifyPage() {
  const { db, team } = await requireUser();
  if (!(await teamHasFeature(db, team.id, "shopify"))) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{CONNECT_COPY.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-fg-muted">{CONNECT_COPY.intro}</p>
      <ConnectShopifyForm />
    </div>
  );
}
