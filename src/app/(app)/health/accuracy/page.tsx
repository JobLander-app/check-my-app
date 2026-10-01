import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { DEFAULT_SELF_HOSTS, isSelfHost } from "@/agent/self-hosts";
import { systemWide } from "@/lib/tenant-db";

// How often we were right (CHE-99).
//
// Rule §8: "whose defect is this" is a question we make impossible rather than
// one we answer — and the only way to know whether that is working is to count.
// Everything here comes from state the loop already writes: IssueLink.status is
// the customer's own verdict on our ticket (suppressed = they ruled it
// not-a-bug, resolved = we found it, they fixed it, we confirmed from outside),
// and Finding.mark is the owner's hand triage.
//
// Owner rule, 2026-09-01: accuracy counts where we have to prove we are worth
// paying for. Being wrong on a product under watch is expensive and compounds —
// their team investigates, then starts filtering us out. Being wrong on our own
// self-check costs nobody anything. The first version of this page averaged the
// two together, which flattered the number; they are now separate, and the
// figure worth quoting is the one about someone else's product.
//
// Deliberately blunt: the number this page exists for is how often we were
// WRONG, stated first and without softening. A checker that hides its own error
// rate is asking to be trusted on faith, which is what we sell against.

export const dynamic = "force-dynamic";

const CLASS_COPY: Record<string, { label: string; why: string }> = {
  capability: {
    label: "capability",
    why: "we could not perform the action and reported the product",
  },
  configuration: {
    label: "configuration",
    why: "our own inputs were wrong — a stale credential, a bad URL",
  },
  interpretation: {
    label: "interpretation",
    why: "we read the absence of evidence as evidence of a defect",
  },
  bookkeeping: {
    label: "bookkeeping",
    why: "we lost track of what we had filed or been told",
  },
};

// Our own product, checked by our own agent. It is an ordinary app row owned by
// an ordinary account, so the only thing that marks it is the host — the same
// answer the agent's silence gate and the supply count read (CHE-156), rather
// than a third private idea of which slug is ours.
function selfCheckHosts(): string | undefined {
  try {
    const env = getCloudflareContext().env as Record<string, string | undefined>;
    return env.SELF_CHECK_HOSTS;
  } catch {
    return undefined;
  }
}

export default async function AccuracyPage() {
  const { user, db } = await requireUser();
  const extraHosts = selfCheckHosts();

  const apps = await db.app.findMany({ ...systemWide("measurement"),
    where: { ownerId: user.id },
    select: { id: true, appSlug: true },
    orderBy: { appSlug: "asc" },
  });
  const selfAppIds = new Set(apps.filter((a) => isSelfHost(a.appSlug, extraHosts)).map((a) => a.id));
  const appById = new Map(apps.map((a) => [a.id, a.appSlug]));

  const allLinks = apps.length
    ? await db.issueLink.findMany({
        where: { appId: { in: apps.map((a) => a.id) } },
        select: {
          appId: true,
          externalIssueId: true,
          status: true,
          defectClass: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      })
    : [];

  const links = allLinks.filter((l) => !selfAppIds.has(l.appId));
  const selfLinks = allLinks.filter((l) => selfAppIds.has(l.appId));

  const tally = (rows: typeof allLinks) => ({
    filed: rows.length,
    rejected: rows.filter((l) => l.status === "suppressed").length,
    closed: rows.filter((l) => l.status === "resolved").length,
    open: rows.filter((l) => l.status !== "suppressed" && l.status !== "resolved").length,
  });
  const t = tally(links);
  const self = tally(selfLinks);

  // Findings are counted on runs this owner owns, so the denominator is work we
  // actually did for them. Split the same way: our own product never props up
  // the number we would quote about someone else's.
  const forOwner = { ownerId: user.id };
  // isSelfHost is a predicate, not a value, so the split cannot be pushed into
  // the WHERE clause: read the slugs this owner's runs actually used and let the
  // predicate name the ours-shaped ones. A run of a preview host listed in
  // SELF_CHECK_HOSTS lands on the self side here for the same reason it gets no
  // mail (CHE-156).
  const ranSlugs = await db.run.findMany({ ...systemWide("measurement"),
    where: forOwner,
    select: { appSlug: true },
    distinct: ["appSlug"],
  });
  const selfSlugs = ranSlugs.map((r) => r.appSlug).filter((s) => isSelfHost(s, extraHosts));
  const [findings, falsePositives, selfFindings, selfFalsePositives] = await Promise.all([
    db.finding.count({ where: { run: { ...forOwner, appSlug: { notIn: selfSlugs } } } }),
    db.finding.count({
      where: { mark: "false_positive", run: { ...forOwner, appSlug: { notIn: selfSlugs } } },
    }),
    db.finding.count({ where: { run: { ...forOwner, appSlug: { in: selfSlugs } } } }),
    db.finding.count({
      where: { mark: "false_positive", run: { ...forOwner, appSlug: { in: selfSlugs } } },
    }),
  ]);

  const byClass = new Map<string, number>();
  for (const l of links.filter((x) => x.status === "suppressed")) {
    const key = l.defectClass ?? "unclassified";
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }

  const perApp = apps
    .filter((a) => !selfAppIds.has(a.id))
    .map((app) => {
      const mine = links.filter((l) => l.appId === app.id);
      return {
        id: app.id,
        slug: app.appSlug,
        filed: mine.length,
        rejected: mine.filter((l) => l.status === "suppressed").length,
        closed: mine.filter((l) => l.status === "resolved").length,
      };
    })
    .filter((a) => a.filed > 0)
    .sort((a, b) => b.filed - a.filed);

  const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      {/* A page with no way back and no reason given reads as a dead end, however
          good its numbers are. Say where you are, then why this exists for YOU. */}
      <Link
        href="/home"
        className="mb-6 inline-block font-mono text-xs text-fg-faint transition-colors hover:text-fg"
      >
        ← Your apps
      </Link>
      <div className="mb-8">
        <p className="section-label">your apps · accuracy</p>
        <h1 className="text-3xl font-semibold tracking-tight">How often we were right</h1>
        <p className="mt-3 max-w-xl text-sm text-fg-muted">
          Every problem we find goes onto your board as a ticket, and you close it — fixed, or not
          a bug. Not a bug means we were wrong.
        </p>
        <p className="mt-2 max-w-xl text-sm text-fg-muted">
          This page keeps that score, because you should know how much of your time a finding from
          us is worth before you spend it. Every time we are wrong it opens a ticket on our own
          board, and it stays open until the cause is gone.
        </p>
      </div>

      {t.filed === 0 && findings === 0 ? (
        <div className="card p-8">
          <p className="text-fg-muted">
            Nothing to score yet. This page fills in once we have checked an app of yours and
            reported something — and it stays honest whether that flatters us or not.
          </p>
          <Link href="/onboarding?path=app" className="mt-3 inline-block text-accent hover:underline">
            Add an app to watch →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="card p-6">
            <p className="section-label">tickets on your board</p>
            <p className="mt-2 font-mono text-4xl">
              {t.rejected}
              <span className="text-fg-faint"> / {t.filed}</span>
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              {t.filed === 0
                ? "No tickets filed yet — connect a tracker and we will start scoring ourselves."
                : `ruled not-a-bug — ${pct(t.rejected, t.filed)} of what we filed was our own defect, not yours.`}
            </p>
            <div className="mt-5 grid grid-cols-3 gap-4 border-t border-ink-700 pt-4">
              <div>
                <p className="font-mono text-xl text-status-ok">{t.closed}</p>
                <p className="text-xs text-fg-faint">
                  loops closed — found, fixed, confirmed from outside
                </p>
              </div>
              <div>
                <p className="font-mono text-xl text-status-broken">{t.rejected}</p>
                <p className="text-xs text-fg-faint">rejected — ours, not yours</p>
              </div>
              <div>
                <p className="font-mono text-xl text-fg-muted">{t.open}</p>
                <p className="text-xs text-fg-faint">still open — no verdict yet</p>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <p className="section-label">findings</p>
            <p className="mt-2 font-mono text-2xl">
              {falsePositives}
              <span className="text-fg-faint"> / {findings}</span>
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              marked a false positive by hand — {pct(falsePositives, findings)} of everything we
              have reported to you.
            </p>
          </div>

          <div className="card p-6">
            <p className="section-label">why we were wrong</p>
            {t.rejected === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">
                Nothing rejected yet. This stays empty only as long as that holds.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {[...byClass.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, count]) => {
                    const copy = CLASS_COPY[key];
                    return (
                      <li key={key} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-mono text-sm">{copy?.label ?? "unclassified"}</p>
                          <p className="text-xs text-fg-faint">
                            {copy?.why ??
                              "cause not recorded — the ones we learn least from; a person should name it"}
                          </p>
                        </div>
                        <p className="font-mono text-sm text-fg-muted">{count}</p>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          {perApp.length > 0 && (
            <div className="card p-6">
              <p className="section-label">by app</p>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-700 text-left text-xs text-fg-faint">
                    <th className="pb-2 font-normal">app</th>
                    <th className="pb-2 text-right font-normal">filed</th>
                    <th className="pb-2 text-right font-normal">closed</th>
                    <th className="pb-2 text-right font-normal">rejected</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {perApp.map((a) => (
                    <tr key={a.slug} className="border-b border-ink-700/50 last:border-0">
                      {/* The score is about a specific app of theirs, so it
                          should be one click from that app, not a dead string. */}
                      <td className="py-2">
                        <Link
                          href={`/health/apps/${a.id}`}
                          className="transition-colors hover:text-accent"
                        >
                          {a.slug}
                        </Link>
                      </td>
                      <td className="py-2 text-right text-fg-muted">{a.filed}</td>
                      <td className="py-2 text-right text-status-ok">{a.closed}</td>
                      <td className="py-2 text-right text-status-broken">{a.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {links.length > 0 && (
            <div className="card p-6">
              <p className="section-label">latest verdicts on our tickets</p>
              <ul className="mt-3 space-y-2">
                {links.slice(0, 8).map((l) => (
                  <li key={l.externalIssueId} className="flex items-center justify-between gap-4">
                    <span className="font-mono text-sm">{l.externalIssueId}</span>
                    <span className="text-xs text-fg-faint">{appById.get(l.appId)}</span>
                    <span
                      className={
                        l.status === "suppressed"
                          ? "font-mono text-xs text-status-broken"
                          : l.status === "resolved"
                            ? "font-mono text-xs text-status-ok"
                            : "font-mono text-xs text-fg-muted"
                      }
                    >
                      {l.status === "suppressed"
                        ? "not a bug — ours"
                        : l.status === "resolved"
                          ? "fixed, confirmed"
                          : l.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Our own product, checked by our own agent. Kept out of everything
              above on purpose: being wrong here costs nobody anything, and
              averaging it in would flatter the number that matters. Only ever
              visible to us — a customer has no app on our own host. */}
          {(selfLinks.length > 0 || selfFindings > 0) && (
            <div className="card border-dashed p-6 opacity-80">
              <p className="section-label">self-checks · not counted above</p>
              <p className="mt-2 text-sm text-fg-muted">
                {selfSlugs.join(", ") || DEFAULT_SELF_HOSTS[0]} checking itself: {self.rejected} of{" "}
                {self.filed} tickets ruled
                not-a-bug, {self.closed} loops closed, {selfFalsePositives} of {selfFindings}{" "}
                findings marked a false positive.
              </p>
              <p className="mt-2 text-xs text-fg-faint">
                Housekeeping, not evidence. Accuracy is only worth quoting about somebody
                else&apos;s product.
              </p>
            </div>
          )}
        </div>
      )}

      <Link href="/home" className="mt-8 inline-block text-sm text-fg-muted hover:text-fg">
        ← Today
      </Link>
    </main>
  );
}
