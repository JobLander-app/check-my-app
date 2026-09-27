import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { loadRunStatus } from "@/lib/run-read";

// GET /api/runs/{publicId} — run status + live feed for the in-progress page.
// The payload is shared with the MCP status tools (src/lib/run-read.ts).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await loadRunStatus(prisma, (await params).id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}
