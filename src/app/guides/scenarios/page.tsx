import { A, Bullets, Code, Example, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("scenarios");

// The three fields and what they do — keep in step with the code:
// - "What worries you most?" = App.focusAreas / Run.focusAreas (CHE-81):
//   focusBlock() in src/agent/instructions.ts (verify each concern every run,
//   report the outcome either way, call out what could not be verified);
//   orderByFocus in src/agent/workflow.ts; ownerConcerns in synthesis.ts.
// - Scope = scopeHints, notes = userNotes: clientInstructionBlock() in
//   src/agent/instructions.ts ("authoritative", override defaults).
// - Where they are entered: src/components/onboarding-wizard.tsx,
//   src/app/dashboard/[appId]/page.tsx; the home form has notes only
//   (src/components/submit-form.tsx).
// - Stored as plain text (not encrypted): App.scopeHints/userNotes/focusAreas.
// - Signup is walked to the final submit and not completed; payments, invites,
//   messages are never made: instructions.ts credentialsBlock, onboarding copy.
// - The agent path, checked against the merged CHE-315 tools (#184): MCP
//   `scenarios` is App.focusAreas ("What worries you most?"), `limits` is
//   scopeHints (Scope), `notes` is userNotes.
export default function ScenariosGuide() {
  return (
    <GuidePage
      slug="scenarios"
      headline={
        <>
          Your own <span className="text-accent">scenarios</span>.
        </>
      }
      lead="Without instructions, CheckMyApp finds your app’s main journeys by itself. Scenarios tell it what matters most to you — and it checks each one on every run and answers it in the verdict, whether it works or not."
    >
      <Section title="Three fields, three jobs">
        <Bullets
          items={[
            <>
              <Strong>What worries you most?</Strong> — your scenarios. What must work, in your
              own words. Each one is checked on every run and answered in the verdict’s bottom
              line — working or not. One that could not be reached this run is named as such,
              never silently skipped.
            </>,
            <>
              <Strong>Scope</Strong> — hard limits. Where CheckMyApp must not go and what it must
              not press. Followed to the letter.
            </>,
            <>
              <Strong>Notes</Strong> — context. What is expected, what is intentional, what is
              fine to do.
            </>,
          ]}
        />
      </Section>

      <Section title="Where to write them">
        <Bullets
          items={[
            <>
              <Strong>When you add your app</Strong> — “What worries you most?” and “Scope &amp;
              notes” on the form.
            </>,
            <>
              <Strong>In the app’s settings</Strong> — Dashboard → your app → “What we check”.
              Changes apply from the next check.
            </>,
            <>
              <Strong>From your coding agent</Strong> — tell it the scenarios when it adds the
              app, or ask it to update them later (<Code>create_app</Code>,{" "}
              <Code>update_app</Code>). See{" "}
              <A href="/guides/connect-your-agent">Connect your coding agent</A>.
            </>,
            <>
              <Strong>For a single check</Strong> — the <A href="/">home page</A> takes notes
              under “Add login &amp; notes”. Scenarios that should be checked every day belong on
              the app.
            </>,
          ]}
        />
      </Section>

      <Section title="What a good scenario looks like">
        <p>
          Write it the way you would brief a new colleague: <Strong>what a user does</Strong>{" "}
          and <Strong>what they should see</Strong>. One scenario per line. Concrete beats broad —
          “the app works” cannot fail; “a saved invoice shows up in the list” can.
        </p>
        <Example>
          Signed in, I can create a project, see it in the project list, rename it and delete it.
        </Example>
        <Example>
          Choosing the Pro plan on /pricing shows $29/month and reaches the payment form.
        </Example>
        <Example>Every YouTube link on the course pages plays.</Example>
        <Example>
          Searching for “invoice” returns results, and each result opens its invoice.
        </Example>
        <p>
          The first example creates and deletes a record, so it needs a{" "}
          <A href="/guides/login-and-test-accounts">test account</A> and “May we create test
          records?” switched on. Without that permission, CheckMyApp checks that the form is
          there and accepts input, and stops before saving.
        </p>
      </Section>

      <Section title="Scope and notes, by example">
        <p>Scope — the limits:</p>
        <Example>Don’t touch /admin. Never press “Delete account” or “Cancel subscription”.</Example>
        <p>Notes — the context:</p>
        <Example>
          The test account is on the free plan, so upgrade prompts are expected. Empty charts on
          a brand-new project are intentional.
        </Example>
      </Section>

      <Note label="what is never done, whatever you write">
        <p>
          A new account is taken up to the final “Sign up” press and not created. No payment is
          made, no one is invited or messaged, nothing is published. A scenario that needs one of
          those is checked up to that point.
        </p>
        <p>
          Keep passwords out of these fields — they are stored as written. Credentials go in the{" "}
          <A href="/guides/login-and-test-accounts">test login</A>, which is encrypted.
        </p>
      </Note>
    </GuidePage>
  );
}
