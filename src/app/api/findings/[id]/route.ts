import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { canMutateOwned } from "@/lib/auth";
import { markFindingSchema } from "@/lib/validation";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { recountOpenIssues } from "@/lib/open-issues";

// PATCH /api/findings/{id} — Loop C: triage a finding from the verdict page
// (known / fixed / false_positive). Daily Check uses marks to filter noise.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never marks a finding. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  const json = await req.json().catch(() => null);
  const parsed = markFindingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.finding.findUnique({
    where: { id: (await params).id },
    select: { id: true, run: { select: { ownerId: true, appId: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  if (!(await canMutateOwned(prisma, existing.run.ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const finding = await prisma.finding.update({
    where: { id: existing.id },
    data: { mark: parsed.data.mark },
    select: { id: true, mark: true },
  });
  // CHE-399: a mark changes what Issues counts as open — the app's stored
  // number follows at once, so the menu and the page agree without a reload.
  // Best effort: the mark is stored whatever happens to the count.
  await recountOpenIssues(prisma, existing.run.appId);
  return NextResponse.json(finding);
}
