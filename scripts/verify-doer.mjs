// The doer's rails, verified the way the credential gate is — by us, in CI,
// before anything of it runs unattended overnight.
//
// Each case below is a rail that something already paid for. The merge cases in
// particular: "still computing", "unreadable" and "went quiet" read as approval
// only once, and that is how a gate merges a change nobody reviewed.

import {
  decideTick,
  decideMerge,
  branchFor,
  isDoerBranch,
  isMergeCandidate,
  MAX_WITHDRAWN_CLAIMS,
} from "./doer/eligibility.mjs";
import {
  decideMender,
  attemptArgs,
  ticketFor,
  outcomeOf,
  findingsText,
  ledgerRowsSince,
  unpricedAttempt,
  findMenderHome,
  isWithdrawnAttempt,
  WITHDRAWN_TITLE_PREFIX,
} from "./doer/mender.mjs";
import { ROUND_MARKER, ROUND_ANSWER_MARKER, roundState } from "./doer/machine.mjs";
import { codexSummaryState, reviewRequestNeeded, askedSinceHead } from "./doer/review.mjs";
import { mayUnpark, unparkOurRuns, DOER_PR_AUTHOR, PARKED_STATUS } from "./doer/unpark.mjs";
import { admit, partition, DEFECT_CLASS_BY_LABEL, ADMITTED_DEFECTS } from "./doer/queue.mjs";

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

// A queue item as board-queue.ts hands it over: a ticket of ours that a run
// filed and queue.mjs admitted. No labels — the label queue is gone (CHE-118).
const item = (ticket, createdAt, label = "t") => ({ ticket, createdAt, label, kind: "gap" });

// ── which ticket, and whether to act at all ──────────────────────────────────
{
  const d = decideTick({ queue: [], openDoerPrs: [], stopped: true });
  check("stop flag halts the tick", d.act === false && d.reason.includes("stopped"), d.reason);
}
{
  const d = decideTick({
    queue: [item("CHE-96", "2026-09-01")],
    openDoerPrs: [{ number: 9, headRef: "doer/9-x" }],
    stopped: false,
  });
  check("one open PR blocks a second", d.act === false && d.reason.includes("#9"), d.reason);
}
{
  const d = decideTick({ queue: [], openDoerPrs: [], stopped: false });
  check(
    "an empty queue is named, not silent",
    d.act === false && d.reason.includes("no open ticket"),
    d.reason,
  );
}
{
  const d = decideTick({
    queue: [item("CHE-146", "2026-09-02"), item("CHE-96", "2026-08-20")],
    openDoerPrs: [],
    stopped: false,
  });
  check(
    "oldest first, so nothing starves",
    d.act === true && d.item.ticket === "CHE-96",
    `picked ${d.item?.ticket}`,
  );
}
{
  // The reader sorts too; this rail must hold even if it hands over an
  // out-of-order list, because the order is a decision and decisions live here.
  const d = decideTick({
    queue: [item("CHE-146", "2026-09-02"), item("CHE-96", "2026-08-20")].reverse(),
    openDoerPrs: [],
    stopped: false,
  });
  check("order does not depend on the reader", d.act === true && d.item.ticket === "CHE-96", d.item?.ticket);
}
{
  const d = decideTick({ queue: [item("CHE-96", "2026-08-20")], openDoerPrs: [], stopped: false });
  check("merging is the default, not an opt-in", d.act === true && d.mayMerge === true, `mayMerge=${d.mayMerge}`);
}

// ── a ticket nobody can implement steps aside (CHE-211) ──────────────────────
//
// The treadmill this prevents was live for twelve hours: CHE-96 claimed, the
// claim withdrawn unanswered, the same ticket claimed again, and the second
// admitted ticket never reached because it is younger. With Mender the same
// count is red attempts: a ticket the gate keeps refusing steps aside.
{
  const d = decideTick({
    queue: [item("CHE-96", "2026-08-27"), item("CHE-146", "2026-09-03")],
    openDoerPrs: [],
    stopped: false,
    withdrawnByTicket: { "CHE-96": MAX_WITHDRAWN_CLAIMS },
  });
  check(
    "a ticket with withdrawn attempts lets the next one through",
    d.act === true && d.item.ticket === "CHE-146",
    `picked ${d.item?.ticket}`,
  );
  check(
    "and stepping aside is said out loud, with the count",
    (d.steppedAside ?? []).some((t) => t.ticket === "CHE-96" && t.withdrawn === MAX_WITHDRAWN_CLAIMS),
    JSON.stringify(d.steppedAside),
  );
}
{
  const d = decideTick({
    queue: [item("CHE-96", "2026-08-27")],
    openDoerPrs: [],
    stopped: false,
    withdrawnByTicket: { "CHE-96": MAX_WITHDRAWN_CLAIMS - 1 },
  });
  check(
    "one withdrawal is an incident, not a pattern",
    d.act === true && d.item.ticket === "CHE-96",
    d.reason ?? d.item?.ticket,
  );
}
{
  // Everything exhausted is not "queue empty": the queue is full and nobody is
  // delivering. Those are different states and must read differently.
  const d = decideTick({
    queue: [item("CHE-96", "2026-08-27"), item("CHE-146", "2026-09-03")],
    openDoerPrs: [],
    stopped: false,
    withdrawnByTicket: { "CHE-96": 5, "CHE-146": 5 },
  });
  check(
    "all tickets exhausted reads as 'no implementer', not 'empty queue'",
    d.act === false && d.reason.includes("no implementer is delivering") && d.reason.includes("CHE-96 (5×)"),
    d.reason,
  );
}

// ── the merge gate ───────────────────────────────────────────────────────────
const green = [{ name: "check", conclusion: "success", headSha: "aaa" }];
const approved = [{ state: "APPROVED", headSha: "aaa" }];
{
  const m = decideMerge({ mayMerge: false, headSha: "aaa", checks: green, reviews: approved });
  check("a held ticket never merges", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: [], reviews: approved });
  check("no checks reported yet is not success", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: null, headSha: "aaa" }],
    reviews: approved,
  });
  check("a check still running is not success", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: "failure", headSha: "aaa" }],
    reviews: approved,
  });
  check("a failing check blocks", m.merge === false, m.reason);
}
{
  // Found by a live tick, not by imagination: our deploy job reports "skipped"
  // on every PR, and blocking on that would stall the gate permanently.
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [
      { name: "check", conclusion: "success", headSha: "aaa" },
      { name: "deploy", conclusion: "skipped", headSha: "aaa" },
    ],
    reviews: approved,
  });
  check("a correctly skipped job is not a failure", m.merge === true, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: "cancelled", headSha: "aaa" }],
    reviews: approved,
  });
  check("a cancelled check still blocks", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: green, reviews: [] });
  check("green checks alone do not merge", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "bbb",
    checks: [{ name: "check", conclusion: "success", headSha: "aaa" }],
    reviews: [{ state: "APPROVED", headSha: "aaa" }],
  });
  check("verdicts about an older push do not count", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: green, reviews: approved });
  check("green and reviewed for THIS head merges", m.merge === true, m.reason);
}

// ── branch naming ────────────────────────────────────────────────────────────
{
  const b = branchFor("che-146", "Checker cannot complete third-party OAuth sign-in");
  check("branch is prefixed and slugged", b.startsWith("doer/che-146-") && !/[^a-z0-9/-]/.test(b), b);
  check("a draft doer PR is not a merge candidate", isMergeCandidate({ headRefName: "doer/7-x", isDraft: true }) === false);
  check("an ordinary doer PR is", isMergeCandidate({ headRefName: "doer/7-x", isDraft: false }) === true);
  check("somebody else's branch is not the doer's", isDoerBranch("mender/7-x") === false);
}

// ── the implementer (owner, 2026-09-18: Mender, not Codex) ───────────────────
//
// The rails here are the ones a tick that spends money rests on: it must not
// run without Mender, it must hand over a ticket the implementer can read, and
// it must turn every outcome into exactly one action.
{
  // Absent Mender, the tick must say so by name and stop. A silent skip is how
  // a loop ticks green for twelve days building nothing.
  const d = decideMender({ home: "", hasCli: false, hasUv: false });
  check("no Mender checkout is a named stop", d.run === false && d.reason.includes("MENDER_HOME"), d.reason);
  const noUv = decideMender({ home: "/x", hasCli: true, hasUv: false });
  check("no uv is a named stop", noUv.run === false && noUv.reason.includes("uv"), noUv.reason);
  const on = decideMender({ home: "/x", hasCli: true, hasUv: true });
  check("everything present runs it", on.run === true, on.reason);
}
{
  // An operator who names a path and silently gets a different checkout is the
  // "configuration" defect class of CLAUDE.md §8. An explicit setting wins or
  // there is no home.
  check("MENDER_HOME wins, and never falls back to a sibling",
    findMenderHome({ MENDER_HOME: "/nope" }, () => true) === "/nope");
  check("with nothing set and no sibling, there is no home", findMenderHome({}, () => false) === "");
  check("with nothing set, the sibling checkout is used when it is really there",
    findMenderHome({}, () => true).endsWith("/mender"), findMenderHome({}, () => true));
}
{
  const gap = {
    ticket: "CHE-146", label: "Checker cannot drive file upload/download flows", kind: "gap", occurrences: 2,
    reason: "automation inside our own runner; a fixture page with a file input decides it",
    evidence: {
      why: "Upload-centric products have their core action unverified.",
      steps: [{ runId: "r1", appSlug: "example.com", createdAt: "2026-09-10T00:00:00Z", journey: "Upload a CV",
        label: "Attach the file", attempted: "Clicked the file input", observed: "Nothing happened\n at all" }],
    },
  };
  const t = ticketFor({ item: gap, repo: "o/r" });
  check("the ticket carries the tracker key, not a fake issue number", t.key === "CHE-146" && t.number === undefined, JSON.stringify({ key: t.key }));
  check("the title is the filer's", t.title === "[Checker gap] Checker cannot drive file upload/download flows", t.title);
  check("the class is stated, so the witness-test rung binds", t.labels.includes("bug"));
  check("the body has the symptom, the evidence and how to know it is gone",
    t.body.includes("## The symptom") && t.body.includes("## Evidence") && t.body.includes("## How to know it is gone"));
  check("the evidence names the run and the step", t.body.includes("run r1 on example.com") && t.body.includes('step "Attach the file"'));
  check("step text is flattened to one line", !t.body.includes("Nothing happened\n at all") && t.body.includes("Nothing happened at all"));
  check("the ticket names no file and prescribes no fix (rule §9)", !/\.tsx?\b|src\//.test(t.body.replace(/scripts\/verify-\*\.ts/g, "")), t.body.slice(0, 80));

  const round = ticketFor({ item: gap, repo: "o/r", round: { round: 2, findings: "1. a.ts:3\n   codex: rename it" } });
  check("a fix round appends the findings under their own heading",
    round.body.includes("## Review findings to address (round 2)") && round.body.includes("codex: rename it"));

  const defect = ticketFor({
    item: { ticket: "CHE-222", label: "Checker reported a product defect from the absence of evidence", kind: "defect",
      occurrences: 1, reason: "silence read as breakage", evidence: { signatures: [{ externalIssueId: "JOB-929", appSlug: "joblander.app", settledAt: "2026-09-05T00:00:00Z" }] } },
    repo: "o/r",
  });
  check("a defect ticket cites the rejected claims", defect.body.includes("JOB-929 on joblander.app") && defect.title.startsWith("[Checker defect]"));

  const bare = ticketFor({ item: { ...gap, evidence: {} }, repo: "o/r" });
  check("no evidence rows is said out loud, not padded", bare.body.includes("No step rows carry this class yet"));
}
{
  const args = attemptArgs({ ticketFile: "/t.json", base: "doer/che-146-x", tier: "t1", budget: 1.5, runnerTimeout: 1800, maxSteps: 40 });
  check("the attempt hands over the ticket file and publishes nothing itself",
    args.includes("--ticket-file") && args.includes("--no-publish") && !args.some((a) => a.startsWith("https://")), args.join(" "));
  check("the attempt builds on the doer branch, not on main", args[args.indexOf("--base") + 1] === "doer/che-146-x");
  check("the cap is stated to the cent", args[args.indexOf("--budget") + 1] === "1.50");
  check("a live attempt is never a rehearsal by accident", !args.includes("--dry-run"));
  check("a rehearsal spends nothing", attemptArgs({ ticketFile: "/t", base: "b", tier: "t1", budget: 1, runnerTimeout: 1, maxSteps: 1, rehearse: true }).includes("--dry-run"));
}
{
  // Only a real attempt with a red gate counts toward stepping aside. On the
  // day Mender took over, every admitted ticket carried two Codex-era claims
  // closed "the implementer never came"; counting those would have exhausted
  // the queue before the first attempt (seen live in the dry run, 2026-09-18).
  check("a red attempt, recorded and closed, counts",
    isWithdrawnAttempt({ title: `${WITHDRAWN_TITLE_PREFIX} — x`, mergedAt: null }) === true);
  check("a claim nobody attempted does not count",
    isWithdrawnAttempt({ title: "[doer] Checker cannot drive file upload/download flows", mergedAt: null }) === false);
  check("a merged attempt is work, not a withdrawal",
    isWithdrawnAttempt({ title: `${WITHDRAWN_TITLE_PREFIX} — x`, mergedAt: "2026-09-18T00:00:00Z" }) === false);
}
{
  const green = { verdict: "green", failure_stage: "", cost_usd: "0.0312", steps: "24", model: "m", provider: "openrouter" };
  check("a green gate with a patch is committed", outcomeOf(green, true).action === "commit");
  check("a green gate with no patch is a defect, not a result", outcomeOf(green, false).action === "defect");
  const red = { ...green, verdict: "red", failure_stage: "typecheck" };
  const o = outcomeOf(red, true);
  check("a red gate withdraws, and says where it died", o.action === "withdraw" && o.summary.includes("typecheck"), o.summary);
  check("a truncated patch is never committed", outcomeOf({ ...green, verdict: "truncated" }, true).action === "withdraw");
  check("no row at all is a defect of ours", outcomeOf(null, true).action === "defect");
  check("an unpriced attempt is called out", outcomeOf({ ...green, cost_usd: "0.0" }, true).summary.includes("UNPRICED"));
}
{
  const text = findingsText(
    [{ path: "src/a.ts", line: 30, comments: [{ author: "codex", body: "<sub>![P1 Badge](https://x/p1)</sub>\n\nAdd the check." }] },
     { path: "src/b.ts", line: null, comments: [{ author: "codex", body: "Rename." }] }],
    ["check"],
  );
  check("findings carry the failing checks first", text.startsWith("Failing checks on the current head: check"));
  check("each thread is numbered and located", text.includes("1. src/a.ts:30") && text.includes("2. src/b.ts"));
  check("badges and markup are stripped, the words stay", !text.includes("Badge") && !text.includes("<sub>") && text.includes("Add the check."));
}
{
  // CRLF, because that is what Python's csv.writer produces and what the real
  // ledger contains. Written with "\n" this fixture passed while the parser read
  // every ts as undefined, and the tick announced an unpriced attempt on a run
  // Mender had priced correctly.
  const csv = [
    "task_id,attempt_no,tier,model,provider,input_tokens,cached_input_tokens,output_tokens,cost_usd,sandbox_seconds,steps,verdict,failure_stage,diff_files,diff_lines,wall_seconds,ts",
    "a,1,t1,m,openrouter,1,0,1,0.04,10,3,red,no_patch,0,0,11,2026-09-04T04:00:00+00:00",
    "b,1,t1,m,openrouter,1,0,1,0.02,10,3,green,,2,9,11,2026-09-04T06:00:00+00:00",
  ].join("\r\n") + "\r\n";
  const since = ledgerRowsSince(csv, Date.parse("2026-09-04T05:00:00Z"));
  check("the ledger row for THIS attempt is the one written since it started",
    since.length === 1 && since[0].task_id === "b", JSON.stringify(since.map((r) => r.task_id)));
  check("an earlier row is not mistaken for ours", ledgerRowsSince(csv, Date.parse("2026-09-04T07:00:00Z")).length === 0);
  check("the last column survives the line terminator", since[0]?.ts === "2026-09-04T06:00:00+00:00", since[0]?.ts);
  check("a real call recorded at $0.00 is unpriced", unpricedAttempt({ provider: "openrouter", cost_usd: "0.0" }) === true);
  check("a stub row is free, not unpriced", unpricedAttempt({ provider: "stub", cost_usd: "0.0" }) === false);
}

// ── fix rounds between two rhythms ───────────────────────────────────────────
//
// The shepherd asks every twenty minutes; the implementer answers every two
// hours. Without "pending", the shepherd posts three rounds in an hour and
// blocks the pull request before the implementer has looked once.
{
  const req = (at) => ({ body: `${ROUND_MARKER}\nfindings`, createdAt: at });
  const ans = (at) => ({ body: `${ROUND_ANSWER_MARKER}\nred`, createdAt: at });
  const head = "2026-09-18T10:00:00Z";
  check("no rounds yet", roundState([], head).roundsUsed === 0 && roundState([], head).pending === null);
  const s1 = roundState([req("2026-09-18T11:00:00Z")], head);
  check("a request newer than the head is pending", s1.roundsUsed === 1 && s1.pending !== null);
  const s2 = roundState([req("2026-09-18T09:00:00Z")], head);
  check("a request older than the head was answered by the push", s2.roundsUsed === 1 && s2.pending === null);
  const s3 = roundState([req("2026-09-18T11:00:00Z"), ans("2026-09-18T12:00:00Z")], head);
  check("a red answer without a push also closes the request", s3.pending === null);
  const s4 = roundState([req("2026-09-18T11:00:00Z"), ans("2026-09-18T12:00:00Z"), req("2026-09-18T13:00:00Z")], head);
  check("a new request after the answer is pending again, and rounds count every request", s4.pending !== null && s4.roundsUsed === 2);
}

// ── asking the reviewer ──────────────────────────────────────────────────────
{
  const summary = (state, sha) =>
    `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ${state} <relative-time>x</relative-time> | \`${sha}\` | Manual request |`;
  check("a completed summary row for this head is a verdict", codexSummaryState(summary("✅ **Completed**", "ffd1f1c"), "ffd1f1c0000") === "completed");
  check("a running row is running", codexSummaryState(summary("🔄 **Running**", "ffd1f1c"), "ffd1f1c0000") === "running");
  check("a row about another commit says nothing about this head", codexSummaryState(summary("✅ **Completed**", "1234567"), "ffd1f1c0000") === null);
  check("an ordinary comment is not a summary", codexSummaryState("looks fine to me `ffd1f1c` Completed", "ffd1f1c0000") === null);

  const base = { verdictForHead: false, summaryState: null, askedSinceHead: false, headAgeMinutes: 30 };
  check("no verdict, nobody asked, head old enough → ask", reviewRequestNeeded(base).ask === true);
  check("a verdict already given → do not ask", reviewRequestNeeded({ ...base, verdictForHead: true }).ask === false);
  check("a review running → do not ask", reviewRequestNeeded({ ...base, summaryState: "running" }).ask === false);
  check("already asked about this head → do not ask twice", reviewRequestNeeded({ ...base, askedSinceHead: true }).ask === false);
  check("a fresh head gets the automatic review a chance first", reviewRequestNeeded({ ...base, headAgeMinutes: 2 }).ask === false);

  const head = "2026-09-18T10:00:00Z";
  check("a request newer than the head counts as asked",
    askedSinceHead([{ body: "@codex review in o/r", createdAt: "2026-09-18T10:30:00Z" }], head) === true);
  check("a request older than the head was about another diff",
    askedSinceHead([{ body: "@codex review in o/r", createdAt: "2026-09-18T09:30:00Z" }], head) === false);
}

// ── releasing a parked run (CHE-153) ─────────────────────────────────────────
//
// This repository is public, and the only thing standing between a stranger's
// fork and this repository's compute is the approval GitHub parks their run
// for. These cases are that boundary. The three conditions are required
// together, so each one is tested by removing exactly that one from an
// otherwise releasable run.
{
  const REPO = "sorokinvj/check-my-app";
  const ourPr = { headRef: "doer/6-x", headRepo: REPO, author: DOER_PR_AUTHOR };
  // The shape GitHub actually reports, taken from a real parked run rather than
  // imagined: run 33872669967 on 2026-09-04 came back as a COMPLETED run whose
  // conclusion is that a person must act. Written as `status: "action_required"`
  // — the reading the field name invites — this fixture passed while the sweep
  // skipped every real parked run and reported success having released nothing.
  const parked = {
    id: 1, status: "completed", conclusion: PARKED_STATUS,
    headBranch: "doer/6-x", headRepository: REPO,
  };

  check("our own parked run is released", mayUnpark({ run: parked, prs: [ourPr], repo: REPO }).unpark === true);
  check("a run parked in the status field is released too",
    mayUnpark({
      run: { ...parked, status: PARKED_STATUS, conclusion: null },
      prs: [ourPr], repo: REPO,
    }).unpark === true);

  {
    // The whole reason the policy exists. A fork may name its branch anything,
    // `doer/6-x` included; the head repository is the part it cannot forge.
    const fork = { ...parked, headRepository: "stranger/check-my-app" };
    const d = mayUnpark({
      run: fork,
      prs: [{ headRef: "doer/6-x", headRepo: "stranger/check-my-app", author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("a fork's run stays parked even on a doer/* branch", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({
      run: { ...parked, headBranch: "feature/whatever" },
      prs: [{ headRef: "feature/whatever", headRepo: REPO, author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("a branch outside doer/* stays parked", d.unpark === false, d.reason);
  }
  {
    // The shadow implementer's prefix used to be released too (CHE-128). It is
    // nobody's branch now, and a branch nobody owns stays parked.
    const d = mayUnpark({
      run: { ...parked, headBranch: "mender/7-x" },
      prs: [{ headRef: "mender/7-x", headRepo: REPO, author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("a mender/* branch is no longer ours to release", d.unpark === false, d.reason);
  }
  {
    // Write access here is enough to push a `doer/*` branch, so the prefix alone
    // is not proof of authorship — the pull request's author is.
    const d = mayUnpark({
      run: parked,
      prs: [{ headRef: "doer/6-x", headRepo: REPO, author: "someone-else" }],
      repo: REPO,
    });
    check("a doer/* branch somebody else opened the PR for stays parked", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({ run: parked, prs: [], repo: REPO });
    check("a parked run with no open pull request stays parked", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({
      run: { ...parked, status: "completed", conclusion: "success" }, prs: [ourPr], repo: REPO,
    });
    check("a run that is not parked is left alone", d.unpark === false, d.reason);
  }

  // ── the sweep around that decision ─────────────────────────────────────────
  const fakeGh = ({ runs = [], prs = [], prsThrow = false }) => (args) => {
    const url = args[1] ?? "";
    if (url.includes("/actions/runs")) return runs;
    if (url.includes("/pulls")) {
      if (prsThrow) throw new Error("gh: 502 Bad Gateway");
      return prs;
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  const quiet = () => {};
  {
    const approved = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked, { ...parked, id: 2, headRepository: "stranger/x" }], prs: [ourPr] }),
      approve: (id) => approved.push(id),
      say: quiet,
    });
    check("the sweep releases ours and skips the rest",
      approved.join() === "1" && r.released.join() === "1" && r.skipped.length === 1,
      `approved=${approved.join()} skipped=${r.skipped.length}`);
  }
  {
    // An empty sweep still speaks. "Nothing was parked" and "the sweep never
    // ran" must not read the same in a log — this sweep is what stands between
    // a doer pull request and its checks (CHE-152).
    const said = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [], prs: [ourPr] }),
      approve: () => { throw new Error("nothing should be approved"); },
      say: (s) => said.push(s),
    });
    check("an empty sweep says so rather than saying nothing",
      r.released.length === 0 && said.some((s) => s.includes("nothing is parked")),
      `said=${said.join(" | ") || "(silence)"}`);
  }
  {
    // Fail closed. Without the pull requests, ownership cannot be established,
    // and an unverifiable claim of ownership releases nothing.
    const approved = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked], prsThrow: true }),
      approve: (id) => approved.push(id),
      say: quiet,
    });
    check("unreadable pull requests release nothing", approved.length === 0 && r.released.length === 0);
  }
  {
    // If GitHub refuses a workflow token this permission, the loop stops at a
    // button again — and it must never stop there silently.
    const said = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked], prs: [ourPr] }),
      approve: () => { throw new Error("Resource not accessible by integration"); },
      say: (s) => said.push(s),
    });
    check("a refused approval is reported, not swallowed",
      r.failed.length === 1 && said.some((s) => s.includes("FAILED")),
      said.join(" | "));
  }
}

// ── what the doer may take off our own board (CHE-118) ───────────────────────
//
// The rail here is not "does it admit the right things" — that is a judgement
// written down in queue.mjs. It is that every verdict carries a reason, that an
// unknown capability is refused rather than guessed at, and that nothing is
// silently dropped between the board and the queue.
{
  const v = admit({ title: "Fix the pricing page copy" });
  check(
    "a hand-written ticket is not the doer's queue",
    v.ok === false && v.reason.includes("not filed by a run"),
    v.reason,
  );
}
{
  const v = admit({ title: "[Checker gap] Checker cannot follow links that open in a new tab" });
  check("an admitted capability is taken, with its reason", v.ok === true && v.reason.length > 0, v.reason);
}
{
  // The real tickets on the board carry the policy's prefix; the ruling is
  // about the capability, so the prefix must not change the verdict.
  const v = admit({
    title: "[Checker gap] CheckMyApp agent capability: Checker cannot drive file upload/download flows",
  });
  check("the ticket policy's prefix does not hide the capability", v.ok === true, v.reason);
}
{
  const v = admit({
    title: "[Checker gap] CheckMyApp agent capability: Checker is blocked by CAPTCHA/bot protection on the target",
  });
  check(
    "bypassing bot protection is refused outright",
    v.ok === false && v.reason.includes("forbidden"),
    v.reason,
  );
}
{
  const v = admit({ title: "[Checker gap] Checker cannot read the customer's mind" });
  check(
    "a capability nobody has ruled on is refused, and says how to rule",
    v.ok === false && v.reason.includes("queue.mjs"),
    v.reason,
  );
}
{
  const v = admit({
    title: "[Checker defect] CheckMyApp checker accuracy: Checker reported a product defect caused by our own configuration",
  });
  check("a named defect class is work the doer may take", v.ok === true, v.reason);
}
{
  const v = admit({
    title: "[Checker defect] CheckMyApp checker accuracy: Checker filed a claim the owner rejected, cause unclassified",
  });
  check(
    "an unclassified defect is refused — nothing is named to fix",
    v.ok === false && v.reason.includes("classifying it is the filer's job"),
    v.reason,
  );
}
{
  // Every admitted defect label must map to a class, or the reader hands the
  // implementer a defect ticket with no evidence behind it.
  const missing = [...ADMITTED_DEFECTS.keys()].filter((l) => !DEFECT_CLASS_BY_LABEL.has(l));
  check("every admitted defect label names its class", missing.length === 0, missing.join(", "));
}
{
  // The shape the reader hands over: capability already recognised, no title.
  // Both shapes must reach the same ruling — a rule that depends on who asks is
  // two rules. This case exists because the first version had exactly that bug,
  // and the dry run against the real board caught it: eight tickets refused as
  // "not filed by a run" when all eight were filed by runs.
  const resolved = admit({ label: "Checker leaves test records behind in the customer's product", kind: "gap" });
  const byTitle = admit({
    title: "[Checker gap] Checker leaves test records behind in the customer's product",
  });
  check(
    "the reader's shape and a raw title reach the same ruling",
    resolved.ok === true && byTitle.ok === true && resolved.reason === byTitle.reason,
    `${resolved.ok}/${byTitle.ok}`,
  );
}
{
  const tickets = [
    { title: "[Checker gap] Checker cannot follow links that open in a new tab", createdAt: "2026-09-05" },
    { title: "[Checker gap] Checker is blocked by CAPTCHA/bot protection on the target", createdAt: "2026-09-01" },
    { title: "[Checker gap] Checker leaves test records behind in the customer's product", createdAt: "2026-08-27" },
  ];
  const { queue, refused } = partition(tickets);
  check(
    "nothing is dropped between the board and the queue",
    queue.length + refused.length === tickets.length,
    `${queue.length} queued + ${refused.length} refused of ${tickets.length}`,
  );
  check(
    "oldest first, so the queue never becomes a stack",
    queue[0]?.createdAt === "2026-08-27",
    String(queue[0]?.createdAt),
  );
  check(
    "every refusal carries its reason",
    refused.every((r) => typeof r.reason === "string" && r.reason.length > 0),
  );
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
