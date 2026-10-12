// What /privacy says (CHE-438), as data, so it can be checked (R18).
//
// scripts/verify-privacy-copy.ts runs every sentence through the
// verdict-language guards and holds each claim to the code:
//   - every processor below is still used (its `evidence` is in src/);
//   - every service SDK in package.json, and every host the code fetches by a
//     literal URL, belongs to a processor below or to a tool the customer
//     connects;
//   - the tables a sentence describes still have exactly the columns it was
//     written against.
// When the code moves, the guard goes red and this page moves with it.
//
// Processors are named by what they do, never by brand: what we run on is our
// machinery (CLAUDE.md §1). The customer's own tools are named, because they
// are the customer's.

export const PRIVACY_UPDATED = "12 October 2026";

export const PRIVACY_DESCRIPTION =
  "What CheckMyApp keeps about you and the apps you ask it to check, who processes it, and how to have it deleted.";

export interface KeptItem {
  lead: string;
  text: string;
}

export const KEPT: KeptItem[] = [
  { lead: "Your account.", text: "The email and name you sign in with." },
  {
    lead: "The apps you ask us to check.",
    text: "Their addresses, what a check saw on their pages (screenshots, page text, errors), and the verdicts and findings it wrote. Test-account passwords you give us are stored encrypted and used only to sign in to your app during a check.",
  },
  {
    lead: "Tools you connect.",
    text: "For Jira, Linear, GitHub or PostHog the access token is stored encrypted. From Jira we keep the site and project you chose and the keys of the issues we filed, and we read back only what became of those issues. We do not store Atlassian account ids, names or email addresses.",
  },
  {
    lead: "Webhooks you add.",
    text: "The addresses you give us, a Slack webhook among them; each check's result is posted to them.",
  },
  { lead: "Payments.", text: "A payment processor takes the payment; we never see or store card numbers." },
  { lead: "How the site is used.", text: "Product analytics and session replay, with form inputs masked." },
];

export interface Processor {
  /** What the customer reads: the part of the work this service does. */
  role: string;
  /** Proof in src/ that the service is still used. */
  evidence: RegExp;
  /** The package.json dependencies that are this service. */
  packages: RegExp[];
  /** Hosts the code fetches by a literal URL that are this service. */
  hosts: string[];
}

export const PROCESSORS: Processor[] = [
  {
    role: "hosting, the database and file storage, and the bot check on the check form",
    evidence: /getCloudflareContext/,
    packages: [/^@cloudflare\//, /^@opennextjs\/cloudflare$/],
    hosts: ["challenges.cloudflare.com", "api.cloudflare.com"],
  },
  { role: "sign-in", evidence: /from "@clerk\/nextjs/, packages: [/^@clerk\//], hosts: [] },
  { role: "payments", evidence: /from "stripe"/, packages: [/^stripe$/], hosts: [] },
  { role: "email delivery", evidence: /api\.resend\.com\/emails/, packages: [], hosts: ["api.resend.com"] },
  { role: "product analytics", evidence: /from "posthog-js"/, packages: [/^posthog/], hosts: ["us.i.posthog.com"] },
  {
    role: "the AI models a check runs on, which receive the content of the pages being checked",
    evidence: /openrouter\.ai\/api/,
    packages: [/^@anthropic-ai\//],
    hosts: ["openrouter.ai"],
  },
  {
    role: "a video site's public lookup, which tells us whether a video your pages link to exists",
    evidence: /youtube\.com\/oembed/,
    packages: [],
    hosts: ["www.youtube.com"],
  },
  { role: "a chat service that carries notices about checks", evidence: /api\.telegram\.org\/bot/, packages: [], hosts: ["api.telegram.org"] },
];

export function processorsSentence(processors: Processor[] = PROCESSORS): string {
  const roles = processors.map((p) => p.role);
  const list = roles.length > 1 ? `${roles.slice(0, -1).join("; ")}; and ${roles.at(-1)}` : (roles[0] ?? "");
  return `Some of the work is done by services acting for us: ${list}.`;
}

export const NOT_SOLD = "Nothing is sold, and nothing is shared beyond what these services need to do their part.";

export const REMOVAL: string[] = [
  "We keep your data while your account exists.",
  "You can revoke our access to a connected tool at any time from that tool's own settings — for Jira, under connected apps in your Atlassian account.",
  "Write to us and we delete your account and everything kept for it. You can also ask what we hold about you, or have it corrected.",
];

export const OPERATOR = "Vladislav Sorokin";
export const CONTACT_EMAIL = "sorokinvj@gmail.com";

/** Every sentence the page shows, for the guard. */
export function privacySentences(): string[] {
  return [
    PRIVACY_DESCRIPTION,
    ...KEPT.map((k) => `${k.lead} ${k.text}`),
    processorsSentence(),
    NOT_SOLD,
    ...REMOVAL,
  ];
}
