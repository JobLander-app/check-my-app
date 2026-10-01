import { ConnectAgent, FirstPrompt } from "@/components/connect-agent";
import { TrackedLink } from "@/components/track";

// The first onboarding screen (CHE-324): two ways in, the coding agent first.
//
// The agent is the interface (CHE-313), so the page says "this is the last
// time you need to be here" before the person starts filling in a form — the
// same panel, and the same words, the dashboard shows (CHE-317). Under it,
// the first thing to tell the agent, and a way to the dashboard without an
// app: adding the app is the agent's job now. The form is one link away,
// unchanged, for whoever would rather do it here.
//
// Separate from the page so scripts/verify-onboarding-agent-path.ts can
// render exactly what a person sees without Clerk or a D1.
export function OnboardingChooser({
  keys,
  url,
}: {
  keys: { lastUsedAt: string | null }[];
  /** ?url= from a verdict — goes into the first prompt and on to the form. */
  url: string | null;
}) {
  const manual = url ? `/onboarding?path=app&url=${encodeURIComponent(url)}` : "/onboarding?path=app";
  return (
    <>
      <h1 className="sr-only">Get started</h1>
      <ConnectAgent keys={keys}>
        <FirstPrompt url={url} />
        <TrackedLink
          event="onboarding_path_chosen"
          props={{ path: "agent" }}
          href="/home"
          className="mt-5 inline-flex items-center justify-center rounded-lg border border-ink-600 bg-ink-850 px-4 py-2.5 text-sm text-fg transition-colors hover:border-ink-700 hover:bg-ink-800"
        >
          Done — go to your apps
        </TrackedLink>
      </ConnectAgent>

      <section className="card p-5">
        <p className="section-label">or</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">Add an app here</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Its address, a test login and what must keep working — one form, and the first check
          starts when you save.
        </p>
        <TrackedLink
          event="onboarding_path_chosen"
          props={{ path: "app" }}
          href={manual}
          className="mt-3 inline-block text-sm text-accent hover:underline"
        >
          Open the form →
        </TrackedLink>
      </section>
    </>
  );
}
