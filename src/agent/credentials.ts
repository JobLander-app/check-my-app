// The one-attempt rule for a rejected credential (CHE-100).
//
// On 2026-08-24 the password we held for a customer's QA account was stale. The
// agent submitted it five times in one run. Every consequence was ours: two
// tickets filed against a product that worked, an investigation by their team to
// disprove them, and a Firebase lockout that refused a real user with their own
// correct password twenty-seven seconds later.
//
// An auth endpoint answering 401 to a bad password is the product working. Rule
// §8: we do not settle "ours or theirs" by looking deeper into the customer — we
// remove our ability to get it wrong. So the first rejection ends the subject
// for the whole run.
//
// State lives on the Run row rather than in memory for one reason: a run is a
// Workflow of separate steps, discovery and each journey among them. Memory does
// not survive a replay and does not cross a step boundary; the rule has to do
// both, or "one attempt" quietly becomes one attempt per journey.
//
// CHE-322: an app can hold several named accounts, and "the subject" is now one
// account. A stale admin password ends the admin sign-in for the run and leaves
// the free user's alone — and the run records WHICH was turned away
// (Run.rejectedAccounts), so the verdict asks for the right password.

import { decryptSecret } from "@/lib/crypto";
import { DEFAULT_ACCOUNT_LABEL, describeAccounts, parseRejectedAccounts, usableRunAccounts } from "@/lib/test-accounts";
import { parseJson } from "@/lib/json";
import type { RunEvent, RunPhase } from "@/lib/types";
import type { AgentEnv } from "./env";
import type { ToolEnv } from "./tools";

export async function credentialState(
  env: AgentEnv,
  runId: string | undefined,
): Promise<NonNullable<ToolEnv["credentials"]>> {
  if (!runId) return { rejected: false };
  const row = await env.db.run.findUnique({
    where: { id: runId },
    select: { credentialsRejected: true, rejectedAccounts: true },
  });
  const accounts = parseRejectedAccounts(row?.rejectedAccounts);
  return { rejected: row?.credentialsRejected ?? false, ...(accounts.length ? { accounts } : {}) };
}

// Never throws: failing to record this must not fail a run. The in-memory flag
// the caller already set still holds for the rest of the current phase, so the
// worst case of a write failure is that the next phase tries once more — not
// that the walk resumes hammering the endpoint.
//
// Read-then-write, not a transaction (D1 has none): two journeys of one run are
// sequential Workflow steps, so two rejections cannot race here.
export async function recordCredentialRejection(
  env: AgentEnv,
  runId: string | undefined,
  signature: string,
  account: string,
): Promise<void> {
  console.warn(`[credentials] "${account}" rejected for run ${runId ?? "(none)"}: ${signature}`);
  if (!runId) return;
  try {
    const row = await env.db.run.findUnique({
      where: { id: runId },
      select: { credentialsRejected: true, rejectedAccounts: true, status: true, events: true },
    });
    const known = parseRejectedAccounts(row?.rejectedAccounts);
    // A flag set before this column existed stood for the default account.
    const before = row?.credentialsRejected && known.length === 0 ? [DEFAULT_ACCOUNT_LABEL] : known;
    if (before.includes(account)) return;
    const accounts = [...before, account];
    // Said in the live feed the moment it happens, in code rather than left to
    // the verdict's wording: the owner reads which login to fix while the run
    // is still going. A fact about access, never about the product (CHE-100).
    const parsed = parseJson<RunEvent[]>(row?.events);
    const events = Array.isArray(parsed) ? parsed : [];
    const phase: RunPhase = row?.status === "discovery" ? "discovery" : "walking";
    events.push({
      at: new Date().toISOString(),
      phase,
      icon: "warn",
      text: `The sign-in details for ${describeAccounts([account])} were not accepted, so what needs that account can't be checked this run.`,
    });
    await env.db.run.update({
      where: { id: runId },
      data: { credentialsRejected: true, rejectedAccounts: JSON.stringify(accounts), events: JSON.stringify(events) },
    });
  } catch (err) {
    console.warn(
      `[credentials] could not record rejection: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * The credential half of every ToolEnv a run builds — discovery, each journey,
 * the replay audit. One function so the three cannot disagree about which
 * accounts exist or what was already turned away. Decrypted here, in memory;
 * the model only ever sees placeholders.
 */
export async function credentialToolEnv(
  env: AgentEnv,
  run: { id?: string; testEmail?: string | null; testPasswordEnc?: string | null; testAccounts?: string | null },
): Promise<Pick<ToolEnv, "testEmail" | "testPassword" | "testAccounts" | "credentials" | "onCredentialRejected">> {
  return {
    testEmail: run.testEmail ?? undefined,
    testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
    testAccounts: usableRunAccounts(run.testAccounts).map((a) => ({
      label: a.label,
      email: a.email,
      password: decryptSecret(a.passwordEnc!),
    })),
    credentials: await credentialState(env, run.id),
    onCredentialRejected: (signature, account) => recordCredentialRejection(env, run.id, signature, account),
  };
}
