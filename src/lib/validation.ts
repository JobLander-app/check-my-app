import { z } from "zod";
import { isChromeStoreUrl, parseExtensionLink } from "./extension-target";
import { isPrivateTarget, PRIVATE_TARGET_MESSAGE } from "./private-target";

export const extensionOptionsSchema = z.object({
  companionUrl: z.string().trim().url().refine(u => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".");
    } catch { return false; }
  }, "Enter the HTTPS address where your extension works")
    // The page the extension is opened on is a target too (CHE-390).
    .refine((u) => !isPrivateTarget(u), PRIVATE_TARGET_MESSAGE).optional().or(z.literal("")),
  expectedOutcome: z.string().trim().max(1000).optional(),
  allowSessions: z.boolean().optional(),
  maxSessionSeconds: z.number().int().min(60).max(600).optional(),
});

export function extensionOptionsFromForm(form: FormData) {
  return extensionOptionsSchema.safeParse({
    companionUrl: String(form.get("extensionCompanionUrl") ?? "").trim(),
    expectedOutcome: String(form.get("extensionExpectedOutcome") ?? "").trim(),
    allowSessions: form.get("extensionAllowSessions") === "yes",
    maxSessionSeconds: Number(form.get("extensionMaxSessionSeconds") ?? 180),
  });
}

// Bare domains ("theins.ru") are fine — we assume https:// for them.
export function normalizeTargetUrl(raw: string): string {
  const u = raw.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

// Submission payload from the home-page form.
export const createCheckSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Doesn't look like a working URL")
    .transform(normalizeTargetUrl)
    .pipe(
      z
        .string()
        .url("Doesn't look like a working URL")
        // First, so "localhost:3000" is told why and not that it is no URL.
        .refine((u) => !isPrivateTarget(u), PRIVATE_TARGET_MESSAGE)
        .refine((u) => {
          try {
            return new URL(u).hostname.includes(".") && (!isChromeStoreUrl(u) || Boolean(parseExtensionLink(u)));
          } catch {
            return false;
          }
        }, "Doesn't look like a working URL"),
    ),
  testEmail: z.string().email().optional().or(z.literal("")),
  extension: extensionOptionsSchema.optional(),
  testPassword: z.string().optional().or(z.literal("")),
  // CHE-372: a password-protected store's storefront password (Shopify's
  // /password page). Encrypted like testPassword, never returned.
  storePassword: z.string().max(500).optional().or(z.literal("")),
  scopeHints: z.string().max(2000).optional().or(z.literal("")),
  userNotes: z.string().max(2000).optional().or(z.literal("")),
  notifyEmail: z.string().email("Enter a valid email").optional().or(z.literal("")),
  // Deploy identity (CHE-56) — an API-key/CI feature: name the build this check
  // verifies so the verdict can gate that specific release. The browser form
  // never sends it; an anonymous caller passing it is harmless, just unattributed.
  //
  // `sha` is deliberately not `/^[0-9a-f]{40}$/`: a caller may send a short sha,
  // a merge-commit sha, or a non-git build id, and rejecting those would only
  // break the CI job we're trying to serve. The bounds exist so the column can't
  // become a scratchpad; the charset keeps it a single opaque token.
  deploy: z
    .object({
      sha: z
        .string()
        .trim()
        .min(7, "Deploy sha looks too short")
        .max(64, "Deploy sha looks too long")
        .regex(/^[A-Za-z0-9._-]+$/, "Deploy sha may only contain letters, digits, . _ -"),
      env: z.string().trim().max(40).optional().or(z.literal("")),
    })
    .optional(),
  // CHE-202: the target is a PR preview, not an app — the run is private,
  // gets no App row and is deleted after EPHEMERAL_RUN_TTL_DAYS. Owners only;
  // the route refuses it for anonymous callers (src/lib/ephemeral.ts).
  ephemeral: z.boolean().optional(),
});

export type CreateCheckInput = z.infer<typeof createCheckSchema>;

// Loop C — edit the App Lens / react to it (Verdict §3.1).
export const updateLensSchema = z.object({
  lens: z
    .object({
      oneLiner: z.string().max(500),
      whoFor: z.string().max(500),
      coreValue: z.string().max(500),
      businessModel: z.string().max(500),
      techSurface: z.string().max(500),
      criticalPaths: z.array(z.string().max(300)).max(10),
      ifItBreaks: z.string().max(500),
    })
    .optional(),
  // "confirmed" = [Looks right ✓]; anything else = the "something's off" note.
  feedback: z.string().max(2000).optional(),
});

// Loop C — finding triage from the verdict page (feeds Daily Check noise filter).
export const markFindingSchema = z.object({
  mark: z.enum(["none", "known", "fixed", "false_positive", "watch"]),
});

// Enable Daily Watch from the verdict footer (Loop B).
export const createWatchSchema = z.object({
  runId: z.string().min(1), // run publicId the watch is created from
  frequency: z.enum(["daily", "every_6h", "manual"]).default("daily"),
  notifyOnChangeOnly: z.boolean().default(true),
});

// Connect GitHub for spec export (verdict "Export to GitHub"). v1: fine-grained
// PAT + owner/repo; the token is validated against the repo before storing.
export const connectGithubSchema = z.object({
  runId: z.string().min(1), // run publicId the connect started from
  token: z.string().trim().min(20).max(400),
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use the owner/repo form"),
});

// Watch settings (Screen 4).
export const updateWatchSchema = z.object({
  frequency: z.enum(["daily", "every_6h", "manual"]).optional(),
  notifyOnChangeOnly: z.boolean().optional(),
  active: z.boolean().optional(),
});
