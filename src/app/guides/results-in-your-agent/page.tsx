import { CodeBlock } from "@/components/code-block";
import { watchChannelCommands } from "@/lib/agent-connect";
import { A, Code, Example, GuidePage, Note, Section, Strong, guideMetadata } from "../guide-kit";

export const metadata = guideMetadata("results-in-your-agent");

// - "tells your agent at connection" is the per-connection MCP `instructions`
//   of CHE-315 (src/lib/mcp/instructions.ts); seen on production 2026-09-27
//   as "example.com: mostly OK · Nothing new since the previous check".
//   `latest_results` is its tool.
// - the push is the checkmyapp-watch channel of CHE-319 (mcp/channel/): both
//   commands come from watchChannelCommands (src/lib/agent-connect.ts), whose
//   URL carries the channel's version, so the page cannot print a tarball the
//   site does not serve (scripts/verify-mcp-channel.ts). Run from its tarball
//   against production on 2026-09-27: handshake, first poll, quiet start. The
//   flag and its preview status are Claude Code's own, verified on
//   code.claude.com/docs/en/channels(-reference) (2026-09-27): custom channels
//   load only with --dangerously-load-development-channels during the research
//   preview, and claude.ai Team/Enterprise orgs must have an Owner enable
//   channels.
const CHANNEL = watchChannelCommands(null);

export default function ResultsInAgentGuide() {
  return (
    <GuidePage
      slug="results-in-your-agent"
      headline={
        <>
          Daily Watch results <span className="text-accent">in your agent</span>.
        </>
      }
      lead="Daily Watch checks your app every day. The results come to where the fixing happens: the next time you open your coding agent, it already knows."
    >
      <Section title="At the start of every session">
        <p>
          Once CheckMyApp is <A href="/guides/connect-your-agent">connected to your agent</A>,
          it tells the agent, the moment it connects, how your watched apps did in their latest
          checks and which findings are new. Your agent raises them before you ask, and offers to
          fix them.
        </p>
        <p>You can also ask at any time:</p>
        <Example>What did CheckMyApp find since my last session?</Example>
        <p>
          The agent answers with <Code>latest_results</Code>: every app’s last check, its verdict,
          and what is new since the check before.
        </p>
      </Section>

      <Section title="Pushed into a running session (preview)">
        <p>
          For a Claude Code session you leave open, CheckMyApp pushes each finished Daily Watch
          check straight into it: the app, the verdict and the findings that are new. The agent
          tells you and offers to fix them — it does not start changing anything until you say
          so. Opening a session does not replay old results; a check with new findings from the
          last 24 hours is the one exception, and it is waiting for you when you sit down.
        </p>
        <p>
          Add it once, with your <A href="/guides/connect-your-agent">API key</A> in place
          of <Code>&lt;KEY&gt;</Code>:
        </p>
        <CodeBlock label="terminal" code={CHANNEL.add} />
        <p>
          It builds on Claude Code <Strong>channels</Strong>, which are a research preview; while
          they are, a channel like ours is switched on per session with a flag:
        </p>
        <CodeBlock label="terminal" code={CHANNEL.start} />
        <p>
          Keep CheckMyApp itself <A href="/guides/connect-your-agent">connected</A> as well: the
          push announces, and the agent fixes from the full review it asks CheckMyApp for. On
          claude.ai Team and Enterprise plans, channels must first be enabled by an Owner of your
          organization.
        </p>
      </Section>

      <Note label="not using an agent?">
        <p>
          Every result also stays in your dashboard. From the app’s settings, new regressions
          can become tickets in Linear, and results can go to email, Slack or your own webhook.
        </p>
      </Note>
    </GuidePage>
  );
}
