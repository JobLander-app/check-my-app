"use server";

import { redirect } from "next/navigation";
import { requireActionScope } from "@/lib/team-auth";
import { createAppForTeam } from "@/lib/app-settings";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import { parseExtensionLink } from "@/lib/extension-target";
import { extensionOptionsFromForm } from "@/lib/validation";
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
//
// CHE-315: the rules themselves are in src/lib/app-settings.ts, shared with the
// MCP create_app tool. This action reads its form, and keeps the one rule that
// belongs to this page alone (CHE-320's flag, below).
export type CreateAppResult = { error: string } | null;

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// useActionState signature (prevState, formData): the form works as a plain
// HTML POST before hydration, so an early click is never swallowed (CHE-73/75
// class — the same bug we fixed on the verdict page).
export async function createApp(
  _prevState: CreateAppResult,
  formData: FormData,
): Promise<CreateAppResult> {
  const { user, db, team } = await requireActionScope("app.settings.write");

  const targetUrl = String(formData.get("targetUrl") ?? "");
  // CHE-320: the form hides extension mode when the flag is off, but a pasted
  // Web Store link would still become an extension here, since the kind is
  // read from the link. Same flag, same answer as the page. (The MCP path is
  // deliberately not gated — the owner's own agent adds extensions through it.)
  const isExtension = Boolean(parseExtensionLink(targetUrl));
  if (isExtension && !(await extensionCheckFor(user))) {
    return { error: "Chrome Web Store links can't be added here yet. Enter your app's own URL." };
  }

  const result = await createAppForTeam(
    db,
    { userId: user.id, teamId: team.id, plan: team.plan as UserPlan },
    {
      targetUrl,
      expectExtension: formData.get("targetKind") === "extension",
      extension: extensionOptionsFromForm(formData),
      testEmail: String(formData.get("testEmail") ?? ""),
      testPassword: String(formData.get("testPassword") ?? ""),
      focusAreas: String(formData.get("focusAreas") ?? ""),
      writeMode: formData.get("writeMode") === "create_cleanup" ? "create_cleanup" : "read_only",
      scopeHints: String(formData.get("scopeHints") ?? ""),
      userNotes: String(formData.get("userNotes") ?? ""),
      notifyEmail: String(formData.get("notifyEmail") ?? ""),
      frequency: String(formData.get("frequency") ?? "daily") as WatchFrequency,
      pickupLabels: list(formData.get("pickupLabels")),
      repoLabel: String(formData.get("repoLabel") ?? ""),
      urgentJourneys: list(formData.get("urgentJourneys")),
    },
  );
  if ("error" in result) return { error: result.error };

  const { appSlug } = result.app;
  redirect(`/home?${result.app.isExtension ? "extensionAdded" : "added"}=${encodeURIComponent(appSlug)}`);
}
