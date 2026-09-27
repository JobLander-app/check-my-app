import { A, Bullets, Code, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("multiple-accounts");

// What exists today, verified in code — change this page when any of it moves:
// - the app's main login is App.testEmail / App.testPasswordEnc, the account
//   labelled "default"; named accounts are TestAccount rows (CHE-322,
//   prisma/schema.prisma; the design is at the top of src/lib/test-accounts.ts)
// - up to MAX_EXTRA_ACCOUNTS (10) named accounts per app; labels are lower-cased
//   letters, digits, spaces, "_", "." and "-" (normalizeAccountLabel)
// - added, renamed, re-passworded and removed in Dashboard → app → "More test
//   accounts" (src/app/dashboard/[appId]/page.tsx, one Save with the rest), and
//   from a coding agent: create_app / update_app `test_accounts`,
//   `remove_test_accounts`; list_apps returns label + email, never a password
//   (src/lib/mcp/tools.ts)
// - encrypted like the main password (encryptSecret), write-only in settings
// - every run of the app carries them (Run.testAccounts: startSavedApp,
//   scheduler.ts for Daily Watch, recheck.ts); the model is told the LABELS and
//   signs in with {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}}, filled
//   server-side (src/agent/instructions.ts credentialsBlock, tools.ts fill)
// - "which account" comes from the scenario's own words — "As admin: …"; a
//   scenario naming no account uses the main login
// - a rejected password stops that account only and the verdict names it
//   (Run.rejectedAccounts; src/agent/credentials.ts, synthesis.ts)
// - a single check from the home page carries one login, as before
//   (createCheckSchema testEmail / testPassword → Run.testPasswordEnc)
// - extensions sign in with one account (EXTENSION_ONE_ACCOUNT,
//   src/lib/app-settings.ts)
export default function MultipleAccountsGuide() {
  return (
    <GuidePage
      slug="multiple-accounts"
      headline={
        <>
          Several accounts <span className="text-accent">and roles</span>.
        </>
      }
      lead="An admin sees different screens from a regular user; a paid plan unlocks what a free one cannot. Give one app a test account for each, and every check signs in as the one each scenario needs."
    >
      <Section title="What an app holds">
        <p>
          Every app has its <Strong>main test login</Strong> — the one on the “Test login” card —
          and up to ten <Strong>named test accounts</Strong> next to it: “admin”, “free user”,
          “team member”, whatever your product calls its kinds of user. Each has its own email
          and password, kept exactly like the main one: encrypted, never shown back, typed only
          into your app’s own pages.
        </p>
      </Section>

      <Section title="Adding them">
        <Bullets
          items={[
            <>
              <Strong>In the dashboard</Strong> — your app → “More test accounts”. Type a name,
              an email and a password on the empty row and press Save settings. Rename an account
              or change its email in place; leave its password empty to keep the current one;
              tick Remove to delete it.
            </>,
            <>
              <Strong>From your coding agent</Strong> — <Code>create_app</Code> and{" "}
              <Code>update_app</Code> take{" "}
              <Code>{`test_accounts: [{label, email, password}]`}</Code>, and{" "}
              <Code>remove_test_accounts</Code> deletes by name. <Code>list_apps</Code> shows
              every account’s name and email, never a password. See{" "}
              <A href="/guides/connect-your-agent">Connect your coding agent</A>.
            </>,
          ]}
        />
      </Section>

      <Section title="Saying which account a scenario runs as">
        <p>
          Name the account at the start of the scenario, in “What worries you most?”:
        </p>
        <Bullets
          items={[
            <>
              <Code>As admin: refunds go through and show up in the order history.</Code>
            </>,
            <>
              <Code>As free user: the Export button offers an upgrade instead of exporting.</Code>
            </>,
            <>
              <Code>Checkout must never break.</Code> — names no account, so it runs as the main
              test login.
            </>,
          ]}
        />
        <p>
          Every check of the app — the ones you start and the daily ones — has all of its
          accounts and signs in as the one each scenario names. A scenario that names an account
          the app does not have is reported as not checked rather than guessed at.
        </p>
      </Section>

      <Section title="When one account’s password stops working">
        <p>
          The same rule as for the main login, per account: that account is tried once, nothing
          behind it is called broken, and the result names <Strong>which</Strong> account’s
          sign-in details need replacing. The other accounts keep being checked in the same run.
        </p>
      </Section>

      <Note label="good to know">
        <p>
          A single check from the <A href="/">home page</A> carries one login, the one you type
          under “Add login &amp; notes”. A role on its own address, such as{" "}
          <Code>admin.example.com</Code>, is its own app with its own accounts. A Chrome extension
          signs in with its one test login.
        </p>
      </Note>
    </GuidePage>
  );
}
