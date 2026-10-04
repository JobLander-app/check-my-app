// The guides at /guides (CHE-318). One list, read by the index page, the
// "other guides" footer of every guide, and PUBLIC_PATHS — so a guide cannot
// exist without being in the sitemap, or be in the sitemap without existing
// (scripts/verify-seo.ts checks every entry has its page).
//
// They answer what the first outside developer asked on signing up: how does
// login work, can I pass credentials securely, can I test several accounts,
// how do I define my own scenarios — plus the agent, which is how he will use
// the product.

export type Guide = {
  slug: string;
  // The page's own name — also its <title> and its card on the index.
  title: string;
  // One sentence for the index card, the meta description and the link preview.
  description: string;
};

export const GUIDES: Guide[] = [
  {
    slug: "login-and-test-accounts",
    title: "Checking pages behind a login",
    description:
      "Give CheckMyApp a test account so it checks the signed-in part of your app — how the password is kept, and what happens when it stops working.",
  },
  {
    slug: "scenarios",
    title: "Your own scenarios",
    description:
      "Tell CheckMyApp what matters most, where it must not go, and what it should know — and how to write a scenario it can verify every day.",
  },
  {
    slug: "multiple-accounts",
    title: "Several accounts and roles",
    description:
      "An admin and a regular user, a free and a paid plan: give one app several named test accounts, and say which one each scenario runs as.",
  },
  {
    slug: "connect-your-agent",
    title: "Connect your coding agent",
    description:
      "Add CheckMyApp to Claude Code, Cursor or any MCP client in one line, then let your agent add apps, run checks and fix what they find.",
  },
  {
    slug: "results-in-your-agent",
    title: "Daily Watch results in your agent",
    description:
      "Your agent opens a session already knowing what last night's check found — and, in preview, gets new results pushed into a running session.",
  },
  {
    slug: "check-every-release",
    title: "Check every release",
    description:
      "Add one step to your GitHub workflow and every deploy is checked the way a real user would use it — a broken release fails the job.",
  },
];

export const GUIDES_PATH = "/guides" as const;

export function guidePath(slug: string): `/${string}` {
  return `${GUIDES_PATH}/${slug}`;
}

export function guideBySlug(slug: string): Guide {
  const guide = GUIDES.find((g) => g.slug === slug);
  if (!guide) throw new Error(`No guide "${slug}" in src/lib/guides.ts`);
  return guide;
}
