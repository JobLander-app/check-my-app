import { CodeBlock } from "@/components/code-block";
import { GUIDE_PLANS, planAllowance } from "@/lib/plan-status";
import { A, Bullets, Code, Example, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("connect-your-agent");

// Tool names and arguments checked against the merged CHE-315 server
// (src/lib/mcp/tools.ts, #184) and its production tools/list on 2026-09-27:
// create_app takes url, scenarios, limits, notes, test_email, test_password —
// no name (an app is named by its host). CHE-322 added test_accounts
// ([{label, email, password}]) to create_app and update_app, and
// remove_test_accounts to update_app; list_apps returns each account's label
// and email, never a password.
//
// Verified independently of CHE-315:
// - keys on every plan: CHE-316 (#179) — src/components/api-keys.tsx has no
//   plan gate on the create form
// - `claude mcp add --transport http <name> <url> --header "..."` syntax:
//   `claude mcp add --help` (Claude Code CLI)
// - Cursor config shape and paths (.cursor/mcp.json, ~/.cursor/mcp.json,
//   url + headers, ${env:VAR}): cursor.com/docs/context/mcp
// - the raw key is shown once, only its hash is stored, revoke deletes it:
//   src/components/api-keys.tsx, src/app/dashboard/actions.ts (CHE-52)
// - runs started with a key belong to the key's team and spend its balance:
//   src/app/api/checks/route.ts (assertCanStartRun)
const CLAUDE_CODE = `claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \\
  --header "Authorization: Bearer cma_YOUR_KEY"`;

const CURSOR = `{
  "mcpServers": {
    "checkmyapp": {
      "url": "https://checkmyapp.dev/mcp",
      "headers": {
        "Authorization": "Bearer \${env:CHECKMYAPP_API_KEY}"
      }
    }
  }
}`;

const TOOLS: { name: string; what: string }[] = [
  { name: "list_apps", what: "The apps your team has added." },
  {
    name: "create_app",
    what: "Add an app: its address, scenarios, limits, notes, and its test accounts — one, or several named ones such as “admin” and “free user”.",
  },
  { name: "update_app", what: "Change an app’s scenarios, limits, notes or test accounts." },
  { name: "start_check", what: "Check an app you added, or any address." },
  { name: "get_check_status", what: "Where a running check is, without waiting." },
  { name: "wait_for_run", what: "Wait for a check to finish and return its verdict." },
  { name: "wait_for_review", what: "Wait for a check to finish and return its findings, ready to fix." },
  {
    name: "get_review",
    what: "The findings in the shape you fix from: each symptom, its evidence, and how to know it is gone.",
  },
  { name: "get_verdict", what: "The verdict of a check, or the latest one for an address." },
  { name: "latest_results", what: "Every app’s last check and what is new since the one before." },
  { name: "enable_watch", what: "Turn on Daily Watch for an app, within your plan." },
  { name: "disable_watch", what: "Turn Daily Watch off." },
];

export default function ConnectAgentGuide() {
  return (
    <GuidePage
      slug="connect-your-agent"
      headline={
        <>
          Connect your <span className="text-accent">coding agent</span>.
        </>
      }
      lead="CheckMyApp speaks MCP, so the agent you already code with can add your app, run a check after a deploy, read what was found and fix it — without you opening the dashboard."
    >
      <Section title="1 · Create an API key">
        <p>
          Dashboard → <Strong>API keys</Strong> → Create key. Keys are available on every plan.
          The key is shown once — copy it then. Only a hash of it is stored, and revoking it
          deletes it immediately. Checks started with the key belong to your team and
          spend its balance like any other.
        </p>
      </Section>

      <Section title="2 · Add CheckMyApp to your agent">
        <p>
          <Strong>Claude Code</Strong> — one line in your terminal:
        </p>
        <CodeBlock label="terminal" code={CLAUDE_CODE} />
        <p>
          <Strong>Cursor</Strong> — add this to <Code>~/.cursor/mcp.json</Code> (or{" "}
          <Code>.cursor/mcp.json</Code> in one project) and set{" "}
          <Code>CHECKMYAPP_API_KEY</Code> in your environment, so the key never lands in a
          repository:
        </p>
        <CodeBlock label="mcp.json" code={CURSOR} />
        <p>
          <Strong>Any other MCP client</Strong> — connect to{" "}
          <Code>https://checkmyapp.dev/mcp</Code> over Streamable HTTP with the header{" "}
          <Code>Authorization: Bearer cma_…</Code>.
        </p>
      </Section>

      <Section title="3 · Ask for what you want">
        <p>You talk to your agent as usual; it picks the tools. For example:</p>
        <Example>
          Add my app https://app.example.com to CheckMyApp with the test account
          qa@example.com — the password is QA_PASSWORD in .env.test. Scenarios: a signed-in user
          can create an invoice and download it as a PDF; search finds an invoice by number. Then
          run a check and fix what it finds.
        </Example>
        <Example>
          I just deployed. Run a CheckMyApp check on app.example.com, wait for it, and work
          through the review.
        </Example>
        <Example>What did CheckMyApp find on my apps since yesterday?</Example>
        <Example>Turn on Daily Watch for app.example.com.</Example>
        <p>
          A check takes about 20–40 minutes; your agent can wait for it or come back to it.
        </p>
      </Section>

      <Section title="What your agent can do">
        <div className="card divide-y divide-ink-700">
          {TOOLS.map((t) => (
            <div key={t.name} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
              <code className="shrink-0 font-mono text-[13px] text-accent sm:w-40">{t.name}</code>
              <span className="text-sm leading-6 text-fg-muted">{t.what}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* CHE-325: generated from PLAN_LIMITS (src/lib/plan-status.ts
          planAllowance), so no number here can drift from the gates;
          scripts/verify-mcp-remote.ts renders this page and compares. */}
      <Section title="What your plan allows">
        <p>
          Every tool above works on every plan, Free included. A plan is a balance, and every
          check — scheduled, started by your agent or from the dashboard — spends it at its own
          price:
        </p>
        <ul className="card divide-y divide-ink-700">
          {GUIDE_PLANS.map((plan) => {
            const a = planAllowance(plan);
            return (
              <li key={plan} data-plan={plan} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
                <span className="shrink-0 font-mono text-[13px] text-accent sm:w-40">{a.name}</span>
                <span className="text-sm leading-6 text-fg-muted">{a.text}</span>
              </li>
            );
          })}
        </ul>
        <p>
          Your agent is told your balance and what a check of each app usually costs when it
          connects, and says so before it spends the last of it. Every finished check comes
          back with its price and the work it paid for. When the balance runs out, the answer
          comes with two links: top up, or upgrade. Plans are on <A href="/pricing">Pricing</A>.
        </p>
      </Section>

      <Note label="how to read what comes back">
        <Bullets
          items={[
            <>
              Each finding names a symptom and the sentence that means it is gone — not a file or
              a fix. How to fix it is your agent’s call, with your code in front of it.
            </>,
            <>
              After a fix, start another check: the next verdict says whether the symptom is
              gone.
            </>,
            <>
              Test accounts and scenarios are covered in{" "}
              <A href="/guides/login-and-test-accounts">Checking pages behind a login</A> and{" "}
              <A href="/guides/scenarios">Your own scenarios</A>.
            </>,
            <>
              To have every deploy checked without anyone asking, see{" "}
              <A href="/guides/check-every-release">Check every release</A>.
            </>,
          ]}
        />
      </Note>
    </GuidePage>
  );
}
