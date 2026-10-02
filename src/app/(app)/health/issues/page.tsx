import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { appPath } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";
import { teamRecurrences } from "@/lib/recurring";
import { SEVERITY_META } from "@/lib/status";
import {
  ISSUES_FILTERS,
  VIEW_CLASS,
  VIEW_LABEL,
  type IssuesFilter,
  inIssuesFilter,
  issueView,
  issuesFilter,
  issuesHref,
  issuesLine,
  portions,
  seenLine,
  sortIssues,
  ticketLabel,
} from "@/lib/issues-page";
import { IssueMarks } from "@/components/issue-marks";

const TH = "whitespace-nowrap border-b border-ink-700 px-3 py-2.5 text-left text-xs font-medium text-fg-muted first:pl-[18px] last:pr-[18px]";
const TD = "border-b border-ink-800 px-3 py-3.5 align-top first:pl-[18px] last:pr-[18px]";

// Health → Issues (CHE-360, direction C): every problem across the team's
// apps, one row per problem — the latest wording, the app, its state, the
// checks that saw it, its tracker ticket — with the owner's answer one click
// away. The grouping and the states are recurrence's (CHE-354), the same
// source as All apps' "Recurring" column and each app's "Keeps coming back".
// It opens on what the apps' latest checks hold — the number beside Issues in
// the menu — and keeps apart what was found earlier in a place no check has
// walked since (src/lib/issues-page.ts says why).
export default async function IssuesPage({ searchParams }: { searchParams: Promise<{ show?: string; app?: string }> }) {
  const { show, app: appParam } = await searchParams;
  const filter = issuesFilter(show);
  const { user, db, team } = await requireUser();
  const [shell, byApp] = await Promise.all([shellData(db, team.id), teamRecurrences(db, team.id)]);
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  // An app that is not the team's is no filter at all.
  const appId = appParam && nameOf.has(appParam) ? appParam : null;

  // The app's latest check is the sidebar's (the check its dot and its count
  // come from), so "in the latest checks" means the same check on both.
  const latestOf = new Map(shell.apps.map((a) => [a.id, a.latestRunNumber]));
  const all = sortIssues([...byApp.values()].flat().map((r) => ({ ...r, view: issueView(r, latestOf.get(r.issue.appId) ?? null) })));
  const ofApp = all.filter((r) => appId === null || r.issue.appId === appId);
  const rows = ofApp.filter((r) => inIssuesFilter(filter, r.view, r.issue.state));
  const count = (f: IssuesFilter, of = ofApp) => of.filter((r) => inIssuesFilter(f, r.view, r.issue.state)).length;

  // The finding a mark is written to is the problem's latest sighting, and its
  // tracker ticket is the one recurrence tied to it. Both are read by ids that
  // came out of the team's own history, and again only among the team's rows.
  const latestFinding = new Map(rows.map((r) => [r.issue.signature + r.issue.appId, r.sightings.at(-1)?.findingId ?? null]));
  const findingIds = [...latestFinding.values()].filter((id): id is string => id !== null);
  const linkIds = rows.map((r) => r.issue.issueLinkId).filter((id): id is string => id !== null);
  // D1 binds at most a hundred values a statement, and "All" on a team with a
  // long history is more problems than that: the ids go in portions.
  const [findings, links] = await Promise.all([
    Promise.all(
      portions(findingIds).map((ids) =>
        db.finding.findMany({
          where: { id: { in: ids }, run: { teamId: team.id } },
          select: { id: true, mark: true, run: { select: { ownerId: true } } },
        }),
      ),
    ).then((parts) => parts.flat()),
    Promise.all(
      portions(linkIds).map((ids) =>
        db.issueLink.findMany({
          where: { id: { in: ids }, app: { teamId: team.id } },
          select: { id: true, externalIssueId: true, status: true },
        }),
      ),
    ).then((parts) => parts.flat()),
  ]);
  const findingOf = new Map(findings.map((f) => [f.id, f]));
  const linkOf = new Map(links.map((l) => [l.id, l]));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-10">
      <header>
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Issues</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-fg-muted">{issuesLine(count("latest", all), count("stale", all))}</p>
      </header>

      {all.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Which problems" className="flex flex-wrap gap-1.5">
            {ISSUES_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={issuesHref(f.key, appId)}
                aria-current={filter === f.key ? "true" : undefined}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs ${
                  filter === f.key ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
                }`}
              >
                {f.label}
                <span className="font-mono text-fg-faint">{count(f.key)}</span>
              </Link>
            ))}
          </nav>
          {shell.apps.length > 1 && (
            <nav aria-label="Which app" className="flex flex-wrap gap-1.5">
              {[{ id: null as string | null, label: "All apps" }, ...shell.apps.map((a) => ({ id: a.id as string | null, label: a.label }))].map((a) => (
                <Link
                  key={a.id ?? "all"}
                  href={issuesHref(filter, a.id)}
                  aria-current={appId === a.id ? "true" : undefined}
                  className={`inline-flex h-7 items-center rounded-full border px-3 font-mono text-xs ${
                    appId === a.id ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
                  }`}
                >
                  {a.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="card p-6 text-sm text-fg-muted">
          {all.length === 0
            ? "Nothing has been found in your apps yet."
            : filter === "latest"
              ? "Nothing open in the latest checks here."
              : filter === "stale"
                ? "Nothing here is waiting to be checked again."
                : filter === "recurring"
                ? "Nothing keeps coming back here."
                : filter === "gone"
                  ? "No problem has been seen to go away here yet."
                  : filter === "answered"
                    ? "You have not answered any problem here."
                    : "No problems here."}
        </p>
      ) : (
        // The table scrolls inside its card; the page never scrolls sideways.
        <section className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>Problem</th>
                <th className={TH}>App</th>
                <th className={TH}>State</th>
                <th className={TH}>Seen</th>
                <th className={TH}>Ticket</th>
                <th className={TH}>Your answer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const i = r.issue;
                const findingId = latestFinding.get(i.signature + i.appId) ?? null;
                const finding = findingId ? findingOf.get(findingId) : undefined;
                const link = i.issueLinkId ? linkOf.get(i.issueLinkId) : undefined;
                const sev = SEVERITY_META[i.severity];
                // The route's own rule (PATCH /api/findings/{id}): the person
                // whose check found it answers it. Anyone else reads the state.
                const mayMark = finding !== undefined && (finding.run.ownerId === null || finding.run.ownerId === user.id);
                return (
                  <tr key={i.appId + i.signature}>
                    <td className={`${TD} min-w-[260px] max-w-[420px]`}>
                      <Link href={appPath.check(i.appId, i.lastSeenRunNumber)} className="text-fg hover:underline">
                        {i.title}
                      </Link>
                      <span className="mt-0.5 block text-xs text-fg-faint">
                        {sev?.label ?? i.severity} · {i.category}
                      </span>
                    </td>
                    <td className={`${TD} whitespace-nowrap font-mono text-[13px]`}>
                      <Link href={appPath.page(i.appId)} className="text-fg-muted hover:text-fg hover:underline">
                        {nameOf.get(i.appId) ?? i.appId}
                      </Link>
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium ${VIEW_CLASS[r.view]}`}>
                        {VIEW_LABEL[r.view]}
                      </span>
                    </td>
                    <td className={`${TD} min-w-[180px] text-[13px] text-fg-muted`}>{seenLine(r)}</td>
                    <td className={`${TD} whitespace-nowrap text-[13px] text-fg-muted`}>{link ? ticketLabel(link) : "—"}</td>
                    <td className={`${TD} min-w-[150px]`}>
                      {mayMark && findingId ? <IssueMarks findingId={findingId} mark={finding.mark} /> : <span className="text-xs text-fg-faint">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
