import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { explainRunPrice } from "@/lib/check-price";

// GET /api/runs/{publicId}/price — why a check cost what it cost (CHE-411):
// the same explanation the MCP tools carry, for the price modal on a page that
// lists many checks and loads a reason only when one is asked for. A read of
// the caller's team (src/lib/route-scopes.ts); explainRunPrice looks the run up
// within that team, so another team's run is simply not found. The team whose
// balance paid is the only reader.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "read");
  if (!decision.ok) return decision.response;
  const explanation = await explainRunPrice(db, decision.grant.team.id, (await params).id);
  if (!explanation) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(explanation);
}
