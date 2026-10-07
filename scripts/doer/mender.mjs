// Mender: the doer's implementer (owner, 2026-09-18).
//
// Until now the implementer was Codex, asked by an "@codex" comment on the
// claim's pull request — and Codex answers only an identity linked to a ChatGPT
// account, and could not push to this repository at all (CHE-155). Six claims in
// a row were withdrawn "the implementer never came", and the loop ticked green
// for twelve days building nothing.
//
// Mender (JobLander-app/mender) is the implementer that was measured alongside
// it as a shadow (CHE-128): a cheap model in a bash loop, a patch as its only
// output, and a gate — apply, setup, typecheck, lint, the verify:* registry, and
// for a bug a test that fails without the patch and passes with it — run in a
// checkout the model never saw. Codex stays as the reviewer, which keeps the
// arrangement rule §8 requires: whoever writes the code does not judge it.
//
// What changed in the shape of the handoff, and why:
//
//   - Mender runs INSIDE the tick, in GitHub Actions, not on a laptop. The
//     shadow leg required a checkout on the operator's machine and was skipped
//     in Actions by name; an implementer that only exists where a person is
//     sitting is not an implementer for an unattended loop.
//   - It is handed the ticket as a file, not as a GitHub issue URL. The queue
//     is read from our own database (CHE-118) and the tickets live on Linear;
//     Mender should not need a credential for every tracker a caller uses.
//   - It publishes nothing itself. The patch and the report come back as files;
//     the tick commits them to the doer's own branch and opens the doer's own
//     pull request, so the merge gate, the reviewer and the unpark sweep see
//     exactly the shape they always saw.
//
// Pure functions first — every decision here is a rail, and a rail nobody can
// test is a comment (scripts/verify-doer.mjs) — then the one impure function
// that spends money.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The account whose commits carry Mender's patches onto a doer branch. */
export const COMMIT_IDENTITY = { name: "checkmyapp-doer", email: "doer@checkmyapp.dev" };

/**
 * How a red attempt is recorded: a draft pull request with this title,
 * closed in the same tick. The title is what makes it countable later.
 */
export const WITHDRAWN_TITLE_PREFIX = "[doer] attempt withdrawn";

/**
 * A closed pull request that was a real attempt with a red gate — the only
 * kind that counts toward a ticket stepping aside (CHE-211).
 *
 * The Codex-era claims closed "the implementer never came" are deliberately
 * not counted: nobody attempted those tickets, and on the day Mender took
 * over every admitted ticket carried two of them (CHE-96, CHE-146, CHE-222),
 * which would have exhausted the whole queue before the first attempt.
 */
export function isWithdrawnAttempt(pr) {
  return String(pr?.title ?? "").startsWith(WITHDRAWN_TITLE_PREFIX) && !pr?.mergedAt;
}

/**
 * Does this withdrawn attempt count against the model about to try? Only an
 * attempt by the same model does: the ladder in mender.yml is [t1, t2], and a
 * ticket two t1 attempts could not do is exactly the ticket t2 exists for.
 * Counting every model together stalled the queue for good — from 2026-10-04
 * every admitted ticket (CHE-96, CHE-146, CHE-222) had two withdrawn
 * deepseek-v4-flash attempts at 40 steps, nine of eleven with no patch at all,
 * and each tick ended "no implementer is delivering on these".
 *
 * The model is read from the attempt's own body, where the tick records it
 * ("· 40 steps · deepseek/deepseek-v4-flash"). An empty model counts nothing.
 */
/** The model this tick's tier names (doer.yml: MENDER_TIER=t2 → MENDER_T2). */
export function tierModel(env = process.env) {
  const tier = String(env.MENDER_TIER ?? "t1");
  return String(env[`MENDER_${tier.toUpperCase()}`] ?? "");
}

export function withdrawnByModel(pr, model) {
  if (!isWithdrawnAttempt(pr) || !model) return false;
  return String(pr?.body ?? "").includes(`· ${model}`);
}

/**
 * May Mender run here at all? Pure, because "it silently did nothing" is the
 * failure mode the whole loop is trying to avoid: a tick that finds no Mender
 * must say so by name and stop, never claim a ticket it cannot work on.
 *
 * @returns {{run:boolean, reason:string}}
 */
export function decideMender({ home = "", hasCli = false, hasUv = false }) {
  if (!home) return { run: false, reason: "no Mender checkout found — set MENDER_HOME" };
  if (!hasCli) return { run: false, reason: `no cli/main.py under ${home}` };
  if (!hasUv) return { run: false, reason: "uv is not on PATH — Mender runs under uv" };
  return { run: true, reason: `Mender at ${home}` };
}

/**
 * The ticket Mender is handed, in the JSON shape its `--ticket-file` reads.
 *
 * The body is written here, from what our own database holds, because the
 * ticket on the board is not reachable without a Linear credential this
 * workflow does not carry — and everything the board ticket says was written
 * by us from the same rows (src/agent/capability-gaps.ts). Rule §9 shapes it:
 * the symptom, the evidence, and how to know it is gone. No files, no causes,
 * no fixes; the implementer has the repository and diagnoses for itself.
 *
 * @param {object} args
 * @param {{ticket:string,label:string,kind:"gap"|"defect",occurrences:number,reason:string,evidence?:object}} args.item
 * @param {string} args.repo owner/name
 * @param {{round:number, findings:string}} [args.round] a fix round: what the reviewer objected to
 */
export function ticketFor({ item, repo, round = null }) {
  const kind = item.kind === "defect" ? "checker defect" : "checker gap";
  const prefix = item.kind === "defect" ? "[Checker defect]" : "[Checker gap]";
  const ev = item.evidence ?? {};
  const lines = [
    `Filed by CheckMyApp's own runs against itself: a ${kind}, seen ${item.occurrences} time(s). ` +
      `Board ticket ${item.ticket}.`,
    "",
    "## The symptom",
    "",
    item.label + ".",
  ];
  if (ev.why) lines.push("", ev.why);
  if (item.reason) lines.push("", `Why the doer may take it: ${item.reason}.`);

  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  const signatures = Array.isArray(ev.signatures) ? ev.signatures : [];
  lines.push("", "## Evidence (most recent first)", "");
  if (steps.length) {
    for (const s of steps) {
      const when = String(s.createdAt ?? "").slice(0, 10);
      lines.push(
        `- ${when} · run ${s.runId} on ${s.appSlug} · journey "${s.journey}" · step "${s.label}"`,
        `  attempted: ${oneLine(s.attempted)}`,
        `  observed: ${oneLine(s.observed)}`,
      );
    }
  } else if (signatures.length) {
    lines.push("Claims of ours the owner of the product rejected as not-a-bug, filed under this cause:");
    for (const s of signatures) {
      lines.push(`- ${String(s.settledAt ?? "").slice(0, 10)} · ${s.externalIssueId} on ${s.appSlug}`);
    }
  } else {
    lines.push(
      "No step rows carry this class yet — the count above comes from the board. " +
        "The capability is named exactly; the repository shows where the walk gives up on it.",
    );
  }

  lines.push(
    "",
    "## How to know it is gone",
    "",
    "A later CheckMyApp run against the deployed product no longer files this ticket: " +
      "the step is verified instead of skipped with `unverifiedReason: our_capability`" +
      (item.kind === "defect" ? ", and no claim of ours is rejected for this cause again" : "") +
      ".",
    "",
    "The change is not user-visible, so it lands with a `scripts/verify-*.ts` (or `.mjs`) script of " +
      "its own that fails on the code as it stands and passes with the change (AGENTS.md). " +
      "That script is what the gate runs.",
  );

  if (round) {
    lines.push(
      "",
      `## Review findings to address (round ${round.round})`,
      "",
      "The reviewer left these on the pull request that carries your earlier patch. Fix what each one " +
        "points at, or — if a finding is wrong — leave the code as it is; you cannot reply, so a finding " +
        "you disagree with must be visibly unaffected by your change.",
      "",
      round.findings,
    );
  }

  return {
    repo,
    key: item.ticket,
    title: `${prefix} ${item.label}`,
    body: lines.join("\n"),
    labels: ["bug"],
    url: `https://linear.app/issue/${item.ticket}`,
  };
}

function oneLine(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > 400 ? `${t.slice(0, 400)}…` : t) : "(nothing recorded)";
}

/**
 * The argv for `uv`, run from Mender's checkout.
 *
 * `--no-publish` is the whole handoff: Mender's part ends with a patch the gate
 * passed and a report beside it, and the tick owns the branch. `--base` is the
 * doer branch, so a fix round builds on the earlier patch rather than on main.
 */
export function attemptArgs({ ticketFile, base, tier, budget, runnerTimeout, maxSteps, attempt = 1, rehearse = false }) {
  const args = [
    "run", "cli/main.py", "run",
    "--ticket-file", String(ticketFile),
    "--no-publish",
    "--base", String(base),
    "--tier", tier,
    "--budget", Number(budget).toFixed(2),
    "--runner-timeout", String(runnerTimeout),
    "--max-steps", String(maxSteps),
    "--attempt", String(attempt),
  ];
  // Mender's own --dry-run: the real gate, a stubbed model, nothing spent. It
  // is the only way to exercise this leg end to end without buying a model
  // call every time somebody changes a line here.
  if (rehearse) args.push("--dry-run");
  return args;
}

// The ledger's columns are machine-generated identifiers and numbers — no free
// text ever reaches it — so a plain split is enough and a CSV parser is not.
//
// The \r is not decoration. Python's csv.writer terminates every line with
// CRLF; splitting on "\n" alone left a carriage return glued to the last
// column and every row's ts read as undefined (found 2026-09-04 against the
// real ledger; a made-up fixture would have used "\n" and passed).
export function parseLedger(csv) {
  const lines = String(csv ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

/** Rows written since a moment — how we tell our attempt's row from history's. */
export function ledgerRowsSince(csv, startedAtMs) {
  return parseLedger(csv).filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= startedAtMs;
  });
}

/**
 * A row that recorded no money for an attempt that really called a provider.
 * `stub` rows come from --dry-run and genuinely cost nothing.
 *
 * On 2026-09-04 a killed runner recorded $0.00 for an attempt the provider had
 * billed $0.155 for, and the ledger under-reported the month by a third.
 */
export function unpricedAttempt(row) {
  if (!row) return false;
  if (row.provider === "stub") return false;
  return Number(row.cost_usd) === 0;
}

/**
 * What the tick does with an attempt. Three outcomes, and they are different
 * news: a green gate is a patch to commit; a red one is an attempt to record
 * and withdraw; no row at all means the attempt never landed anywhere, which
 * is a defect of ours, not a result about the ticket.
 *
 * @param {object|null} row the ledger row for this attempt
 * @param {boolean} hasPatch whether patch.diff exists and is non-empty
 * @returns {{action:"commit"|"withdraw"|"defect", summary:string}}
 */
export function outcomeOf(row, hasPatch) {
  if (!row) {
    return { action: "defect", summary: "Mender recorded no attempt at all — nothing to judge, nothing to withdraw" };
  }
  const price = unpricedAttempt(row) ? " (UNPRICED — a bug, not a gap)" : "";
  const where = row.failure_stage ? ` at \`${row.failure_stage}\`` : "";
  if (row.verdict === "green") {
    if (!hasPatch) {
      return { action: "defect", summary: `Mender's gate went green but left no patch — that is a defect, not a result${price}` };
    }
    return { action: "commit", summary: `Mender's gate is green · $${row.cost_usd} · ${row.steps} steps · ${row.model}${price}` };
  }
  return {
    action: "withdraw",
    summary: `Mender's gate was ${row.verdict}${where} · $${row.cost_usd} · ${row.steps} steps · ${row.model}${price}`,
  };
}

/**
 * The reviewer's findings as text for the next round's ticket, from what
 * GitHub holds: unresolved, non-outdated review threads and failing checks.
 * Written from the facts, never from a phrase — the reviewer's house style is
 * not the loop's concern.
 *
 * @param {{path:string,line:number|null,comments:{author:string,body:string}[]}[]} threads
 * @param {string[]} failedChecks
 */
export function findingsText(threads = [], failedChecks = []) {
  const out = [];
  if (failedChecks.length) {
    out.push(`Failing checks on the current head: ${failedChecks.join(", ")}. Run the commands in mender.yml and make them pass.`);
  }
  threads.forEach((t, i) => {
    const where = t.line ? `${t.path}:${t.line}` : t.path;
    out.push(`${i + 1}. ${where}`);
    for (const c of t.comments ?? []) {
      const body = String(c.body ?? "").replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
      if (body) out.push(`   ${c.author}: ${body.replace(/\s*\n\s*/g, "\n   ")}`);
    }
  });
  return out.join("\n");
}

/**
 * Where Mender lives. `MENDER_HOME` when set — and then only there, never
 * falling back: an operator who names a path and silently gets a different
 * checkout is the "configuration" defect class in CLAUDE.md §8. When it is
 * unset the sibling checkout is tried, which is the layout on a laptop; in
 * Actions the workflow checks Mender out and names it. A wrong guess is safe
 * by construction, because decideMender requires cli/main.py to exist and the
 * worst outcome is a named stop.
 */
export function findMenderHome(env = process.env, exists = (p) => existsSync(p)) {
  if (env.MENDER_HOME) return resolve(env.MENDER_HOME);
  const sibling = resolve(dirname(fileURLToPath(import.meta.url)), "../../../mender");
  return exists(join(sibling, "cli", "main.py")) ? sibling : "";
}

function onPath(bin) {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one attempt. The one function here that spends money.
 *
 * Never throws for a Mender failure: an attempt that crashed is still an
 * attempt, and the caller decides what to do with the row (or its absence). It
 * does throw when Mender is not runnable at all — that is the tick's
 * configuration, not a result about the ticket, and a tick must not claim a
 * ticket it cannot work on.
 *
 * @returns {{row:object|null, patch:string|null, report:string|null, exit:number|null, home:string}}
 */
export function runMender({ ticketFile, base, env = process.env, say = console.log, ...rest }) {
  const home = findMenderHome(env);
  const decision = decideMender({
    home,
    hasCli: !!home && existsSync(join(home, "cli", "main.py")),
    hasUv: onPath("uv"),
  });
  if (!decision.run) throw new Error(`Mender cannot run: ${decision.reason}`);

  const args = attemptArgs({
    ticketFile,
    base,
    tier: env.MENDER_TIER ?? "t1",
    budget: Number(env.MENDER_BUDGET ?? 1.0),
    runnerTimeout: Number(env.MENDER_RUNNER_TIMEOUT ?? 1800),
    maxSteps: Number(env.MENDER_MAX_STEPS ?? 40),
    attempt: Number(rest.attempt ?? 1),
    rehearse: env.MENDER_REHEARSE === "1",
  });
  say(`Mender: ${decision.reason}`);
  say(`   uv ${args.join(" ")}`);

  const ledger = join(home, "runs", "ledger.csv");
  const startedAt = Date.now();
  // The deadline is a last resort, not a control: Mender bounds its own runner
  // and asks it to stop before killing it, precisely so the price survives. A
  // kill from here lands on a process that writes its ledger row last, so the
  // row is lost — which is why the deadline is far outside Mender's own.
  const deadline = Number(env.MENDER_TIMEOUT ?? 3600) * 1000;
  const r = spawnSync("uv", args, { cwd: home, stdio: "inherit", timeout: deadline, env });
  if (r.error?.code === "ETIMEDOUT") {
    say(`   Mender passed ${deadline / 1000}s and was stopped. Its price may not have been written.`);
  } else if (r.error) {
    say(`   Mender could not be started: ${r.error.message}`);
  } else {
    say(`   Mender exited ${r.status} (1 just means the gate was not green).`);
  }

  const rows = existsSync(ledger) ? ledgerRowsSince(readFileSync(ledger, "utf8"), startedAt) : [];
  const row = rows.length ? rows[rows.length - 1] : null;
  if (!row) {
    say(`   WARNING: no ledger row for this attempt in ${ledger} — the attempt is unpriced, which is a bug, not a gap.`);
    return { row: null, patch: null, report: null, exit: r.status ?? null, home };
  }
  const work = join(home, "runs", row.task_id);
  const patch = join(work, "patch.diff");
  const report = join(work, "report.md");
  return {
    row,
    patch: existsSync(patch) && readFileSync(patch, "utf8").trim() ? patch : null,
    report: existsSync(report) ? report : null,
    exit: r.status ?? null,
    home,
  };
}
