import { getDbFromContext } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";
import { VerdictView } from "@/components/verdict-view";
import { OG_IMAGE, canonical } from "@/lib/site-metadata";
import { extensionDisplayName } from "@/lib/extension-target";
import { publicRow } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

// CHE-108: a verdict link is the one people paste — into a post, a message, a
// thread with their team — and it used to arrive as a grey card carrying the
// site's generic tagline. It should say whose product was checked and how it
// came out.
//
// Named after the customer's product, never ours (rule §1): the only figure
// here is how many problems we found on it, and nothing about how we looked.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const { id } = await params;
  const run = await prisma.run.findUnique({ ...publicRow(),
    where: { publicId: id },
    select: { appSlug: true, targetKind: true, targetUrl: true, extensionEvidence: true, verdict: true, _count: { select: { findings: true } } },
  });
  if (!run) return {};

  const label = run.verdict ? (VERDICT_META[run.verdict]?.label ?? null) : null;
  const n = run._count.findings;
  const found =
    n === 0
      ? "Nothing to fix was found."
      : `${n} thing${n === 1 ? "" : "s"} to fix ${n === 1 ? "was" : "were"} found.`;

  const name = run.targetKind === "extension" ? extensionDisplayName(run.targetUrl, run.extensionEvidence) : run.appSlug;
  const title = label ? `${name} — ${label}` : name;
  const description = `${found} Open the check to see what someone using ${name} runs into, and where.`;
  // The image travels with the page: Next replaces the layout's openGraph
  // object wholesale, so leaving `images` out here meant no og:image at all.
  return {
    title,
    description,
    alternates: canonical(`/verdict/${id}`),
    openGraph: { title, description, type: "article", images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" as const, title, description, images: [OG_IMAGE.url] },
  };
}

// Screen 3 — Verdict · /verdict/{id} — the permalink: what people share, and
// what a signed-out reader opens. The verdict itself is VerdictView
// (src/components/verdict-view.tsx), which the signed-in app renders too, inside
// its shell (CHE-371).
export default async function VerdictPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ watch_error?: string; recheck?: string; balance?: string }>;
}) {
  const { watch_error: watchError, recheck, balance } = await searchParams;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <VerdictView id={(await params).id} watchError={watchError} recheck={recheck} balance={balance} />
    </main>
  );
}
