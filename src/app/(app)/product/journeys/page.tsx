import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { productLensFor } from "@/lib/viewer-flags";
import { PageSoon } from "@/components/shell/page-soon";

// Product β → Journeys: built by CHE-362. Behind the lens-product flag, read
// here on the server; with the flag off the address does not exist (CHE-352).
export default async function JourneysPage() {
  const { user } = await requireUser();
  if (!(await productLensFor(user))) notFound();
  return (
    <PageSoon
      title="Journeys"
      what="Each journey through your apps as a strip of the real screens we walked, step by step. This page is on its way."
      meanwhile={{ text: "Until then, every verdict shows its journeys with their screenshots.", href: "/health/apps", label: "All apps →" }}
    />
  );
}
