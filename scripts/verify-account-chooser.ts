// CHE-276 verification: "Continue with Google" asks WHICH Google account.
//
// Reported by the owner against production: the button signed him in with
// whichever account Chrome was synced to, with no chooser. That is Google's
// behaviour when the OIDC `prompt` parameter is absent — the provider picks the
// browser's session for you — so the button is not a choice, it is an
// announcement. It also makes a second account unreachable, which is precisely
// what accepting a team invitation needs (CHE-265).
//
// The fix is one prop, which is exactly the kind of thing that gets dropped in a
// refactor and noticed months later by one confused person. So it is checked
// over the mounts: every Clerk sign-in or sign-up surface must carry
// `oidcPrompt="select_account"`, and the one component that CANNOT carry it —
// `SignInButton`/`SignUpButton` in modal mode — must not exist.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-account-chooser.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPT = 'oidcPrompt="select_account"';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, "src")).map((f) => relative(ROOT, f));

// ─── Every mount asks ────────────────────────────────────────────────────────

const mounts: { file: string; tag: string; hasPrompt: boolean; wrapped: boolean }[] = [];
for (const file of files) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const m of text.matchAll(/<(SignIn|SignUp)(\s[^>]*)?\/?>/g)) {
    const before = text.slice(0, m.index);
    mounts.push({
      file,
      tag: m[1],
      hasPrompt: (m[2] ?? "").includes(PROMPT),
      wrapped: /<GoogleAccountChooser>\s*$/.test(before),
    });
  }
}

check("found the sign-in and sign-up surfaces", mounts.length >= 2, `${mounts.length} mounts`);
const silent = mounts.filter((m) => !m.hasPrompt);
check(
  "every Clerk auth surface asks which Google account",
  silent.length === 0,
  silent.map((m) => `${m.file} <${m.tag}>`).join(", ") || mounts.map((m) => `${m.file} <${m.tag}>`).join(", "),
);

// ─── …and on sign-in the prompt is sent by us, not by the prop ───────────────
//
// The prop alone did not reach Google on sign-in: clerk-js 6.34.1
// `signIn.authenticateWithRedirect` creates the sign-in without `oidcPrompt`, so
// production kept signing people into the browser's account while every check
// above passed. GoogleAccountChooser starts the flow with `signIn.create`, which
// does send it. A SignIn mount outside the wrapper, or a wrapper that stopped
// passing the prompt, is the old behaviour again.

const unwrapped = mounts.filter((m) => m.tag === "SignIn" && !m.wrapped);
check(
  "every sign-in mount sits inside GoogleAccountChooser",
  mounts.some((m) => m.tag === "SignIn") && unwrapped.length === 0,
  unwrapped.map((m) => `${m.file} <${m.tag}>`).join(", ") || "clean",
);
const CHOOSER = "src/components/google-account-chooser.tsx";
const chooser = files.includes(CHOOSER) ? readFileSync(join(ROOT, CHOOSER), "utf8") : "";
check(
  "GoogleAccountChooser starts Google with signIn.create and the prompt",
  /signIn\s*\.create\(\{[\s\S]{0,400}?strategy:\s*"oauth_google"[\s\S]{0,400}?oidcPrompt:\s*"select_account"/.test(chooser),
  chooser ? CHOOSER : `${CHOOSER} missing`,
);

// ─── And the surface that cannot ask does not exist ──────────────────────────
//
// SignInButtonProps picks only fallbackRedirectUrl, forceRedirectUrl,
// signUpForceRedirectUrl, signUpFallbackRedirectUrl, initialValues, withSignUp
// and oauthFlow out of SignInProps. oidcPrompt is not among them, so a modal
// opened by that button silently keeps the old behaviour — and the product
// would then have two sign-in surfaces that behave differently, which is worse
// than one that behaves badly, because only one of them would ever be reported.

const modals = files.filter((f) => {
  const text = readFileSync(join(ROOT, f), "utf8");
  return /<Sign(In|Up)Button[\s\S]{0,200}?mode="modal"/.test(text);
});
check(
  "no modal sign-in: that component cannot carry the prompt, and two surfaces with two behaviours is worse than one",
  modals.length === 0,
  modals.join(", ") || "clean",
);

// ─── The prop is real in the installed version ───────────────────────────────
// Asserted against the dependency rather than trusted: a prop React does not
// recognise is silently dropped, and "we passed it" would look identical to
// "it worked".

// The path is WALKED UP rather than hardcoded. Several sessions work in git
// worktrees, which have no `node_modules` of their own — Node's module
// resolution walks up the tree, which is why `npx tsx` works there at all, but a
// relative path does not. The first version of this file hardcoded one and
// turned `verify:all` red in every worktree for a reason that had nothing to do
// with the code being checked (found by the `journeys` session).
const CLERK_TYPES = "node_modules/@clerk/shared/dist/types/clerk.d.ts";
function findUp(relative: string): string | null {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, relative);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const clerkTypesPath = findUp(CLERK_TYPES);
if (!clerkTypesPath) {
  // Stated, not silent. A dependency we cannot read is "unknown", and unknown
  // is the one answer this suite must never print as a pass — but it is also
  // not a defect in the product, so it does not fail the run either.
  console.log(
    `SKIP  the installed Clerk types could not be read — no ${CLERK_TYPES} at or above ${ROOT}. ` +
      `The two dependency assertions below did not run.`,
  );
} else {
  const clerkTypes = readFileSync(clerkTypesPath, "utf8");
  const signInProps = clerkTypes.slice(clerkTypes.indexOf("type SignInProps ="), clerkTypes.indexOf("type SignInModalProps"));
  check(
    "SignInProps in the installed Clerk actually has oidcPrompt",
    /oidcPrompt\?: string/.test(signInProps),
  );
  check(
    "…and SignInButtonProps still does not — the reason the header is a link",
    /type SignInButtonProps = [^;]*/.test(clerkTypes) &&
      !/type SignInButtonProps = [^;]*oidcPrompt/.test(clerkTypes),
  );
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
