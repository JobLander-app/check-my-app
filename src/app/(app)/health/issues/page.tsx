import { PageSoon } from "@/components/shell/page-soon";

// Health → Issues: built by CHE-360 on CHE-354's recurring issues.
export default function IssuesPage() {
  return (
    <PageSoon
      title="Issues"
      what="Every open problem across your apps in one list, with the ones that keep coming back marked as recurring. This page is on its way."
      meanwhile={{ text: "Until then, each app's latest check lists what it found.", href: "/health/apps", label: "All apps →" }}
    />
  );
}
