import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { loadVerdict } from "@/lib/run-read";

// GET /api/runs/{publicId}/verdict — structured verdict for automation (CI
// hooks, and the MCP tools through the same loader in src/lib/run-read.ts).
// Same visibility as the verdict page: knowledge of the unguessable publicId is
// the capability.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const verdict = await loadVerdict(prisma, (await params).id);
  if (!verdict) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(verdict);
}
