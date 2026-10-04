import { CodeBlock } from "@/components/code-block";
import { ACTION_MARKETPLACE_URL, ACTION_SECRET, ACTION_STEP_YAML, ACTION_USES } from "@/lib/release-action";
import { A, Bullets, Code, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("check-every-release");

// CHE-370. The Action is sorokinvj/checkmyapp-action, on the GitHub Marketplace
// since 2026-10-01; its README is the source of every recipe here, and the
// `uses:` line, the secret's name and the listing come from
// src/lib/release-action.ts — the same constants the agent is told, so the
// site and the agent cannot recommend two different things
// (scripts/verify-mcp-remote.ts compares this page with them).
//
// - inputs (`url`, `app-id`, `preview`, `fail-on`, `sha`) and their defaults:
//   the Action's action.yml at v1.0.0. `fail-on` defaults to `broken`.
// - "15–35 minutes": D1 over 21 days to 2026-10-01, 74 full checks, p50 17 min,
//   max 37 (CHE-368), the same range the Action's README states.
// - the proof that it works end to end: workflow run 36929683304 started run
//   #285 on checkmyapp.dev, bound to the deployed commit.
// - the curl is POST /api/checks with `deploy` (CHE-56); it answers
//   `{ id }`, the public id /verdict/{id} is served under
//   (src/app/api/checks/route.ts).

const DEPLOYMENT_STATUS = `name: Check the release
on: deployment_status

jobs:
  check:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTION_USES}
        with:
          api-key: \${{ secrets.${ACTION_SECRET} }}
          # Production deploys are checked as your app; everything else as a throwaway preview.
          preview: \${{ !startsWith(github.event.deployment_status.environment, 'Production') }}`;

const AFTER_DEPLOY = `jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh

  check:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTION_USES}
        with:
          api-key: \${{ secrets.${ACTION_SECRET} }}
          app-id: cm0yourappid        # the id in your app's dashboard address
          notes: \${{ github.event.head_commit.message }}`;

const PREVIEW = `- uses: ${ACTION_USES}
  with:
    api-key: \${{ secrets.${ACTION_SECRET} }}
    url: \${{ steps.deploy.outputs.url }}
    preview: true
    sha: \${{ github.event.pull_request.head.sha }}
    fail-on: needs_attention`;

const CURL = `curl -X POST https://checkmyapp.dev/api/checks \\
  -H "Authorization: Bearer $${ACTION_SECRET}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://your-app.com","deploy":{"sha":"'"$COMMIT_SHA"'","env":"production"}}'`;

export default function CheckEveryReleaseGuide() {
  return (
    <GuidePage
      slug="check-every-release"
      headline={
        <>
          Check <span className="text-accent">every release</span>.
        </>
      }
      lead="A release is when things break. Add one step to your GitHub workflow, and CheckMyApp uses your deployed app the way a real user would right after each deploy — and tells you in the job whether it still works."
    >
      <Section title="One step">
        <p>
          The step is a GitHub Action,{" "}
          <A href={ACTION_MARKETPLACE_URL}>CheckMyApp — check this release</A>, on the GitHub
          Marketplace. Put it after your deploy:
        </p>
        <CodeBlock label="workflow step" code={ACTION_STEP_YAML} />
        <p>
          Create an API key (<A href="/guides/connect-your-agent">the same key your agent uses</A>
          ) and save it as a repository secret named <Code>{ACTION_SECRET}</Code>. Keys come with
          every plan.
        </p>
        <p>
          The job summary shows the verdict, what is new since the previous check — each finding
          linked to the verdict — and what the check cost. The verdict names the commit you
          shipped.
        </p>
      </Section>

      <Section title="Where it goes in your workflow">
        <p>
          <Strong>Your host deploys for you</Strong> (Vercel and others with a GitHub
          integration). They report each deployment to GitHub, and the check takes the address
          from the deployment itself:
        </p>
        <CodeBlock label=".github/workflows/check-release.yml" code={DEPLOYMENT_STATUS} />
        <p>
          <Strong>Your workflow deploys the app.</Strong> Add a job after the deploy. With{" "}
          <Code>app-id</Code> the check uses everything you saved for the app: its test logins,
          the scenarios that must keep working, and the places it must not go.
        </p>
        <CodeBlock label="after your deploy job" code={AFTER_DEPLOY} />
        <p>
          <Strong>Pull request previews.</Strong> Check a preview before it merges. A preview
          check is private, is deleted after about a week, and never shows up as an app of yours.
        </p>
        <CodeBlock label="in your preview job" code={PREVIEW} />
      </Section>

      <Section title="Stop a broken release">
        <p>
          By default the job fails when the verdict is <Code>broken</Code>. Set{" "}
          <Code>fail-on: needs_attention</Code> to be stricter, or <Code>fail-on: never</Code> to
          only report.
        </p>
        <Bullets
          items={[
            <>
              A full check usually takes 15–35 minutes. To keep the job short, set{" "}
              <Code>wait: false</Code>: the step starts the check and finishes, and the verdict
              appears on its page.
            </>,
            <>
              If a check of the same app was already running when the release landed, the step
              waits for it and then checks this build — the verdict is always about the commit
              you shipped.
            </>,
          ]}
        />
      </Section>

      <Section title="What it costs">
        <p>
          Every check has its own price, paid from your balance like any other check: about
          $0.50–$1.50 for a full check of a typical app, a few cents when nothing changed since
          the last one. The job summary shows what each check cost and what it did for that
          price. Plans are on <A href="/pricing">Pricing</A>.
        </p>
      </Section>

      <Note label="not on GitHub Actions?">
        <p>Any CI can start the same check with one request after the deploy:</p>
        <CodeBlock label="terminal" code={CURL} />
        <p>
          The answer carries the check’s <Code>id</Code>; its verdict is at{" "}
          <Code>checkmyapp.dev/verdict/&lt;id&gt;</Code>. Your{" "}
          <A href="/guides/connect-your-agent">coding agent</A> can do the same with{" "}
          <Code>start_check</Code> and a <Code>deploy_sha</Code>.
        </p>
      </Note>
    </GuidePage>
  );
}
