// CHE-438 / R18: the privacy page says only what the code does.
//
// src/lib/privacy-copy.ts holds the page's sentences and, next to each claim,
// what in the code makes it true. This guard reads the implementation (src/
// without comments, without generated code and without the copy module
// itself, so a claim can never be its own evidence) and checks:
//
//   1. language: every sentence passes the verdict-language guards and names
//      no processor brand (CLAUDE.md §1: what we run on is ours);
//   2. processors, both ways:
//        - each processor the page lists is still used (its evidence is in
//          the implementation);
//        - each service SDK in package.json belongs to a listed processor;
//        - each host written as a URL anywhere in the implementation, whether
//          fetched directly or through a constant, is a listed processor, a
//          tool the customer connects, or classified below as receiving
//          nothing from us, with the reason.
//      A new service turns this red until the page names it;
//   3. stored data:
//        - TrackerIntegration and IssueLink have exactly the columns the
//          "Tools you connect" sentence was written against, so a new column
//          is a new thing kept and must be read against the page;
//        - the token and test-password writers the page speaks of encrypt;
//        - the Jira client asks for no Atlassian account id, name or email;
//        - analytics masks inputs.
//
// Each checker is pure and has a self-test that feeds it the defect it
// exists for, so the guard is seen catching it (R19).
//
// Usage: npm run verify:privacy-copy

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import { PROCESSORS, privacySentences, type Processor } from "../src/lib/privacy-copy";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ── pure checkers ───────────────────────────────────────────────────────────

const BRANDS = /\b(cloudflare|clerk|stripe|resend|anthropic|openrouter|claude|openai|gpt|gemini|deepseek|telegram|youtube|playwright|headless)\b/i;

function languageProblems(sentences: string[]): string[] {
  return sentences.flatMap((s) => [
    ...(hasEnvironmentLeak(s) ? [`leak: ${s}`] : []),
    ...(hasHomework(s) ? [`homework: ${s}`] : []),
    ...(BRANDS.test(s) ? [`brand: ${s}`] : []),
  ]);
}

/** Source text without comments. A URL keeps its "//" because a ":" precedes it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function unusedProcessors(processors: Processor[], sources: string[]): string[] {
  return processors.filter((p) => !sources.some((s) => p.evidence.test(s))).map((p) => p.role);
}

// A dependency that is a service someone else runs, rather than a library that
// runs in our code.
const SERVICE_SDK =
  /^(@anthropic-ai\/|openai$|@ai-sdk\/|@clerk\/|stripe$|posthog|@sentry\/|resend$|@sendgrid\/|mailgun|postmark|@segment\/|mixpanel|amplitude|@datadog\/|logrocket|@intercom\/|firebase|@supabase\/|@aws-sdk\/|@google-cloud\/|@cloudflare\/|@opennextjs\/cloudflare|@vercel\/analytics|@upstash\/|twilio)/;

function unclaimedPackages(deps: string[], processors: Processor[]): string[] {
  return deps.filter((d) => SERVICE_SDK.test(d) && !processors.some((p) => p.packages.some((re) => re.test(d))));
}

function literalHosts(sources: string[]): string[] {
  const hosts = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.add(m[1].toLowerCase());
  }
  return [...hosts].sort();
}

// The customer's own tools, named on the page under "Tools you connect".
const CONNECTED_TOOL_HOSTS = new Set([
  "api.linear.app",
  "linear.app",
  "api.github.com",
  "api.atlassian.com",
  "auth.atlassian.com",
  "oauth.posthog.com",
  "us.posthog.com",
  "eu.posthog.com",
]);

// Hosts written in the code that receive nothing of the customer's from us.
const RECEIVES_NOTHING: Record<string, string> = {
  "checkmyapp.dev": "our own site",
  "127.0.0.1": "the machine a check runs on",
  "joblander.app": "an app being checked (the extension's companion page), not a service we use",
  "admin.shopify.com": "the customer's own store admin, opened as the app being checked",
  "chromewebstore.google.com": "links to the customer's own extension listing",
  "github.com": "links shown on our pages",
  "github.io": "an entry in a list of shared domain suffixes, never called",
  "com.au": "an entry in a list of shared domain suffixes, never called",
  "hooks.slack.com": "placeholder text in the webhook field; the customer's own webhook is under \"Webhooks you add\"",
  "app.example.com": "an example address in help text",
  "your-app.com": "an example address in help text",
  "your-app.example.com": "an example address in help text",
  "your-stack.example.com": "an example address in help text",
};

function unclaimedHosts(hosts: string[], processors: Processor[]): string[] {
  return hosts.filter((h) => !CONNECTED_TOOL_HOSTS.has(h) && !(h in RECEIVES_NOTHING) && !processors.some((p) => p.hosts.includes(h)));
}

function modelColumns(schema: string, model: string): string[] | null {
  const block = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"))?.[1];
  if (!block) return null;
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
    .map((l) => l.split(/\s+/)[0]);
}

function columnDrift(actual: string[] | null, expected: string[]): string {
  if (!actual) return "model not found";
  const added = actual.filter((c) => !expected.includes(c));
  const removed = expected.filter((c) => !actual.includes(c));
  return [...added.map((c) => `+${c}`), ...removed.map((c) => `-${c}`)].join(" ");
}

// ── reading the implementation ──────────────────────────────────────────────

const COPY_MODULE = path.join(repoRoot, "src/lib/privacy-copy.ts");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && p !== COPY_MODULE ? [p] : [];
  });
}

const IMPLEMENTATION = walk(path.join(repoRoot, "src")).map((f) => stripComments(readFileSync(f, "utf8")));

// What the "Tools you connect" sentence was written against.
// externalUrl (CHE-438) is the Jira site's address: "the site … you chose".
// connectionId (CHE-469) points at the team's grant below; it keeps nothing.
const TRACKER_COLUMNS = ["id", "app", "appId", "type", "accessTokenEnc", "refreshTokenEnc", "tokenExpiresAt", "teamId", "externalOrg", "externalUrl", "connection", "connectionId", "createdAt", "updatedAt"];
// CHE-469: the team's grant — "the access token is stored encrypted", and
// nothing else about the person or the tracker.
const CONNECTION_COLUMNS = ["id", "team", "teamId", "type", "accessTokenEnc", "refreshTokenEnc", "tokenExpiresAt", "apps", "createdAt", "updatedAt"];
const ISSUE_LINK_COLUMNS = ["id", "app", "appId", "dedupKey", "externalIssueId", "status", "defectClass", "findingId", "occurrences", "escalatedAt", "firstSeenRunId", "lastSeenAt", "createdAt", "updatedAt"];

// ── self-tests: each checker catches the defect it exists for ───────────────

check("self-test: a brand in a sentence is caught", languageProblems(["Pages go to Anthropic."]).length === 1);
check("self-test: homework is caught", languageProblems(["Verify this in a real browser yourself."]).length > 0);
check("self-test: a clean sentence passes", languageProblems(["We keep your data while your account exists."]).length === 0);
check("self-test: comments are not code", literalHosts([stripComments("// see https://api.mailgun.net\nconst a = 1;")]).length === 0);
check(
  "self-test: a processor with no evidence in the implementation is caught",
  unusedProcessors([{ role: "mail", evidence: /api\.mailgun\.net/, packages: [], hosts: [] }], ["const x = 1;"]).join() === "mail",
);
check("self-test: a new service SDK is caught", unclaimedPackages(["@sentry/nextjs", "zod"], PROCESSORS).join() === "@sentry/nextjs");
check(
  "self-test: a host fetched through a constant is caught",
  unclaimedHosts(literalHosts([stripComments('const API = "https://api.mailgun.net/v3";\nawait fetch(API);')]), PROCESSORS).join() === "api.mailgun.net",
);
check(
  "self-test: a new column is caught",
  columnDrift(modelColumns("model T {\n  id String\n  accountId String\n}\n", "T"), ["id"]) === "+accountId",
);

// ── the page against the code ───────────────────────────────────────────────

const sentences = privacySentences();
check("the page has sentences to check", sentences.length >= 9, String(sentences.length));
const lang = languageProblems(sentences);
check("language: no leak, no homework, no processor brand", lang.length === 0, lang.join(" | "));

const unused = unusedProcessors(PROCESSORS, IMPLEMENTATION);
check("every listed processor is still used by the implementation", unused.length === 0, unused.join(" | "));

const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const strayPkgs = unclaimedPackages(deps, PROCESSORS);
check("every service SDK is a listed processor", strayPkgs.length === 0, strayPkgs.join(", "));

const hosts = literalHosts(IMPLEMENTATION);
check("the host scan finds the processors' own hosts (the scan itself works)", ["api.resend.com", "openrouter.ai", "www.youtube.com"].every((h) => hosts.includes(h)), hosts.join(", "));
const strayHosts = unclaimedHosts(hosts, PROCESSORS);
check("every host in the implementation is a listed processor, a connected tool, or receives nothing", strayHosts.length === 0, strayHosts.join(", "));
const staleNothing = Object.keys(RECEIVES_NOTHING).filter((h) => !hosts.includes(h));
check("every \"receives nothing\" entry is still in the code (no dead exemptions)", staleNothing.length === 0, staleNothing.join(", "));

const schema = read("prisma/schema.prisma");
const trackerDrift = columnDrift(modelColumns(schema, "TrackerIntegration"), TRACKER_COLUMNS);
check("TrackerIntegration keeps what the page says (a new column: read the page, then update this list)", trackerDrift === "", trackerDrift);
const connectionDrift = columnDrift(modelColumns(schema, "TrackerConnection"), CONNECTION_COLUMNS);
check("TrackerConnection keeps what the page says (a new column: read the page, then update this list)", connectionDrift === "", connectionDrift);
check("a connect writes the team's grant encrypted (Linear and Jira)",
  ["src/lib/tracker/linear-connect.ts", "src/lib/tracker/jira-connect.ts"].every((f) => /accessTokenEnc:\s*encryptSecret\(/.test(read(f)) && /refreshTokenEnc:[^\n]*encryptSecret\(/.test(read(f))));
const linkDrift = columnDrift(modelColumns(schema, "IssueLink"), ISSUE_LINK_COLUMNS);
check("IssueLink keeps what the page says (a new column: read the page, then update this list)", linkDrift === "", linkDrift);

check("tracker tokens are written encrypted", /accessTokenEnc:\s*encryptSecret\(/.test(read("src/lib/tracker/token.ts")));
check("PostHog tokens are written encrypted", /accessTokenEnc:\s*encryptSecret\(/.test(read("src/lib/posthog/token.ts")));
// Every database write of a test-account password goes through encryptSecret.
// Other mentions (the type, a stored value passed along) are already ciphertext.
const passwordWrites = read("src/lib/test-accounts.ts")
  .split("\n")
  .filter((l) => /\bdata:/.test(l) && /passwordEnc/.test(l));
check(
  "test-account passwords are written encrypted",
  passwordWrites.length > 0 && passwordWrites.every((l) => /passwordEnc:\s*encryptSecret\(/.test(l)),
  `${passwordWrites.length} write(s)`,
);
check("analytics masks form inputs", IMPLEMENTATION.some((s) => /maskAllInputs:\s*true/.test(s)));
// "the result of each recurring check is posted to them": the webhook step runs
// for watch runs only. If it ever runs for every check, the sentence changes.
check(
  "webhooks are posted for recurring checks, as the page says",
  /if \(run\.watchId[^)]*\)\s*\{\s*await step\.do\("notify-integrations"/.test(stripComments(read("src/agent/workflow.ts"))),
);

// R18: the page renders the module's words and has none of its own.
const literalText = (src: string) => [...stripComments(src).matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1].trim());
check("self-test: literal JSX text is caught", literalText("<p>Hello there</p><p>{x}</p>").join() === "Hello there");
const pageText = literalText(read("src/app/privacy/page.tsx"));
check("the page has no text of its own (all of it comes from privacy-copy.ts)", pageText.length === 0, pageText.join(" | "));

const jira = "src/lib/tracker/jira.ts";
if (existsSync(path.join(repoRoot, jira))) {
  check("the Jira client asks for no Atlassian account id, name or email", !/accountId|emailAddress|displayName|\/myself\b/.test(stripComments(read(jira))));
} else {
  console.log("skip  the Jira client is not on this branch yet");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
