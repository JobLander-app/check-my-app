// CHE-438 / R18: the privacy page says only what the code does.
//
// src/lib/privacy-copy.ts holds the page's sentences and, next to each claim,
// what in the code makes it true. This guard checks:
//
//   1. language: every sentence passes the verdict-language guards and names
//      no processor brand (CLAUDE.md §1: what we run on is ours);
//   2. processors, both ways:
//        - each processor the page lists is still used (its evidence is in src/);
//        - each service SDK in package.json, and each host the code fetches by
//          a literal URL, belongs to a listed processor or to a tool the
//          customer connects. A new processor turns this red until the page
//          names it.
//      Hosts reached through a constant (`fetch(API_URL)`) are not scanned;
//      the evidence direction covers the processors that call that way;
//   3. stored data:
//        - TrackerIntegration and IssueLink have exactly the columns the
//          "Tools you connect" sentence was written against, so a new column
//          is a new thing kept and must be read against the page;
//        - the token and test-password writers the page speaks of encrypt;
//        - the Jira client stores no Atlassian account id, name or email;
//        - analytics masks inputs.
//
// Each checker is pure and has a self-test that feeds it a defect, so the
// guard is seen catching it (R19).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-privacy-copy.ts

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

const BRANDS = /\b(cloudflare|clerk|stripe|resend|anthropic|openrouter|claude|openai|gpt|gemini|deepseek|telegram|playwright|headless)\b/i;

function languageProblems(sentences: string[]): string[] {
  return sentences.flatMap((s) => [
    ...(hasEnvironmentLeak(s) ? [`leak: ${s}`] : []),
    ...(hasHomework(s) ? [`homework: ${s}`] : []),
    ...(BRANDS.test(s) ? [`brand: ${s}`] : []),
  ]);
}

// A dependency that is a service someone else runs, rather than a library that
// runs in our code.
const SERVICE_SDK =
  /^(@anthropic-ai\/|openai$|@ai-sdk\/|@clerk\/|stripe$|posthog|@sentry\/|resend$|@sendgrid\/|mailgun|postmark|@segment\/|mixpanel|amplitude|@datadog\/|logrocket|@intercom\/|firebase|@supabase\/|@aws-sdk\/|@google-cloud\/|@cloudflare\/|@opennextjs\/cloudflare|@vercel\/analytics|@upstash\/|twilio)/;

function unclaimedPackages(deps: string[], processors: Processor[]): string[] {
  return deps.filter((d) => SERVICE_SDK.test(d) && !processors.some((p) => p.packages.some((re) => re.test(d))));
}

// The customer's own tools, named on the page under "Tools you connect".
const CONNECTED_TOOL_HOSTS = new Set([
  "api.linear.app",
  "api.github.com",
  "api.atlassian.com",
  "auth.atlassian.com",
  "oauth.posthog.com",
  "us.posthog.com",
  "eu.posthog.com",
]);

function unclaimedHosts(hosts: string[], processors: Processor[]): string[] {
  return hosts.filter((h) => !CONNECTED_TOOL_HOSTS.has(h) && !processors.some((p) => p.hosts.includes(h)));
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

// ── reading the repository ──────────────────────────────────────────────────

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const SOURCES = walk(path.join(repoRoot, "src")).map((f) => readFileSync(f, "utf8"));

function fetchedHosts(): string[] {
  const hosts = new Set<string>();
  for (const src of SOURCES) {
    for (const m of src.matchAll(/fetch\(\s*[`"']https:\/\/([a-z0-9.-]+)/g)) hosts.add(m[1]);
  }
  return [...hosts].sort();
}

// What the "Tools you connect" sentence was written against.
const TRACKER_COLUMNS = ["id", "app", "appId", "type", "accessTokenEnc", "refreshTokenEnc", "tokenExpiresAt", "teamId", "externalOrg", "createdAt", "updatedAt"];
const ISSUE_LINK_COLUMNS = ["id", "app", "appId", "dedupKey", "externalIssueId", "status", "defectClass", "findingId", "occurrences", "escalatedAt", "firstSeenRunId", "lastSeenAt", "createdAt", "updatedAt"];

// ── self-tests: each checker catches the defect it exists for ───────────────

check("self-test: a brand in a sentence is caught", languageProblems(["Pages go to Anthropic."]).length === 1);
check("self-test: homework is caught", languageProblems(["Verify this in a real browser yourself."]).length > 0);
check("self-test: a clean sentence passes", languageProblems(["We keep your data while your account exists."]).length === 0);
check("self-test: a new service SDK is caught", unclaimedPackages(["@sentry/nextjs", "zod"], PROCESSORS).join() === "@sentry/nextjs");
check("self-test: a new fetched host is caught", unclaimedHosts(["api.mailgun.net", "api.resend.com", "api.linear.app"], PROCESSORS).join() === "api.mailgun.net");
check(
  "self-test: a new column is caught",
  columnDrift(modelColumns("model T {\n  id String\n  accountId String\n}\n", "T"), ["id"]) === "+accountId",
);

// ── the page against the code ───────────────────────────────────────────────

const sentences = privacySentences();
check("the page has sentences to check", sentences.length >= 8, String(sentences.length));
const lang = languageProblems(sentences);
check("language: no leak, no homework, no processor brand", lang.length === 0, lang.join(" | "));

for (const p of PROCESSORS) {
  check(`processor still used: ${p.role}`, SOURCES.some((s) => p.evidence.test(s)), String(p.evidence));
}

const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const strayPkgs = unclaimedPackages(deps, PROCESSORS);
check("every service SDK is a listed processor", strayPkgs.length === 0, strayPkgs.join(", "));

const hosts = fetchedHosts();
check("the fetched-host scan finds hosts (the scan itself works)", hosts.length > 0, hosts.join(", "));
const strayHosts = unclaimedHosts(hosts, PROCESSORS);
check("every host fetched by a literal URL is a listed processor or a connected tool", strayHosts.length === 0, strayHosts.join(", "));

const schema = read("prisma/schema.prisma");
const trackerDrift = columnDrift(modelColumns(schema, "TrackerIntegration"), TRACKER_COLUMNS);
check("TrackerIntegration keeps what the page says (a new column: read the page, then update this list)", trackerDrift === "", trackerDrift);
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
check("analytics masks form inputs", SOURCES.some((s) => /maskAllInputs:\s*true/.test(s)));

const jira = "src/lib/tracker/jira.ts";
if (existsSync(path.join(repoRoot, jira))) {
  check("the Jira client asks for no Atlassian account id, name or email", !/accountId|emailAddress|displayName|\/myself\b/.test(read(jira)));
} else {
  console.log("skip  the Jira client is not on this branch yet");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
