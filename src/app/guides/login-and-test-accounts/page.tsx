import { A, Bullets, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("login-and-test-accounts");

// Every claim here is backed by code; keep them in step:
// - one test email + password per app: App.testEmail / App.testPasswordEnc
//   (prisma/schema.prisma, model App)
// - encrypted at rest, AES-256-GCM: src/lib/crypto.ts encryptSecret; saved via
//   src/app/onboarding/actions.ts and src/app/dashboard/actions.ts
// - the password never reaches the model, transcripts or evidence: placeholders
//   substituted server-side and scrubSecrets() (src/agent/tools.ts)
// - typed only on the app's own origin: fill() refuses off-origin pages
//   (src/agent/tools.ts, "Never type real credentials into an off-origin form")
// - write-only in settings: src/app/dashboard/[appId]/page.tsx (no defaultValue
//   on the password field; blank keeps the current one, dashboard/actions.ts)
// - a one-off check drops the password when it finishes; a watched app keeps
//   it: src/agent/workflow.ts "cleanup" step, Run.testPasswordEnc comment
// - a rejected password is tried once, then the signed-in part is marked as
//   access and the bottom line asks for new details (CHE-100):
//   src/agent/credentials.ts, src/agent/tools.ts, src/agent/synthesis.ts
// - email/password only, no Google sign-in yet: onboarding + settings copy
export default function LoginGuide() {
  return (
    <GuidePage
      slug="login-and-test-accounts"
      headline={
        <>
          Checking pages <span className="text-accent">behind a login</span>.
        </>
      }
      lead="Most of what your users pay for is behind the sign-in. Give CheckMyApp a test account and it signs in the way a person does, then checks the signed-in part of your app on every run."
    >
      <Section title="What you need">
        <p>
          A real account on your app, made for this: an <Strong>email and a password</Strong>{" "}
          that sign in through your normal login form. Give it the data a typical user would have
          — a project or two, a few records — so there is something to open, search and edit.
        </p>
        <p>
          Sign-in with Google or another provider is not supported yet; use an email-and-password
          account. Each app holds one test account today — for more than one role, see{" "}
          <A href="/guides/multiple-accounts">Several accounts and roles</A>.
        </p>
      </Section>

      <Section title="Where to enter it">
        <Bullets
          items={[
            <>
              <Strong>When you add your app</Strong> — the “Test login” section of the form.
            </>,
            <>
              <Strong>Later, in the app’s settings</Strong> — Dashboard → your app → “Test login”.
              Change the email or type a new password and press Save; leave the password empty to
              keep the current one.
            </>,
            <>
              <Strong>For a single check</Strong> — on the <A href="/">home page</A>, open “Add
              login &amp; notes” before you press the button.
            </>,
            <>
              <Strong>From your coding agent</Strong> — ask it to add the app with a test account;
              see <A href="/guides/connect-your-agent">Connect your coding agent</A>.
            </>,
          ]}
        />
      </Section>

      <Section title="How the password is kept">
        <Bullets
          items={[
            <>
              <Strong>Encrypted before it is stored</Strong> (AES-256-GCM), and decrypted only
              while a check of your app is running.
            </>,
            <>
              <Strong>Never written to logs, never in evidence.</Strong> The step descriptions and
              network records on your verdict page never contain it — if your app echoes it back,
              it is blanked out before anything is saved.
            </>,
            <>
              <Strong>Never shown back to you.</Strong> The settings page shows which email is on
              file; the password field is always empty. Replacing it is the only thing you can do
              with it.
            </>,
            <>
              <Strong>Typed only into your app’s own pages.</Strong> If a page on another address
              asks for it, it is refused.
            </>,
            <>
              <Strong>Kept only as long as it is needed.</Strong> For a single check, the
              password is deleted when the check finishes. For an app on Daily Watch it stays
              stored, encrypted, so tomorrow’s check can sign in too — until you replace it or
              delete the app.
            </>,
          ]}
        />
      </Section>

      <Section title="When the password stops working">
        <p>
          Passwords get rotated and test accounts get reset. When your sign-in turns the stored
          details away, CheckMyApp stops right there:
        </p>
        <Bullets
          items={[
            <>
              <Strong>It tries once.</Strong> It does not retry within the run — repeated failed
              sign-ins can lock an account.
            </>,
            <>
              <Strong>It is not reported as your bug.</Strong> A login that refuses a wrong
              password is working correctly. Nothing behind the login is described as broken.
            </>,
            <>
              <Strong>You are told plainly.</Strong> The verdict says the signed-in part could not
              be checked because the sign-in details on file no longer work, and asks for new
              ones. Everything a signed-out visitor can reach is still checked.
            </>,
          ]}
        />
        <p>
          Put the new password into the app’s settings and the next check signs in again.
        </p>
      </Section>

      <Note label="good to know">
        <p>
          Nothing is created in your app unless you allow it. With “May we create test records?”
          switched on, CheckMyApp creates, edits and deletes records as the test account, inside
          that account’s own space, names each one “CheckMyApp test” and removes it again. It
          never invites people, publishes, messages anyone or spends money.
        </p>
        <p>
          Put passwords only in the test-login fields. Notes and scenarios are stored as you
          write them, not encrypted.
        </p>
      </Note>
    </GuidePage>
  );
}
