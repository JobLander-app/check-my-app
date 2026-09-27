"use server";

import { redirect } from "next/navigation";
import { requireActionScope } from "@/lib/team-auth";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { assertCanAddWatch } from "@/lib/plans";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import { extensionColumns, parseExtensionLink } from "@/lib/extension-target";
import { createCheckSchema, extensionOptionsFromForm } from "@/lib/validation";
import { alreadyScoped } from "@/lib/tenant-db";
import { extensionCheckFor } from "@/lib/viewer-flags";

// Persist an onboarded App + its Watch + TicketPolicy in one nested write.
// D1 has no transactions, but the spike (CHE-21) proved nested create works and
// these rows are created together once per app, so partial state is unlikely.
//
// CHE-84: business outcomes (plan cap, duplicate app, bad URL) are RETURNED,
// never thrown. A thrown error in a server action becomes an HTTP 500 and the
// generic "a server error occurred" page — our own self-check hit the free-plan
// watch cap and saw exactly that, with the app silently not created. A refusal
// the owner can act on must always arrive as text next to the button.
export type CreateAppResult = { error: string } | null;

// useActionState signature (prevState, formData): the form works as a plain
// HTML POST before hydration, so an early click is never swallowed (CHE-73/75
// class — the same bug we fixed on the verdict page).
export async function createApp(
  _prevState: CreateAppResult,
  formData: FormData,
): Promise<CreateAppResult> {
  const { user, db, team } = await requireActionScope("app.settings.write");

  const target = createCheckSchema.shape.url.safeParse(String(formData.get("targetUrl") ?? ""));
  if (!target.success) return { error: "Enter your app URL or a Chrome Web Store extension link." };
  const targetUrl = target.data;
  const isExtension = Boolean(parseExtensionLink(targetUrl));
  if (formData.get("targetKind") === "extension" && !isExtension) return { error: "Enter a Chrome Web Store extension link." };
  // CHE-320: the form hides extension mode when the flag is off, but a pasted
  // Web Store link would still become an extension here, since the kind is
  // read from the link. Same flag, same answer as the page.
  if (isExtension && !(await extensionCheckFor(user))) {
    return { error: "Chrome Web Store links can't be added here yet. Enter your app's own URL." };
  }
  const extension = extensionOptionsFromForm(formData);
  if (isExtension && !extension.success) return { error: extension.error.issues[0].message };
  const appSlug = appSlugFromUrl(targetUrl);

  const testEmail = (String(formData.get("testEmail") ?? "").trim() || null) as string | null;
  const testPassword = String(formData.get("testPassword") ?? "");
  const testPasswordEnc = testPassword ? encryptSecret(testPassword) : null;
  const focusAreas = (String(formData.get("focusAreas") ?? "").trim() || null) as string | null;
  // CHE-91: creation is opt-in AND only meaningful with a test account — the
  // run-time gate enforces the second half, this records the owner's consent.
  const writeMode = formData.get("writeMode") === "create_cleanup" ? "create_cleanup" : "read_only";
  const scopeHints = (String(formData.get("scopeHints") ?? "").trim() || null) as string | null;
  const userNotes = (String(formData.get("userNotes") ?? "").trim() || null) as string | null;
  const notifyEmail = (String(formData.get("notifyEmail") ?? "").trim() || null) as string | null;
  const frequency = String(formData.get("frequency") ?? "daily") as WatchFrequency;

  // Tier gate (CHE-34): Daily Watch availability + cadence + count per plan.
  const gate = isExtension ? { ok: true as const } : await assertCanAddWatch(db, {
    teamId: team.id,
    plan: team.plan as UserPlan,
    frequency,
  });
  if (!gate.ok) return { error: gate.reason };

  // Ticket policy — the pickup contract with the owner's own automation.
  const pickupLabels = String(formData.get("pickupLabels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const repoLabel = (String(formData.get("repoLabel") ?? "").trim() || null) as string | null;
  const urgentJourneys = String(formData.get("urgentJourneys") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // One App per (owner, slug). Pre-check for a clear message, and catch the
  // unique-constraint race (D1 has no transactions, so a double-submit can slip
  // past the check) rather than surfacing a raw 500.
  const dupe = await db.app.findUnique({ ...alreadyScoped("the unique key names the owner"),
    where: { ownerId_appSlug: { ownerId: user.id, appSlug } },
    select: { id: true },
  });
  if (dupe) {
    return { error: "You already have this app — manage it from your dashboard." };
  }

  try {
    await db.app.create({ ...alreadyScoped("created with its team"),
      data: {
        ownerId: user.id,
        teamId: team.id,
        targetUrl,
        ...extensionColumns(targetUrl, extension.success ? extension.data : undefined),
        appSlug,
        testEmail,
        testPasswordEnc,
        scopeHints,
        userNotes,
        focusAreas,
        writeMode,
        watch: isExtension ? undefined : {
          create: {
            appSlug,
            targetUrl,
            frequency,
            notifyEmail,
            ownerId: user.id,
            testEmail,
            testPasswordEnc,
          },
        },
        policy: {
          create: {
            pickupLabels: JSON.stringify(pickupLabels),
            repoLabel,
            priorityRule: JSON.stringify({ urgent: urgentJourneys }),
          },
        },
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return { error: "You already have this app — manage it from your dashboard." };
    }
    throw err;
  }

  redirect(`/dashboard?${isExtension ? "extensionAdded" : "added"}=${encodeURIComponent(appSlug)}`);
}
