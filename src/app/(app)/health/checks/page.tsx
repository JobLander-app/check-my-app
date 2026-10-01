import { PageSoon } from "@/components/shell/page-soon";

// Health → Checks: built by CHE-360.
export default function ChecksPage() {
  return (
    <PageSoon
      title="Checks"
      what="Every check of every app: how it started, what it found and what it was priced at, with the reason for the price. This page is on its way."
      meanwhile={{ text: "Until then, each app's checks are on its own page.", href: "/health/apps", label: "All apps →" }}
    />
  );
}
