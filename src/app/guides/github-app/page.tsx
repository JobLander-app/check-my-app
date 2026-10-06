import { A, Bullets, Code, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("github-app");

// CHE-369. Owner, 2026-10-06: «у меня ощущение, что мы за владельца что-то
// настроили, что он не просил… хочу понимать step by step» — every step here
// is what the code does (src/lib/github-app.ts, src/lib/github-webhook.ts,
// src/lib/github-mapping.ts), and nothing is checked until step 3.
//
// - the App's permissions: registered 2026-10-05 (CHE-369 comment), app id
//   5203150 — deployments read, checks write, pull requests write, contents
//   read, metadata read; the one event it listens to is deployment_status.
// - "production": GitHubRepo.productionEnvs, default "production,Production",
//   matched case-insensitively (isProductionEnv).
// - which hosts report deployments: Vercel's GitHub integration does (checked
//   on the owner's repos, 2026-10-06); Cloudflare Workers Builds does not.
// - conclusions: conclusionFor — broken fails, all good passes, otherwise
//   neutral; a check that did not finish is neutral and charges nothing.
export default function GitHubAppGuide() {
  return (
    <GuidePage
      slug="github-app"
      headline={
        <>
          The <span className="text-accent">GitHub App</span>, step by step.
        </>
      }
      lead="Install it once for your team, then choose — app by app — which repository it is deployed from. Until you make that choice, nothing is checked and nothing is charged."
    >
      <Section title="1. Install the App">
        <p>
          On <A href="/settings/integrations">Settings → Integrations</A>, an admin of the team presses{" "}
          <Strong>Install</Strong> on the GitHub App card. GitHub opens and asks two things: which
          account (you or an organisation), and which repositories — all of them, or only the ones you
          select. Press <Strong>Install</Strong> there.
        </p>
        <p>
          GitHub sends you back to Integrations. The card now shows the account and how many
          repositories the App can see. That is all installing does: no check starts, nothing is
          linked to any app.
        </p>
        <p>What the App may do in your repositories, and why:</p>
        <Bullets
          items={[
            <>
              <Strong>Read deployments</Strong> — to hear that a deploy finished.
            </>,
            <>
              <Strong>Write checks</Strong> — to put the result on the commit you deployed.
            </>,
            <>
              <Strong>Read contents and write pull requests</Strong> — not used today.
            </>,
          ]}
        />
      </Section>

      <Section title="2. Choose the repository of an app">
        <p>
          Open the app, then <Strong>Settings → Integrations → GitHub repository</Strong>. Pick the
          repository this app is deployed from and when its deploys are checked:{" "}
          <Strong>Production deploys</Strong> or <Strong>Off</Strong>. Press <Strong>Save</Strong>.
        </p>
        <p>
          One repository per app. The line under the choice says what will happen and what a check of
          this app usually costs. This is the step that turns checks on; before it, deploys start
          nothing.
        </p>
      </Section>

      <Section title="3. What happens on a deploy">
        <Bullets
          items={[
            <>
              Your host finishes a deploy and reports it to GitHub as a deployment. Vercel does this
              by itself. A deployment to an environment named <Code>production</Code> (any case)
              counts; previews do not.
            </>,
            <>
              CheckMyApp starts a check of the app linked to that repository, for that commit. On the
              commit, a check named <Strong>CheckMyApp</Strong> appears as running.
            </>,
            <>
              When the check ends, it shows the verdict, the number of problems and the price — for
              example “Needs attention · 1 finding · $0.61” — with a link to the full result. A broken
              app marks the commit as failed, a clean one as passed; anything in between is neutral, so
              it never blocks your merge on its own.
            </>,
            <>
              One check of an app runs at a time. A deploy that lands while one is still running gets
              “Not checked” on its commit, with the reason.
            </>,
            <>
              If a check does not finish on our side, the commit says so and nothing is charged.
            </>,
          ]}
        />
      </Section>

      <Section title="4. What it costs">
        <p>
          Each check is paid from your balance like any other: the app&apos;s usual price is shown in the
          line under its repository. A busy week of deploys is that price times the number of production deploys. Plans
          are on <A href="/pricing">Pricing</A>.
        </p>
      </Section>

      <Section title="5. How to stop it">
        <Bullets
          items={[
            <>
              For one app: set its GitHub repository to <Strong>Off</Strong>, or choose{" "}
              <Strong>None</Strong>, and Save.
            </>,
            <>For everything: suspend or uninstall the App in your GitHub settings. A suspended App starts nothing.</>,
          ]}
        />
      </Section>

      <Note label="your host does not report deployments?">
        <p>
          Some hosts (Cloudflare Workers Builds, for one) post their own status on the commit but do not
          create GitHub deployments, so the App never hears about the deploy. Use{" "}
          <A href="/guides/check-every-release">one step in your workflow</A> instead.
        </p>
      </Note>
    </GuidePage>
  );
}
