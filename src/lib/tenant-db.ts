// CHE-256 (Teams T3): every query for a row a team owns says, in the query,
// whose rows it is allowed to see.
//
// A guard at the door (T2) does not stop a query inside from reading the wrong
// row. There are 85 places in `src/app` and `src/lib` that read or write an
// App, Run, Watch, ApiKey or SettledSignature, and one
// `db.app.findFirst({ where: { appSlug } })` without a team clause serves
// another team's app while looking entirely normal in review. That is not a bug
// anyone would catch by reading; it is a bug that has to be impossible to write.
//
// So each of those queries carries one of five declarations (a raw statement
// binds `teamRows` instead — see below), and
// `scripts/verify-tenant-db.ts` fails the build for any tenant query that
// carries none — over the registry of call sites, so the FIRST query written
// without one is caught rather than the hundredth:
//
//   teamOwned(teamId)   — the team's own rows. Spread into `where` it scopes the
//                         query; spread into `data` it stamps the new row. The
//                         only one that changes what the query does.
//   alreadyScoped(why)  — the row is already pinned: by a unique key that names
//                         its owner, or by an id this request just read through
//                         one of these declarations. `why` is a closed list, so
//                         "it seemed fine" cannot be a reason.
//   publicRow()         — deliberately not scoped: the row is addressed by an
//                         unguessable publicId, slug or key hash, and knowing it
//                         IS the capability (CHE-33). The anonymous funnel and
//                         every shared verdict link live here.
//   ownerScoped()       — scoped to one PERSON on purpose, and only where that
//                         is still the rule: quota counting, until T7 (CHE-260)
//                         moves quotas to the team. Every call is a place that
//                         ticket must visit.
//   systemWide(reason)  — acting for everyone by definition: the janitor, the
//                         scheduler, measurement.
//
// They are spread into the query rather than wrapped around it because Prisma's
// types are computed from the exact argument object: a wrapper that re-infers
// `args` widens `orderBy: { createdAt: "desc" }` to `string` and the compiler
// stops helping at every call site. Spreading an object literal into an object
// literal costs nothing and keeps every type intact.

// The team's own rows. In a `where` it is the scope; in a `data` it is the
// stamp — the same fact, read or written.
export function teamOwned(teamId: string): { teamId: string } {
  return { teamId };
}

// The same declaration for a raw statement, which has no `where` to spread
// into: the team id passes through here on its way into the SQL, as
// `teamId = ${teamRows(teamId)}`. It changes nothing; it is what the verifier
// looks for — every `$queryRaw` / `$executeRaw` in request-serving code must
// bind one in its own arguments, and the `Unsafe` variants are not allowed
// there at all.
export function teamRows(teamId: string): string {
  return teamId;
}

// The row is already pinned to its tenant, so no clause is added. Empty on
// purpose: what it contributes is the sentence, and the fact that a reviewer
// can disagree with it.
export type ScopedReason =
  | "the unique key names the owner"
  | "already read in this request"
  | "created with its team"
  | "the App was just scoped to this team"
  | "the previous run names its own app"
  | "the caller resolved this app"
  | "settled signatures outlive the app they describe"
  // CHE-369: a signed GitHub delivery names its installation and repository;
  // the team is whoever connected that installation, read from the row.
  | "a signed GitHub delivery names the installation";

export function alreadyScoped(why: ScopedReason): Record<string, never> {
  void why;
  return {};
}

// Scoped to the teams a person belongs to, rather than to one of them. The only
// honest use is answering "is this row in a team of yours" — the deep-link
// offer in T8, where the alternative is a 404 on a row the person is entitled
// to see. It never grants an action: switching teams is still an explicit act,
// and the scope that decides is the one they have in THAT team.
export function memberOfRows(userId: string): { team: { memberships: { some: { userId: string } } } } {
  return { team: { memberships: { some: { userId } } } };
}

// Addressed by an unguessable publicId, slug or key hash. A verdict link works
// for whoever holds it — that is the product (CHE-33), not an oversight.
export function publicRow(): Record<string, never> {
  return {};
}

// Scoped to one person rather than their team, where the rule really is per
// person: quota counting in src/lib/plans.ts, which T7 moves to the team. The
// `where` already names the owner; this says that it is deliberate.
export function ownerScoped(): Record<string, never> {
  return {};
}

// Acting for everyone by definition. The reason names which of our own
// processes this is, so "why does this query see every team's rows" is answered
// in the query rather than in a reviewer's memory.
export type SystemReason = "scheduler" | "janitor" | "agent workflow" | "reconciler" | "measurement";

export function systemWide(reason: SystemReason): Record<string, never> {
  void reason;
  return {};
}
