import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { releaseLensFor } from "@/lib/viewer-flags";
import { PageSoon } from "@/components/shell/page-soon";

// Release β: built by CHE-367. Behind the lens-release flag, read here on the
// server; with the flag off the address does not exist (CHE-352).
export default async function ReleasesPage() {
  const { user } = await requireUser();
  if (!(await releaseLensFor(user))) notFound();
  return (
    <PageSoon
      title="Releases"
      what="Every release of every app: what its check found, and what it broke or fixed against the release before. This page is on its way."
      meanwhile={{ text: "Until then, each app's checks are listed on its own page, newest first.", href: "/health/apps", label: "All apps →" }}
    />
  );
}
