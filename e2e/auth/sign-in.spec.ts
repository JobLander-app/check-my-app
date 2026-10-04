import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Dogfood: CheckMyApp checks its own auth (CHE-35). The agent-walkable path is
// email + Clerk testing helpers (NOT Google OAuth, which isn't browser-drivable).
// Proves: a signed-in owner reaches the protected app (since CHE-348 the old
// /dashboard address redirects to /home, the Today page); the anonymous funnel
// and route protection both behave.
const BASE = process.env.TARGET_URL ?? "http://localhost:3000";

test("protected /dashboard redirects an anonymous visitor to /sign-in", async ({ page }) => {
  const res = await page.goto(`${BASE}/dashboard`);
  await expect(page).toHaveURL(/\/sign-in/);
  expect(res?.status()).toBeLessThan(400);
});

test("owner signs in (email) and reaches the protected app", async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/`); // load Clerk on a public page first

  // Email/ticket strategy: the helper finds the user and mints a backend sign-in
  // token — independent of which sign-in factors are enabled, and it sets the
  // session cookie the SSR middleware reads.
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });

  // The old address still works for a signed-in person: it lands on Today.
  // The landmark is the app shell's sidebar (aside "Main" with the Today
  // link), which every signed-in page carries — the page's own heading
  // depends on what the team has been checking.
  await page.goto(`${BASE}/dashboard`);
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole("complementary", { name: "Main" }).getByRole("link", { name: "Today" })).toBeVisible();
});
