// Named test accounts (CHE-322).
//
// The first outside developer asked for "tests on different accounts": an admin
// sees a different product from a free user, and a check that can only sign in
// as one of them verifies half of it. Until this an App held exactly one test
// login (App.testEmail / App.testPasswordEnc), copied onto every Run.
//
// ── One source of truth per account ─────────────────────────────────────────
//
// The App columns ARE the account called "default". Additional accounts live in
// the TestAccount table, one row each, and "default" is a reserved label there,
// so no account can exist in both places. The alternative — moving the default
// into the table and backfilling it — would have had to rewrite every path that
// reads the columns today (the public form, the $1 check, the watch copy, the
// extension runner, re-check, the agent's three tool environments) in the same
// change, or leave two copies of one password that the next edit updates only
// one of. The columns stay what they were; the table is only ever the extras.
//
// ── What a run carries ──────────────────────────────────────────────────────
//
// A Run snapshots the extras into Run.testAccounts (JSON, passwords still
// encrypted) exactly as it has always snapshotted the default into its own two
// columns: what the run signs in as is decided when it is created, not whenever
// a later phase happens to read the app. A one-off run loses every password when
// it ends (workflow.ts "cleanup"/"fail" → clearedCredentials below); labels and
// emails stay, so "which account was turned away" is still answerable afterwards.
//
// ── What the model sees ─────────────────────────────────────────────────────
//
// Labels only. It signs in with {{TEST_EMAIL:admin}} / {{TEST_PASSWORD:admin}},
// and the fill tool substitutes the values server-side, the same mechanism the
// default account has always used ({{TEST_EMAIL}} / {{TEST_PASSWORD}}). Emails
// are kept out of the prompt too — scrubSecrets already treats the default
// email as a secret, and a second account is no reason to be looser.

import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { teamOwned } from "@/lib/tenant-db";

/** The App.testEmail / App.testPasswordEnc account. Reserved in TestAccount. */
export const DEFAULT_ACCOUNT_LABEL = "default";

/** Extras per app. A bound, not a business rule: a prompt and a settings page
 *  that list forty logins are a different product. */
export const MAX_EXTRA_ACCOUNTS = 10;

// Lower-case letters, digits, spaces, "_", "." and "-", starting with a letter
// or digit. No braces or colons, because the label sits inside a placeholder:
// {{TEST_PASSWORD:free user}}.
const LABEL_SHAPE = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N} _.-]{0,31}$/u;

/**
 * The stored spelling of a label: trimmed, inner whitespace collapsed, lower
 * case. Null when it cannot be a label. Lower case so "Admin" and "admin" are
 * one account — in the table's unique key and in a placeholder the model typed.
 */
export function normalizeAccountLabel(raw: string | null | undefined): string | null {
  const label = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return LABEL_SHAPE.test(label) ? label : null;
}

export const LABEL_RULE =
  "An account label is 1–32 letters, digits, spaces, '_', '.' or '-', e.g. \"admin\" or \"free user\".";

/** One account as a run carries it. passwordEnc is null once a one-off run ends. */
export interface RunAccount {
  label: string;
  email: string;
  passwordEnc: string | null;
}

/** Tolerant: a malformed column is "no extra accounts", never a crashed run. */
export function parseRunAccounts(json: string | null | undefined): RunAccount[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((a) => {
      if (typeof a !== "object" || a === null) return [];
      const { label, email, passwordEnc } = a as Record<string, unknown>;
      const key = typeof label === "string" ? normalizeAccountLabel(label) : null;
      if (!key || key === DEFAULT_ACCOUNT_LABEL || typeof email !== "string" || !email) return [];
      return [{ label: key, email, passwordEnc: typeof passwordEnc === "string" && passwordEnc ? passwordEnc : null }];
    });
  } catch {
    return [];
  }
}

export function serializeRunAccounts(accounts: RunAccount[]): string | null {
  return accounts.length ? JSON.stringify(accounts.map(({ label, email, passwordEnc }) => ({ label, email, passwordEnc }))) : null;
}

/** An account the agent can actually sign in as: it has both halves. */
export function usableRunAccounts(json: string | null | undefined): RunAccount[] {
  return parseRunAccounts(json).filter((a) => a.passwordEnc);
}

/**
 * What a one-off run keeps of its credentials once it is over: the default
 * password goes, and so does every extra account's; labels and emails stay.
 * Shared by the success path and the failure path of the workflow, so the two
 * cannot drift the way they once did (0044_clear_failed_oneoff_passwords).
 */
export function clearedCredentials(run: { testAccounts?: string | null }): {
  testPasswordEnc: null;
  testAccounts: string | null;
} {
  const kept = parseRunAccounts(run.testAccounts).map((a) => ({ ...a, passwordEnc: null }));
  return { testPasswordEnc: null, testAccounts: serializeRunAccounts(kept) };
}

/** Run.rejectedAccounts: the labels an auth endpoint turned away, in order. */
export function parseRejectedAccounts(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((l) => (typeof l === "string" ? normalizeAccountLabel(l) : null)).filter((l): l is string => Boolean(l)))];
  } catch {
    return [];
  }
}

/**
 * Which accounts a rejected run should name. A row written before CHE-322 has
 * credentialsRejected set and no list — it had one account, the default.
 */
export function rejectedAccountLabels(run: { credentialsRejected: boolean; rejectedAccounts?: string | null }): string[] {
  if (!run.credentialsRejected) return [];
  const labels = parseRejectedAccounts(run.rejectedAccounts);
  return labels.length ? labels : [DEFAULT_ACCOUNT_LABEL];
}

/** "the default test account" / "the \"admin\" test account" / both, joined. */
export function describeAccounts(labels: string[]): string {
  const names = labels.map((l) => (l === DEFAULT_ACCOUNT_LABEL ? "the default test account" : `the "${l}" test account`));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ─── The app's accounts, read and written ─────────────────────────────────────

/**
 * The extras a new run of this app signs in with, as Run.testAccounts. Null for
 * an extension: the extension runner replays a sign-in with the one account it
 * is handed (src/agent/extension-replay.ts), so a second login there would be
 * one the replay cannot reproduce. appSettings refuses to store them for an
 * extension; this is the other half, for rows that predate that refusal.
 */
export async function snapshotAppAccounts(
  db: PrismaClient,
  app: { id: string | null; teamId: string | null; targetKind?: string | null },
): Promise<string | null> {
  if (!app.id || !app.teamId || app.targetKind === "extension") return null;
  const rows = await db.testAccount.findMany({
    where: { ...teamOwned(app.teamId), appId: app.id },
    orderBy: { createdAt: "asc" },
    select: { label: true, email: true, passwordEnc: true },
  });
  return serializeRunAccounts(rows);
}

/**
 * One edit to an app's extra accounts. `match` names the stored account being
 * edited — its id (the settings page, which can rename; it must exist) or its
 * label (MCP; an upsert) — and is absent for a new one. The password is
 * write-only exactly like the default's: undefined or "" keeps the stored one,
 * and a new account must bring one.
 */
export interface TestAccountEdit {
  match?: { id: string } | { label: string };
  label: string;
  email?: string;
  password?: string;
}

export interface TestAccountsPatch {
  set?: TestAccountEdit[];
  /** Ids or labels of accounts to delete. */
  remove?: string[];
}

type StoredRow = { id: string; label: string; email: string };

type Planned =
  | { ok: true; creates: { label: string; email: string; password: string }[]; updates: { id: string; label: string; email: string; password?: string }[]; deletes: StoredRow[] }
  | { ok: false; error: string };

const email = z.string().email();

/**
 * Pure: every edit is checked against the final set before anything is
 * written. D1 has no transactions, so a batch that fails on its third row must
 * fail before its first.
 */
export function planAccountEdits(stored: StoredRow[], patch: TestAccountsPatch): Planned {
  const byId = new Map(stored.map((r) => [r.id, r]));
  const find = (ref: string) => byId.get(ref) ?? stored.find((r) => r.label === normalizeAccountLabel(ref));

  const deletes: StoredRow[] = [];
  for (const ref of patch.remove ?? []) {
    const row = find(ref);
    if (!row) return { ok: false, error: `There is no test account called "${ref}".` };
    if (!deletes.includes(row)) deletes.push(row);
  }

  const final = new Map(stored.filter((r) => !deletes.includes(r)).map((r) => [r.id, { ...r }]));
  const creates: { label: string; email: string; password: string }[] = [];
  const updates: { id: string; label: string; email: string; password?: string }[] = [];

  for (const edit of patch.set ?? []) {
    const label = normalizeAccountLabel(edit.label);
    if (!label) return { ok: false, error: LABEL_RULE };
    if (label === DEFAULT_ACCOUNT_LABEL) {
      return { ok: false, error: `"${DEFAULT_ACCOUNT_LABEL}" is the app's main test login — set it with the test email and password.` };
    }
    const address = edit.email?.trim();
    if (address !== undefined && address !== "" && !email.safeParse(address).success) {
      return { ok: false, error: `The "${label}" test account needs a valid email address.` };
    }
    // By id, the account must exist (the settings page showed it). By label it
    // is an upsert: an agent naming "admin" means "the admin account", whether
    // or not one is stored yet.
    const target = edit.match ? ("id" in edit.match ? byId.get(edit.match.id) : find(edit.match.label)) : undefined;
    if (edit.match && "id" in edit.match && !target) return { ok: false, error: "That test account no longer exists — reload and try again." };
    if (target && deletes.includes(target)) continue;
    if (target) {
      const row = final.get(target.id)!;
      row.label = label;
      if (address) row.email = address;
      updates.push({ id: target.id, label, email: row.email, ...(edit.password ? { password: edit.password } : {}) });
    } else {
      if (!address) return { ok: false, error: `The "${label}" test account needs an email address.` };
      if (!edit.password) return { ok: false, error: `The "${label}" test account needs a password.` };
      creates.push({ label, email: address, password: edit.password });
    }
  }

  const labels = [...final.values()].map((r) => r.label).concat(creates.map((c) => c.label));
  const dupe = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dupe) return { ok: false, error: `Two test accounts cannot both be called "${dupe}".` };
  if (labels.length > MAX_EXTRA_ACCOUNTS) {
    return { ok: false, error: `An app can hold up to ${MAX_EXTRA_ACCOUNTS} named test accounts besides the main one.` };
  }
  return { ok: true, creates, updates, deletes };
}

/**
 * The settings page's account rows, read back from its one form. Each stored
 * account renders as `account:<id>:label|email|password|remove`, the empty row
 * for a new one as `newAccount:label|email|password`. A blank password box
 * keeps the stored one, exactly like the default login's; a blank new row is
 * no row at all.
 */
export function testAccountsFromForm(form: Pick<FormData, "get" | "keys">): TestAccountsPatch {
  const read = (name: string) => String(form.get(name) ?? "");
  const ids = [...new Set([...form.keys()].map((k) => /^account:([^:]+):label$/.exec(k)?.[1]).filter((id): id is string => Boolean(id)))];
  const set: TestAccountEdit[] = [];
  const remove: string[] = [];
  for (const id of ids) {
    if (form.get(`account:${id}:remove`)) {
      remove.push(id);
      continue;
    }
    set.push({ match: { id }, label: read(`account:${id}:label`), email: read(`account:${id}:email`), password: read(`account:${id}:password`) || undefined });
  }
  const fresh = { label: read("newAccount:label").trim(), email: read("newAccount:email").trim(), password: read("newAccount:password") };
  if (fresh.label || fresh.email || fresh.password) set.push({ label: fresh.label, email: fresh.email, password: fresh.password || undefined });
  return { set, remove };
}

/** What changed, in the team's own words, for the team event log (CHE-264). */
export interface AccountChangeSummary {
  added: string[];
  changed: string[];
  passwordsReplaced: string[];
  removed: string[];
}

/**
 * Apply a checked plan. The caller has already scoped the app to its team;
 * every write here is scoped again so no path can touch another team's rows.
 */
export async function writeAccountEdits(
  db: PrismaClient,
  app: { id: string; teamId: string },
  plan: Extract<Planned, { ok: true }>,
  stored: StoredRow[],
): Promise<AccountChangeSummary> {
  const summary: AccountChangeSummary = { added: [], changed: [], passwordsReplaced: [], removed: [] };
  for (const row of plan.deletes) {
    await db.testAccount.deleteMany({ where: { ...teamOwned(app.teamId), appId: app.id, id: row.id } });
    summary.removed.push(row.label);
  }
  // Renames that swap two labels would collide on the unique key mid-way; park
  // every renamed row on a label no person can type first.
  const renamed = plan.updates.filter((u) => stored.find((r) => r.id === u.id)?.label !== u.label);
  for (const u of renamed) {
    await db.testAccount.updateMany({ where: { ...teamOwned(app.teamId), appId: app.id, id: u.id }, data: { label: `{renaming:${u.id}}` } });
  }
  for (const u of plan.updates) {
    const before = stored.find((r) => r.id === u.id);
    await db.testAccount.updateMany({
      where: { ...teamOwned(app.teamId), appId: app.id, id: u.id },
      data: { label: u.label, email: u.email, ...(u.password ? { passwordEnc: encryptSecret(u.password) } : {}) },
    });
    if (before && (before.label !== u.label || before.email !== u.email)) summary.changed.push(u.label);
    if (u.password) summary.passwordsReplaced.push(u.label);
  }
  for (const c of plan.creates) {
    await db.testAccount.create({
      data: { ...teamOwned(app.teamId), appId: app.id, label: c.label, email: c.email, passwordEnc: encryptSecret(c.password) },
    });
    summary.added.push(c.label);
  }
  return summary;
}
