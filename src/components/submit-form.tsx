"use client";

import { ExtensionFields } from "./extension-fields";
import { parseExtensionLink, isChromeStoreUrl, type ExtensionOptions } from "@/lib/extension-target";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VERDICT_META } from "@/lib/status";
import { appSlugFromUrl } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { FORM_NOTE } from "@/lib/home-copy";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

// The server's rejection codes worth telling apart in analytics; anything
// else (a 400, a 403 from Turnstile, a 5xx) is "other".
const REJECTION_CODES = new Set(["quota_site", "quota_anon", "quota_free"]);
function rejectionCode(code: string | undefined): string {
  return code && REJECTION_CODES.has(code) ? code : "other";
}

// What a refused input was. Two strangers in a month pressed the button and
// were refused with `invalid_url` (2026-09-10, 2026-09-11); the event
// carried nothing to tell whether they had typed nothing, a name without a
// dot, or a store link we could not parse, and session replay was off. The
// text itself goes along now (it is the URL of an app, public the moment a
// check is accepted), except when it carries an "@".
function describeInput(raw: string, extensionMode: boolean) {
  const text = raw.trim();
  let inputHost = "";
  try {
    inputHost = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname;
  } catch {
    inputHost = "";
  }
  return {
    ...(text.includes("@") ? {} : { inputText: text.slice(0, 200) }),
    inputLength: text.length,
    inputHasScheme: /^https?:\/\//i.test(text),
    inputHasDot: text.includes("."),
    inputHasSpace: /\s/.test(text),
    inputHost,
    extensionMode,
  };
}

// Domain-keyed result cache hit (CHE-39) — latest completed run for this domain.
type LookupHit = {
  appSlug: string;
  count: number;
  run: {
    publicId: string;
    runNumber: number;
    verdict: string | null;
    bottomLine: string | null;
    completedAt: string | null;
  };
  watched: boolean;
  ageDays: number | null;
  stale: boolean;
};

// Screen 1 — Submit. One field, one button; credentials/notes hidden behind a
// single toggle so casual visitors aren't scared off. The headline above the
// field belongs to the page (src/app/page.tsx, CHE-421); the form starts at
// the field.
//
// `extensionCheck` is the PostHog flag `home-extension-check`, evaluated by
// the page on the server (CHE-320): off for the public, on for the owner and
// test accounts. Off means no way into extension mode at all — no toggle, and
// a pasted Web Store link (typed or arriving as ?url=) does not switch the
// form over; it is refused in plain words instead of being sent as a website.
export function SubmitForm({ initialUrl = "", extensionCheck = false }: { initialUrl?: string; extensionCheck?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [extension, setExtension] = useState<ExtensionOptions>({});
  const [selectedKind, setSelectedKind] = useState<"website" | "extension">("website");
  const isExtension = extensionCheck && (Boolean(parseExtensionLink(url)) || selectedKind === "extension");
  // The URL the hit was fetched for rides along so a stale card never renders.
  const [lookupState, setLookupState] = useState<{ forUrl: string; hit: LookupHit } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Set once the visitor submits with no usable URL, so the inline "doesn't
  // look like a working URL" line shows even for an empty field.
  const [attempted, setAttempted] = useState(false);
  // `code` is set for quota rejections (CHE-40) so the copy can offer a way out.
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  // Site-wide free-check counter (owner decision 2026-09-05). null = not
  // fetched or the fetch failed, and then the line simply isn't rendered.
  const [today, setToday] = useState<{ left: number; cap: number } | null>(null);
  // The $1 path once the site cap is hit: POST to /api/billing/one-check with
  // the same submission, follow the checkout URL it returns.
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  // The site-cap panel is the growth plan's own signal: count it when it
  // renders, once per rejection.
  useEffect(() => {
    if (error?.code === "quota_site") track("quota_site_hit");
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/checks/today")
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { left?: unknown; cap?: unknown };
        if (cancelled || typeof body.left !== "number" || typeof body.cap !== "number") return;
        setToday({ left: body.left, cap: body.cap });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Render the Turnstile widget only when a site key is configured (prod).
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = () => {
      const ts = (window as unknown as { turnstile?: { render: (el: HTMLElement, o: object) => void } })
        .turnstile;
      ts?.render(turnstileRef.current as HTMLElement, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setTurnstileToken(token),
      });
    };
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  // Bare domains are fine — we assume https:// (mirrors normalizeTargetUrl on the server).
  const normalizedUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  // A Web Store page is not a website we can check, and without the flag it
  // is not an extension we will check from here either.
  const storeLinkRefused = !extensionCheck && isChromeStoreUrl(normalizedUrl);
  const valid = /^https?:\/\/.+\..+/.test(normalizedUrl) && !storeLinkRefused && (!(isExtension || isChromeStoreUrl(normalizedUrl)) || Boolean(parseExtensionLink(normalizedUrl)));

  // Domain-keyed cache (CHE-39): once the URL looks real, ask if we've already
  // checked this domain and offer the existing verdict instead of a cold start.
  useEffect(() => {
    if (!valid) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/checks/lookup?url=${encodeURIComponent(normalizedUrl)}`);
        const body = (await res.json()) as { found: boolean } & LookupHit;
        setLookupState(body.found ? { forUrl: normalizedUrl, hit: body } : null);
      } catch {
        setLookupState(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedUrl, valid]);

  const lookup = valid && lookupState?.forUrl === normalizedUrl ? lookupState.hit : null;

  // Exactly what the form sent to /api/checks, minus the Turnstile token: the
  // paid endpoint carries the submission through checkout and starts the same
  // run on payment.
  async function payForThisCheck() {
    track("one_check_clicked");
    setPaying(true);
    setPayError(null);
    try {
      const res = await fetch("/api/billing/one-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalizedUrl, extension: isExtension ? extension : undefined, testEmail, testPassword, userNotes, notifyEmail }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (res.status === 503 && body.code === "billing_unconfigured") {
        setPayError("Paid checks open shortly — try again in a few minutes.");
      } else {
        setPayError(body.error ?? "Something went wrong");
      }
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Something went wrong");
    }
    setPaying(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Recorded on the click, before anything can refuse it: the headline A/B
    // measures intent, and the site-wide cap must not depress it. What the
    // server answers is a separate event below.
    track("check_submitted", {
      appSlug: valid ? appSlugFromUrl(normalizedUrl) : "",
      hasCredentials: Boolean(testEmail && testPassword),
      hasNotifyEmail: Boolean(notifyEmail),
    });
    // Validated here, not by disabling the button (issue #7): a button that is
    // disabled in the server-rendered HTML stays dead until React hydrates —
    // the same pre-hydration failure this product flags on other people's
    // apps. The button is live from the first paint; a bad URL gets the
    // inline message instead.
    if (!valid) {
      track("check_rejected", { code: storeLinkRefused ? "extension_unavailable" : "invalid_url", ...describeInput(url, isExtension) });
      setAttempted(true);
      return;
    }
    if (isExtension && extension.allowSessions && (!testEmail.trim() || !testPassword)) {
      setExpanded(true);
      setError({ message: "Add your test email and password to check sessions." });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalizedUrl, extension: isExtension ? extension : undefined, testEmail, testPassword, userNotes, notifyEmail, turnstileToken }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        track("check_rejected", { code: rejectionCode(body.code) });
        setError({ message: body.error ?? "Something went wrong", code: body.code });
        setSubmitting(false);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/run/${id}`);
    } catch (err) {
      track("check_rejected", { code: "other" });
      setError({ message: err instanceof Error ? err.message : "Something went wrong" });
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full space-y-6">
      {extensionCheck && (
        <div className="flex justify-center gap-1 font-mono text-xs" aria-label="Product type">
          {(["website", "extension"] as const).map(kind => (
            <button key={kind} type="button" aria-pressed={kind === (isExtension ? "extension" : "website")}
              onClick={() => setSelectedKind(kind)}
              className={`rounded-md px-4 py-2 transition-colors ${kind === (isExtension ? "extension" : "website") ? "bg-accent/10 text-accent" : "text-fg-muted hover:text-fg"}`}>
              {kind === "extension" ? "Chrome extension" : "Website"}
            </button>
          ))}
        </div>
      )}

      <div className="card p-1.5">
        <div className="flex items-center gap-2">
          <span className="pl-3 font-mono text-sm text-fg-faint">→</span>
          {/* type="text": the browser's own type="url" validation rejects bare domains */}
          <input
            type="text"
            inputMode="url"
            // The one field session replay may show unmasked (src/lib/analytics.ts).
            data-ph-unmask="url"
            placeholder={isExtension ? "Chrome Web Store link" : "https://"}
            aria-label={isExtension ? "Chrome Web Store link" : "App URL"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={url.length > 0 && !valid}
            className="w-full bg-transparent py-3 font-mono text-[15px] text-fg outline-none placeholder:text-fg-faint"
            autoFocus
          />
        </div>
      </div>
      {(url.length > 0 || attempted) && !valid && (
        <p className="-mt-3 text-sm text-status-broken">
          {storeLinkRefused ? <>Chrome Web Store links can&apos;t be checked here yet. Paste your app&apos;s own URL.</> : <>Doesn&apos;t look like a working URL</>}
        </p>
      )}

      {isExtension && <ExtensionFields value={extension} onChange={next => { setExtension(next); if (next.allowSessions) setExpanded(true); }} />}

      {lookup && (
        <div className="card animate-fade-up space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-fg">
              We&apos;ve already checked <span className="font-mono">{lookup.appSlug}</span>
              {lookup.count > 1 ? ` (${lookup.count} runs)` : ""}
            </p>
            {lookup.run.verdict && VERDICT_META[lookup.run.verdict] && (
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-xs ${VERDICT_META[lookup.run.verdict].pillClassName} ${lookup.stale ? "opacity-50" : ""}`}
              >
                {VERDICT_META[lookup.run.verdict].label}
              </span>
            )}
            {lookup.run.completedAt && (
              <span className="font-mono text-xs text-fg-faint">
                {new Date(lookup.run.completedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
            {lookup.watched && (
              <span className="font-mono text-xs text-status-ok">● watched daily</span>
            )}
          </div>
          {lookup.stale ? (
            <p className="text-sm text-status-risky">
              Checked {lookup.ageDays} days ago — this may be out of date. Run a fresh check
              below, or enable Daily Watch so it never goes stale.
            </p>
          ) : (
            lookup.run.bottomLine && (
              <p className="text-sm text-fg-muted">{lookup.run.bottomLine}</p>
            )
          )}
          <a
            href={`/verdict/${lookup.run.publicId}`}
            className="inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
          >
            See the last results →
          </a>
          {!lookup.stale && (
            <p className="font-mono text-xs text-fg-faint">
              …or submit below for a fresh check.
            </p>
          )}
        </div>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
        >
          <span className={`chevron mr-1 inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>
            ›
          </span>
          {isExtension && extension.allowSessions ? "Test login & notes" : "Add login & notes (optional)"}
        </button>
      </div>

      {expanded && (
        <div className="card animate-fade-up space-y-4 p-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">
              Test login{" "}
              <span className="font-normal text-fg-faint">{isExtension && extension.allowSessions ? "(required for sessions)" : "(optional but recommended)"}</span>
            </p>
            {/* ph-no-capture: the customer's test login never rides on an
                analytics event (src/lib/analytics.ts, guardEvent). */}
            <Input
              type="email"
              aria-label="Test email"
              placeholder="test@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              autoComplete="off"
              className="ph-no-capture"
            />
            <Input
              type="password"
              aria-label="Test password"
              placeholder="••••••••"
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
              autoComplete="new-password"
              className="ph-no-capture"
            />
            <p className="text-xs text-fg-faint">
              Encrypted at rest, deleted after the run, never appears in evidence.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">Anything we should know?</p>
            {/* ph-no-capture, like its neighbours: this is free text about the
                customer's own product, and the placeholder invites operational
                detail. None of it belongs in our analytics. */}
            <Input
              placeholder="Don't delete the account, no admin access. OK to create test sessions."
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              className="ph-no-capture"
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">Where to email the result?</p>
            <Input
              type="email"
              placeholder="you@email.com"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              className="ph-no-capture"
            />
          </div>
        </div>
      )}

      {error && error.code === "quota_site" ? (
        <div className="card animate-fade-up space-y-3 p-5">
          <p className="text-[15px] font-semibold tracking-tight text-fg">
            Today&apos;s free checks are used up
          </p>
          <p className="text-sm leading-6 text-fg-muted">{error.message}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={payForThisCheck} disabled={paying} className="px-4 py-2.5 text-sm">
              {paying ? "One moment…" : "Run this one now for $1"}
            </Button>
            <Link
              href="/checks/today"
              className="font-mono text-[13px] text-accent transition-colors hover:underline"
            >
              See today&apos;s checks →
            </Link>
          </div>
          {payError && <p className="text-sm text-status-broken">{payError}</p>}
        </div>
      ) : (
        error && (
          <p className="text-center text-sm text-status-broken">
            {error.message}
            {error.code === "quota_anon" && (
              <>
                {" "}
                <Link
                  href="/sign-in"
                  onClick={() => track("sign_in_clicked", { from: "check" })}
                  className="text-accent transition-colors hover:underline"
                >
                  Sign in →
                </Link>
              </>
            )}
          </p>
        )
      )}

      {TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="flex justify-center" />}

      <Button type="submit" disabled={submitting} className="w-full py-3.5 text-[15px]">
        {submitting ? (
          <>
            <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-ink-950" />
            Spinning up agents…
          </>
        ) : (
          isExtension ? "Check my extension" : "Show me my app"
        )}
      </Button>

      {/* One line, not a wall (CHE-421): the three things a visitor asks after
          deciding to paste a link, and today's counter when it is known. */}
      <p className="text-balance text-center font-mono text-[13px] leading-6 text-fg-faint">
        {FORM_NOTE}
        {today && (
          <>
            {" · "}
            <Link href="/checks/today" className="text-accent transition-colors hover:underline">
              {today.left} of {today.cap} left today
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
