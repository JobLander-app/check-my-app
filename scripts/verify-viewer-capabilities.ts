// CHE-108 verification: the verdict page offers each control exactly when the
// server would honour it — no stricter, no looser.
//
// Every server rule is restated here as an oracle written straight from the
// route it copies, then the page's helper is checked against it for every
// viewer × run combination. If a route changes its gate, this is where the
// page is caught still promising the old one.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-viewer-capabilities.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { viewerCapabilities, type ViewerCapabilities } from "@/lib/viewer-capabilities";
import {
  FINDING_INTERNAL_FIELDS,
  FINDING_PUBLIC_FIELDS,
  FINDING_PUBLIC_SELECT,
} from "@/lib/finding-fields";
// Prisma's own list of Finding columns: the schema is the source of truth for
// what must be classified, so adding a column cannot quietly skip this file.
import { FindingScalarFieldEnum } from "@/generated/prisma/internal/prismaNamespace";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const OWNER = "user_owner";
const STRANGER = "user_stranger";

type Viewer = { id: string } | null;
type Run = { ownerId: string | null; hasWatch: boolean };

// canMutateOwned (src/lib/auth.ts): anonymous run → true; owned → viewer is owner.
function canMutateOwned(run: Run, viewer: Viewer): boolean {
  if (!run.ownerId) return true;
  return viewer !== null && viewer.id === run.ownerId;
}

// What each route would answer. Written from the routes, not from the helper.
function serverWouldAllow(run: Run, viewer: Viewer, hasApp: boolean): ViewerCapabilities {
  const canMutate = canMutateOwned(run, viewer);
  const isOwner = viewer !== null && viewer.id === run.ownerId;
  return {
    // src/lib/recheck.ts: canMutateOwned, then anonymous + full → refused.
    recheck: canMutate,
    fullRecheck: canMutate && run.ownerId !== null,
    // src/lib/watch-enable.ts: unauthenticated → sign-in (the page keeps the
    // button as the conversion path); owned by someone else → forbidden.
    // Already watched → the page shows a link, not the button.
    enableWatch: !run.hasWatch && (viewer === null ? run.ownerId === null : run.ownerId === null || isOwner),
    // src/app/watch/[slug]/page.tsx: requireUser + own App with a watch.
    watchSettings: run.hasWatch && isOwner,
    // src/app/api/findings/[id]/route.ts: canMutateOwned.
    markFindings: canMutate,
    // src/app/api/findings/[id]/ticket/route.ts: signed in, own App row for the
    // slug, and (anonymous run or owner).
    createTicket: viewer !== null && hasApp && (run.ownerId === null || isOwner),
    // src/app/api/runs/[id]/export-specs/route.ts: signed in (else sign-in —
    // conversion path, same as watch), owned run only by its owner.
    exportSpecs: viewer === null ? run.ownerId === null : run.ownerId === null || isOwner,
  };
}

const viewers: [string, Viewer][] = [
  ["anonymous", null],
  ["owner", { id: OWNER }],
  ["stranger", { id: STRANGER }],
];
const runs: [string, Run][] = [
  ["anonymous run", { ownerId: null, hasWatch: false }],
  ["owned run", { ownerId: OWNER, hasWatch: false }],
  ["owned + watched run", { ownerId: OWNER, hasWatch: true }],
];

for (const [vName, viewer] of viewers) {
  for (const [rName, run] of runs) {
    for (const hasApp of [false, true]) {
      // An App row belongs to a signed-in user; an anonymous viewer has none.
      if (viewer === null && hasApp) continue;
      const expected = serverWouldAllow(run, viewer, hasApp);
      const got = viewerCapabilities({
        run,
        viewer,
        viewerApp: hasApp ? { id: "app_1" } : null,
        canMutate: canMutateOwned(run, viewer),
      });
      const diff = (Object.keys(expected) as (keyof ViewerCapabilities)[])
        .filter((k) => expected[k] !== got[k])
        .map((k) => `${k}: page ${got[k]}, server ${expected[k]}`);
      check(`${vName} on ${rName}${hasApp ? " (has App row)" : ""}`, diff.length === 0, diff.join("; "));
    }
  }
}

// The two failures this exists to prevent, spelled out so a regression reads
// as the product defect it is rather than a table mismatch.
const strangerOnOwned = viewerCapabilities({
  run: { ownerId: OWNER, hasWatch: false },
  viewer: { id: STRANGER },
  viewerApp: { id: "app_stranger" },
  canMutate: false,
});
check(
  "a stranger on an owned run is offered nothing",
  Object.values(strangerOnOwned).every((v) => v === false),
  JSON.stringify(strangerOnOwned),
);

const ownerFreshRun = viewerCapabilities({
  run: { ownerId: OWNER, hasWatch: false },
  viewer: { id: OWNER },
  viewerApp: null, // no onboarding yet, no Enable Watch yet — no App row
  canMutate: true,
});
check(
  "the owner of a fresh run (no App row yet) keeps re-check, full re-check, watch, marks and export",
  ownerFreshRun.recheck &&
    ownerFreshRun.fullRecheck &&
    ownerFreshRun.enableWatch &&
    ownerFreshRun.markFindings &&
    ownerFreshRun.exportSpecs &&
    !ownerFreshRun.createTicket,
  JSON.stringify(ownerFreshRun),
);

const anonOnAnon = viewerCapabilities({
  run: { ownerId: null, hasWatch: false },
  viewer: null,
  viewerApp: null,
  canMutate: true,
});
check(
  "an anonymous visitor on an anonymous run keeps re-check, marks and the Enable Daily Watch conversion path, but not full re-check",
  anonOnAnon.recheck && anonOnAnon.markFindings && anonOnAnon.enableWatch && !anonOnAnon.fullRecheck,
  JSON.stringify(anonOnAnon),
);

// CHE-202: an ephemeral run (a PR preview) has no App and must never get one.
// The owner keeps what is about the run — re-check, full re-check, marks —
// and is not offered anything that would create or need an App: Enable Daily
// Watch (src/lib/watch-enable.ts refuses with kind "ephemeral"), Create Ticket
// and Export to GitHub (both routes answer 409 ephemeral_run).
const ownerEphemeral = viewerCapabilities({
  run: { ownerId: OWNER, hasWatch: false, ephemeral: true },
  viewer: { id: OWNER },
  // Even with an App row for the same slug (a preview host colliding with an
  // onboarded app's name), the ephemeral run does not use it.
  viewerApp: { id: "app_same_slug" },
  canMutate: true,
});
check(
  "the owner of an ephemeral run keeps re-check, full re-check and marks, and is offered no watch, ticket or export",
  ownerEphemeral.recheck &&
    ownerEphemeral.fullRecheck &&
    ownerEphemeral.markFindings &&
    !ownerEphemeral.enableWatch &&
    !ownerEphemeral.watchSettings &&
    !ownerEphemeral.createTicket &&
    !ownerEphemeral.exportSpecs,
  JSON.stringify(ownerEphemeral),
);

// ─── CHE-215: what a Finding may carry into a browser ────────────────────────
//
// The verdict page hands its findings to FindingsList, a client component, so
// every column on them is serialized into the RSC payload whether or not it is
// rendered — readable in view-source. `anchor` is our own record of what a
// finding was allowed to rest on, and rule 1 keeps that out of what a customer
// reads. The `select` on that query fixes today; this fixes tomorrow, when
// somebody adds a column and has no reason to think about serialization.
{
  const publicFields = new Set<string>(FINDING_PUBLIC_FIELDS);
  const internalFields = new Set<string>(FINDING_INTERNAL_FIELDS);
  const columns = Object.keys(FindingScalarFieldEnum);

  const unclassified = columns.filter((c) => !publicFields.has(c) && !internalFields.has(c));
  check(
    "every Finding column is classified public or internal — a new one fails here until it is",
    unclassified.length === 0,
    unclassified.join(", ") || "none unclassified",
  );
  const phantom = [...publicFields, ...internalFields].filter((f) => !columns.includes(f));
  check("…and neither list names a column that no longer exists", phantom.length === 0, phantom.join(", ") || "none");
  check(
    "…the two lists do not overlap",
    [...publicFields].every((f) => !internalFields.has(f)),
  );

  check("anchor is internal", internalFields.has("anchor") && !publicFields.has("anchor"));
  check(
    "the select handed to the client carries every public column and no internal one",
    Object.keys(FINDING_PUBLIC_SELECT).sort().join(",") === [...publicFields].sort().join(",") &&
      [...internalFields].every((f) => !(f in FINDING_PUBLIC_SELECT)),
    Object.keys(FINDING_PUBLIC_SELECT).join(","),
  );
  // The page must not have gone back to a blanket include: a `select` naming
  // the projection is the only shape that keeps an added column out by default.
  const page = readFileSync(
    fileURLToPath(new URL("../src/components/verdict-view.tsx", import.meta.url)),
    "utf8",
  );
  const findingsQuery = page.slice(page.indexOf("findings: {"), page.indexOf("watch: {"));
  check(
    "the verdict page selects findings through the projection, never `include`",
    findingsQuery.includes("FINDING_PUBLIC_SELECT") && !findingsQuery.includes("include:"),
    findingsQuery.replace(/\s+/g, " ").slice(0, 120),
  );
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

const extensionOwner = viewerCapabilities({ run: { ownerId: 'owner', hasWatch: false, targetKind: 'extension' }, viewer: { id: 'owner' }, viewerApp: { id: 'app' }, canMutate: true });
if (extensionOwner.enableWatch || !extensionOwner.recheck || !extensionOwner.exportSpecs) throw new Error('Extension verdict must offer on-demand actions without an impossible Watch');
