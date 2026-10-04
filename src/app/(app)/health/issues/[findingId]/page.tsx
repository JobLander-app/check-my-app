import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { appPath } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";
import { issueOf } from "@/lib/issue-load";
import { VIEW_CLASS, VIEW_LABEL, issuePriorityOf, issueView, issuesHref, seenLine, ticketLabel } from "@/lib/issues-page";
import { PRIORITY_META } from "@/lib/issue-priority";
import { SEVERITY_META, STEP_STATUS_META } from "@/lib/status";
import { THUMB_WIDTH } from "@/lib/storage";
import { IssueMarks } from "@/components/issue-marks";

// A problem's own page (CHE-412): what the Issues list says of it, and what
// the list has no room for. The title and the severity line come first, then
// where it happens, the step it was seen on with its picture, what was tried
// and what happened and why it matters, every check that saw it, its ticket,
// and the owner's answer — the same four marks as the list and the check's
// page, written to the same finding. The address is the finding of a sighting
// (src/lib/issues-page.ts issueHref); any sighting of the problem opens it.
export default async function IssuePage({ params }: { params: Promise<{ findingId: string }> }) {
  const { findingId } = await params;
  const { user, db, team } = await requireUser();
  const [issue, shell] = await Promise.all([issueOf(db, team.id, findingId), shellData(db, team.id)]);
  if (!issue) notFound();
  const app = shell.apps.find((a) => a.id === issue.appId);
  const appName = app?.label ?? issue.appId;
  const r = issue.recurrence;
  // The list's own words for its state: the app's latest check is the
  // sidebar's, so "in the latest check" means the same check on both.
  const view = r ? issueView(r, app?.latestRunNumber ?? null) : null;
  const title = r?.issue.title ?? issue.finding.title;
  const severity = r?.issue.severity ?? issue.finding.severity;
  const category = r?.issue.category ?? issue.finding.category;
  const { detail } = issue.finding;
  // The priority (CHE-413), the list's own: from the problem's history when the
  // finding is part of one; a finding no problem holds is judged on its own.
  const priority = r
    ? issuePriorityOf(r.issue)
    : issuePriorityOf({ category, severity, where: detail.where ?? null, timesSeen: 1, audience: "unknown" });
  // The route's own rule (PATCH /api/findings/{id}): the person whose check
  // found it answers it. Anyone else reads the state.
  const mayMark = issue.answer.ownerId === null || issue.answer.ownerId === user.id;
  const step = issue.step;
  const stepMeta = step ? STEP_STATUS_META[step.status] ?? STEP_STATUS_META.skipped : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-muted">
          <Link href="/health/apps" className="hover:text-fg">
            Health
          </Link>
          <span aria-hidden className="text-fg-faint">/</span>
          <Link href={issuesHref("latest")} className="hover:text-fg">
            Issues
          </Link>
          <span aria-hidden className="text-fg-faint">/</span>
          <Link href={appPath.page(issue.appId)} className="max-w-[16rem] truncate font-mono hover:text-fg">
            {appName}
          </Link>
        </nav>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>
        {/* The problem in one line: its priority first (the legend is on the list), then its state and severity. */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-fg-muted">
          <span
            className={`inline-flex h-6 min-w-[2.5rem] items-center justify-center rounded-md border px-1.5 font-mono text-xs font-semibold ${PRIORITY_META[priority].className}`}
            title={PRIORITY_META[priority].meaning}
          >
            {priority}
          </span>
          {view && (
            <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-medium ${VIEW_CLASS[view]}`}>
              {VIEW_LABEL[view]}
            </span>
          )}
          <span className={`font-mono text-xs font-semibold ${SEVERITY_META[severity]?.className ?? "text-fg-faint"}`}>
            {SEVERITY_META[severity]?.label ?? severity}
          </span>
          <span>{category}</span>
          {detail.where && (
            <span className="min-w-0 break-all font-mono text-xs">
              <span className="text-fg-faint">Where: </span>
              {detail.where}
            </span>
          )}
        </p>
      </div>

      {step && stepMeta && (
        <section className="card flex flex-col gap-4 p-5 sm:flex-row">
          {step.shot ? (
            <a
              href={step.shot.full}
              target="_blank"
              rel="noreferrer"
              aria-label={`${step.label} — open the full-size screenshot`}
              className={`block w-full shrink-0 overflow-hidden rounded border bg-ink-950 sm:w-60 ${
                step.status === "broken" || step.status === "exposed" ? "border-status-broken ring-1 ring-status-broken" : "border-ink-700 hover:border-ink-600"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={step.shot.thumb}
                alt={step.label}
                width={THUMB_WIDTH}
                height={(THUMB_WIDTH * 10) / 16}
                loading="lazy"
                decoding="async"
                className="aspect-[16/10] h-auto w-full object-cover object-top"
              />
            </a>
          ) : (
            <div className="flex aspect-[16/10] w-full shrink-0 items-center justify-center gap-1.5 rounded border border-dashed border-ink-600 bg-ink-900 sm:w-60">
              <span className={`text-base ${stepMeta.className}`}>{stepMeta.emoji}</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">{stepMeta.label}</span>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="section-label">Seen on this step</p>
            <p className="text-sm text-fg-muted">{step.journeyTitle}</p>
            <p className="text-[15px] text-fg">
              <span className={`mr-1.5 ${stepMeta.className}`}>{stepMeta.emoji}</span>
              {step.label}
            </p>
            {step.attempted && <p className="text-[13px] text-fg-muted">{step.attempted}</p>}
            {step.observed && <p className="text-[13px] text-fg-muted">{step.observed}</p>}
            <p className="mt-1 text-xs text-fg-faint">
              In{" "}
              <Link href={appPath.check(issue.appId, step.walkedInRunNumber)} className="font-mono text-accent hover:underline">
                #{step.walkedInRunNumber}
              </Link>
            </p>
          </div>
        </section>
      )}

      {(detail.whatWeTried?.length || detail.whatHappened || detail.whyItMatters) && (
        <section className="card flex flex-col gap-4 p-5">
          {detail.whatWeTried && detail.whatWeTried.length > 0 && (
            <div>
              <p className="section-label mb-1.5">What we tried</p>
              <ol className="space-y-0.5 font-mono text-[13px] leading-6 text-fg-muted">
                {detail.whatWeTried.map((s, i) => (
                  <li key={i}>
                    <span className="text-fg-faint">{i + 1}.</span> {s}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {detail.whatHappened && (
            <div>
              <p className="section-label mb-1.5">What happened</p>
              <pre className="whitespace-pre-wrap break-words rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-muted">{detail.whatHappened}</pre>
            </div>
          )}
          {detail.whyItMatters && (
            <div>
              <p className="section-label mb-1.5">Why this matters</p>
              <p className="text-sm leading-relaxed text-fg">{detail.whyItMatters}</p>
            </div>
          )}
        </section>
      )}

      <section className="card flex flex-col gap-3 p-5">
        <p className="section-label">History</p>
        {r ? (
          <>
            <p className="text-sm text-fg">{seenLine(r)}</p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[13px]">
              {r.sightings.map((s) => (
                <li key={s.findingId}>
                  <Link href={appPath.check(issue.appId, s.runNumber)} className="text-accent hover:underline" title={s.title}>
                    #{s.runNumber}
                  </Link>
                </li>
              ))}
              {r.goneSinceRunNumber !== null && (
                <li className="text-fg-muted">
                  gone by{" "}
                  <Link href={appPath.check(issue.appId, r.goneSinceRunNumber)} className="text-accent hover:underline">
                    #{r.goneSinceRunNumber}
                  </Link>
                </li>
              )}
            </ul>
          </>
        ) : (
          // No problem of the app holds this finding: a note about our own
          // leftovers, or a restatement of something no check saw itself. The
          // check it is in is the whole story.
          <p className="text-sm text-fg-muted">
            In{" "}
            <Link href={appPath.check(issue.appId, issue.finding.runNumber)} className="font-mono text-accent hover:underline">
              #{issue.finding.runNumber}
            </Link>
            , as that check saw it.
          </p>
        )}
        <p className="text-[13px] text-fg-muted">
          <span className="text-fg-faint">Ticket: </span>
          {issue.ticket ? ticketLabel(issue.ticket) : "none"}
        </p>
      </section>

      <section className="card flex flex-col gap-2.5 p-5">
        <p className="section-label">Your answer</p>
        {mayMark ? (
          <IssueMarks findingId={issue.answer.findingId} mark={issue.answer.mark} />
        ) : (
          <p className="text-sm text-fg-muted">Answered by whoever ran the check that found it.</p>
        )}
      </section>
    </main>
  );
}
