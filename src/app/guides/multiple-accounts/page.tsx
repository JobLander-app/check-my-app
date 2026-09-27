import { A, Bullets, Code, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("multiple-accounts");

// What exists today, verified in code — change this page when any of it moves:
// - one test account per app: App.testEmail / App.testPasswordEnc
//   (prisma/schema.prisma, model App)
// - one app per person per host: @@unique([ownerId, appSlug]); appSlug is the
//   host without www (appSlugFromUrl, src/lib/utils.ts); a second add is
//   refused "You already have this app" (src/app/onboarding/actions.ts)
// - a single check carries its own login: createCheckSchema testEmail /
//   testPassword (src/lib/validation.ts) → Run.testPasswordEnc
//   (src/lib/start-check.ts); the run signs in with the run's own credentials
//   (src/agent/discovery.ts, execution.ts decrypt run.testPasswordEnc), and a
//   signed-in owner's check of an app they own is recorded on that app
//   (start-check.ts, CHE-234); the password is dropped when it finishes
//   (src/agent/workflow.ts "cleanup")
// - several named accounts per app is planned (CHE-322) — not promised a date.
export default function MultipleAccountsGuide() {
  return (
    <GuidePage
      slug="multiple-accounts"
      headline={
        <>
          Several accounts <span className="text-accent">and roles</span>.
        </>
      }
      lead="An admin sees different screens from a regular user; a paid plan unlocks what a free one cannot. Here is what works today for checking more than one of them, and what is coming."
    >
      <Section title="What an app holds today">
        <p>
          Each app in CheckMyApp has <Strong>one test account</Strong>, and Daily Watch signs in
          as that account every day. An app is identified by its address — the host, like{" "}
          <Code>app.example.com</Code> — so the same address cannot be added twice to your
          dashboard.
        </p>
      </Section>

      <Section title="The setup that works now">
        <Bullets
          items={[
            <>
              <Strong>Watch the role that matters most.</Strong> Put the account your users most
              depend on — usually a regular signed-in user — on the app. That is the one checked
              every day.
            </>,
            <>
              <Strong>Check other roles with a single check.</Strong> Signed in, open the{" "}
              <A href="/">home page</A>, paste the same address, and under “Add login &amp;
              notes” enter the other account — an admin, a free-plan user. That check signs in as
              the account you typed, is recorded on the same app, and the password is deleted
              when it finishes. It counts as a check on your plan.
            </>,
            <>
              <Strong>A role on its own address is its own app.</Strong> If your admin area lives
              on a separate host, such as <Code>admin.example.com</Code>, add it as a second app
              with its own test account and its own Daily Watch.
            </>,
          ]}
        />
        <p>
          In the notes of a single check, say which role it is — “signed in as an admin; the
          Billing and Members pages should be visible” — so the check knows what that role is
          meant to see.
        </p>
      </Section>

      <Note label="coming">
        <p>
          Several named accounts on one app — “admin”, “free user”, “team member” — with each
          scenario saying which account it runs as, every one of them watched daily, managed from
          the dashboard and from your coding agent.
        </p>
      </Note>
    </GuidePage>
  );
}
