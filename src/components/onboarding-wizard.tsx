"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createApp } from "@/app/onboarding/actions";
import { ExtensionFields } from "./extension-fields";
import { parseExtensionLink, type ExtensionOptions } from "@/lib/extension-target";

// Owner onboarding. One sectioned form (resumable multi-step is a later refinement)
// that captures everything the agent needs for recurring QA + the ticket contract,
// then persists an App + Watch + TicketPolicy via the createApp server action.
export function OnboardingWizard({
  prefillUrl,
  initialKind = "website",
  extensionCheck = false,
  mayStoreLogin = true,
}: {
  prefillUrl: string;
  initialKind?: "website" | "extension";
  /** PostHog flag `home-extension-check`, evaluated by the page (CHE-320). Off: no toggle, no extension mode. */
  extensionCheck?: boolean;
  /** `app.credentials.write` (CHE-417): a login is an admin's to store. A member sees why, not fields that would refuse them. */
  mayStoreLogin?: boolean;
}) {
  const [url, setUrl] = useState(prefillUrl);
  const [kind, setKind] = useState(initialKind);
  const [extension, setExtension] = useState<ExtensionOptions>({});
  const isExtension = extensionCheck && (kind === "extension" || Boolean(parseExtensionLink(url)));
  const [showPassword, setShowPassword] = useState(false);
  // CHE-84: refusals come back as state instead of a thrown 500, and the action
  // is passed to <form> directly so a click that lands before hydration still
  // submits (progressive enhancement).
  const [state, formAction] = useActionState(createApp, null);

  return (
    <form action={formAction} className="space-y-8">
      <input type="hidden" name="targetKind" value={isExtension ? "extension" : "website"} />
      <div className="space-y-2">
        <p className="section-label">{isExtension ? "check your extension" : "set up daily QA"}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{isExtension ? "Add your extension" : "Add your app"}</h1>
        <p className="text-sm text-fg-muted">
          {isExtension ? "Save your extension, then run a check whenever you need one." : "We'll check it every day and file one ticket per new regression into your tracker."}
        </p>
        <p className="text-xs text-fg-faint">
          {isExtension ? "Start with its Chrome Web Store link. Add a test login to reach the full product." : "6 quick sections — only the site URL is required. Everything else is optional or has a sensible default."}
        </p>
      </div>

      {/* 1 — Site */}
      <section className="card space-y-3 p-5">
        {extensionCheck && <div className="flex gap-1 font-mono text-xs">
          {(["website", "extension"] as const).map(value => <button key={value} type="button"
            aria-pressed={value === (isExtension ? "extension" : "website")} onClick={() => setKind(value)}
            className={`rounded-md px-3 py-2 ${value === (isExtension ? "extension" : "website") ? "bg-accent/10 text-accent" : "text-fg-muted hover:text-fg"}`}>
            {value === "extension" ? "Chrome extension" : "Website"}
          </button>)}
        </div>}
        <Input
          name="targetUrl"
          type="text"
          inputMode="url"
          aria-label={isExtension ? "Chrome Web Store link" : "App URL"}
          placeholder={isExtension ? "https://chromewebstore.google.com/detail/…" : "https://your-app.com"}
          value={url}
          onChange={e => setUrl(e.target.value)}
          required
        />
      </section>

      {isExtension && <ExtensionFields value={extension} onChange={setExtension} />}

      {/* 2 — Test login */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          2 · Test login <span className="font-normal text-fg-faint">(recommended)</span>
        </p>
        {!mayStoreLogin ? (
          <p className="text-sm text-fg-muted">Test logins are set by an admin of the team — add the app now, and an admin adds the login on its Test accounts page.</p>
        ) : (<>
        <Input name="testEmail" type="email" placeholder="test@your-app.com" autoComplete="off" />
        <div className="relative">
          <Input
            name="testPassword"
            type={showPassword ? "text" : "password"}
            placeholder="••••••••"
            autoComplete="new-password"
            className="pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-fg-faint transition-colors hover:text-fg"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        <p className="text-xs text-fg-faint">
          Encrypted at rest, never logged, never in evidence. Google-OAuth logins aren&apos;t
          auto-walkable yet — use an email/password test user.
        </p>
        </>)}
      </section>

      {/* 3 — Tracker (Linear) */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">3 · Connect your tracker</p>
        <p className="text-xs text-fg-faint">
          After you save, connect Linear from your dashboard (one-click OAuth) — we&apos;ll file
          tickets into the team you authorize. The ticket parameters below take effect once that
          connection is live; set them now so your self-healing automation picks the tickets up.
        </p>
      </section>

      {/* 4 — Ticket parameters */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          4 · Ticket parameters{" "}
          <span className="font-normal text-fg-faint">(applied after you connect)</span>
        </p>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
          <Input name="pickupLabels" placeholder="monitor" defaultValue="monitor" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Repo label</span>
          <Input name="repoLabel" placeholder="repo: your-app" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">
            Critical journeys → Urgent (comma-separated)
          </span>
          <Input name="urgentJourneys" placeholder="login, dashboard, checkout" />
        </label>
        <p className="text-xs text-fg-faint">
          These are the labels that make <em>your</em> automation pick up the ticket. We never guess
          them.
        </p>
      </section>

      {/* 4b — Permission to create (CHE-91). An explicit, informed choice at
          onboarding: creation happens only as the test account above, and every
          created record is deleted again. */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          May we create test records? <span className="font-normal text-fg-faint">(optional)</span>
        </p>
        <p className="text-xs text-fg-muted">
          Most products&apos; core action is creating something. With permission we check the full
          lifecycle — create it, see it appear, edit it, then delete it — signed in as the test
          account above, inside that account&apos;s own space only. Everything we create is named
          &ldquo;CheckMyApp test&rdquo; and removed again; if anything is ever left behind we tell
          you exactly where it is. We never invite people, publish, message anyone or spend money.
        </p>
        <label className="flex items-start gap-2.5 text-sm text-fg">
          <input
            type="checkbox"
            name="writeMode"
            value="create_cleanup"
            className="mt-0.5 h-4 w-4 rounded border-ink-600 bg-ink-900"
          />
          <span>
            Yes — create and clean up test records as my test account
            <span className="block text-xs text-fg-faint">
              Requires the test login above. Without it we stay read-only.
            </span>
          </span>
        </label>
      </section>

      {/* 5a — Priority concerns (CHE-81): the owner's own words, first-class. */}
      <section className="rounded-xl border border-accent/40 bg-accent/5 p-5">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-fg">What worries you most?</span>
          <span className="block text-xs text-fg-muted">
            In your own words — we verify each of these on every run and answer them in the
            verdict. e.g. &ldquo;All YouTube links must actually play&rdquo;.
          </span>
          <Textarea
            name="focusAreas"
            rows={3}
            placeholder="All YouTube links and embeds must play. Checkout must never break."
          />
        </label>
      </section>

      {/* 5 — Scope & notes */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          5 · Scope &amp; notes <span className="font-normal text-fg-faint">(optional)</span>
        </p>
        <Input name="scopeHints" placeholder="Don't touch /admin" />
        <Input name="userNotes" placeholder="Don't delete the test account. OK to create sessions." />
      </section>

      {/* 6 — Cadence. Who hears about a verdict is the team's own list, in the app's settings (CHE-262). */}
      {!isExtension && <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">6 · Cadence</p>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Frequency</span>
          <select
            name="frequency"
            defaultValue="daily"
            className="w-full rounded-md border border-ink-700 bg-transparent px-3 py-2 font-mono text-sm text-fg outline-none"
          >
            <option value="daily">Daily</option>
            <option value="every_6h">Every 6 hours</option>
            <option value="manual">Manual only</option>
          </select>
        </label>
        <p className="text-xs text-fg-faint">Every verdict goes to your team. Who exactly is set in the app&apos;s settings once it is added.</p>
      </section>}

      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-status-broken/40 bg-status-broken/10 px-3 py-2 text-sm text-status-broken"
        >
          {state.error}
        </p>
      )}
      <SubmitButton isExtension={isExtension} />
    </form>
  );
}

function EyeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.1 9.1 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

function SubmitButton({ isExtension }: { isExtension: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full py-3.5 text-[15px]">
      {pending ? "Saving…" : isExtension ? "Add extension" : "Save & start watching"}
    </Button>
  );
}
