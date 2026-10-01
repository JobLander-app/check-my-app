import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { hashClientKey } from "@/lib/crypto";
import { createRecheckRun } from "@/lib/recheck";
import { canMutateOwnedFromRequest } from "@/lib/auth";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { isBalanceExhausted } from "@/lib/balance-events";
import { BALANCE_PATH, PRICING_PATH } from "@/lib/balance-links";

// POST /api/runs/{publicId}/recheck — Journey 7: re-run with the same params.
// Logic shared with the verdict page's server action (CHE-73) in lib/recheck.
//
// Contract (CHE-327 — both forms spend the team's balance like any check):
//   POST …/recheck          the regular re-check — the ladder (smoke / partial /
//                           full decided by what changed). 201 { id }
//   POST …/recheck?full=1   a full re-check (CHE-74: walks everything, no
//                           shortcut). 201 { id }
//   Either form:            200 { id, reused: true }  anonymous caller, a fresh
//                                                   verdict already exists
//                           403 { error, code }     the balance is too low
//                                                   (+ buy_url, upgrade_url),
//                                                   the anonymous daily cap, a
//                                                   full re-check by an
//                                                   anonymous caller, or not
//                                                   the owner
//                           404 { error }
//   Body (optional JSON):   { "testPassword": "…" } — the owed re-check of a
//                           failed $1 check that signed in (CHE-335); without
//                           it that case answers 403 code password_needed.
//                           { "storePassword": "…" } — the same for a
//                           password-protected store (CHE-372).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never starts a re-check. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  const full = new URL(req.url).searchParams.get("full") === "1";
  const anonKeyHash = await hashClientKey(req.headers.get("cf-connecting-ip"));
  const body: unknown = await req.json().catch(() => null);
  const pw = body && typeof body === "object" && "testPassword" in body ? body.testPassword : undefined;
  const testPassword = typeof pw === "string" && pw ? pw.slice(0, 500) : undefined;
  const spw = body && typeof body === "object" && "storePassword" in body ? body.storePassword : undefined;
  const storePassword = typeof spw === "string" && spw ? spw.slice(0, 500) : undefined;
  // CHE-263: the caller may be a browser session or an API key, and both are
  // answered the same way — by the row's team, not by which helper this route
  // happens to call. That accident is what refused the owner's own key
  // (CHE-246).
  const result = await createRecheckRun(prisma, (await params).id, { full, anonKeyHash, testPassword, storePassword }, {
    canMutate: (db, row) => canMutateOwnedFromRequest(db, req, row),
    source: "api",
  });
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (result.kind === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (result.kind === "quota") {
    const origin = new URL(req.url).origin;
    return NextResponse.json(
      {
        error: result.reason,
        ...(result.code ? { code: result.code } : {}),
        ...(isBalanceExhausted(result.code)
          ? { buy_url: `${origin}${BALANCE_PATH}`, upgrade_url: `${origin}${PRICING_PATH}` }
          : {}),
      },
      { status: 403 },
    );
  }
  if (result.kind === "reused") {
    return NextResponse.json({ id: result.publicId, reused: true }, { status: 200 });
  }
  return NextResponse.json({ id: result.publicId }, { status: 201 });
}
