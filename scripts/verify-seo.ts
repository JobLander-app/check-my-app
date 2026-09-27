// What the site tells a search engine about itself, checked two ways.
//
// On 2026-09-16 Search Console filed /check — then the page every link,
// funnel and experiment metric was keyed on — as "Duplicate without
// user-selected canonical". Nothing on the site had said which address was
// real: `/` sent a temporary redirect to /check, both were in the sitemap, no
// page carried a canonical tag, and http:// answered 200 instead of
// redirecting. The next day the owner removed the second address altogether:
// the form is the home page, there is no /check. Every one of those facts is
// pinned here.
//
// Static part (always): the source says one address per page.
// Live part (when SEO_SITE is set, e.g. SEO_SITE=https://checkmyapp.dev): the
// deployed site answers the way the source says it does. CI runs the static
// part; the live part is the post-deploy dogfood step (CLAUDE.md rule 7).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sitemap from "../src/app/sitemap";
import robots from "../src/app/robots";
import { HOME_PATH, PUBLIC_PATHS, SITE, canonical, pageMetadata } from "../src/lib/site-metadata";
import { GUIDES } from "../src/lib/guides";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function staticChecks() {
  const home = readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf8");
  check("the home page is a page, not a redirect", !/\bredirect\(|permanentRedirect\(/.test(home) && /<SubmitForm/.test(home));
  check("the home page declares its canonical", /canonical\(HOME_PATH\)/.test(home));
  check("HOME_PATH is `/` — the form has one address", HOME_PATH === "/");
  check("there is no /check route (owner, 2026-09-17)", !existsSync(path.join(repoRoot, "src/app/check")));

  const entries = sitemap();
  const urls = entries.map((e) => e.url);
  check("sitemap lists the home page at the root", urls.includes(`${SITE}/`));
  check("sitemap is exactly the public pages", urls.join(",") === PUBLIC_PATHS.map((p) => `${SITE}${p}`).join(","));
  check("no sitemap URL other than the root ends in a slash", urls.every((u) => u === `${SITE}/` || !u.endsWith("/")));
  check("home page has the top priority", entries.find((e) => e.url === `${SITE}/`)?.priority === 1);

  // CHE-318: the guides are listed from one array; each entry must have its
  // page and each page must name its own canonical, or the sitemap sends a
  // crawler to a 404 or a page that calls itself something else.
  for (const g of GUIDES) {
    const file = path.join(repoRoot, "src/app/guides", g.slug, "page.tsx");
    check(`guide ${g.slug} has a page`, existsSync(file));
    if (existsSync(file)) {
      check(`guide ${g.slug} names itself`, readFileSync(file, "utf8").includes(`guideMetadata("${g.slug}")`));
    }
  }
  check("the guides index exists", existsSync(path.join(repoRoot, "src/app/guides/page.tsx")));

  const md = pageMetadata({ title: "T", description: "D", path: "/faq" });
  check("pageMetadata names its own canonical", md.alternates?.canonical === "/faq");
  check("canonical() names the path it is given", canonical("/verdict/x").canonical === "/verdict/x");
  check("og:url and canonical agree", md.openGraph?.url === `${SITE}/faq`);

  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  for (const p of ["/dashboard", "/onboarding", "/api/", "/sign-in", "/run/", "/paid"]) {
    check(`robots keeps ${p} out`, disallow.includes(p));
  }
  for (const p of PUBLIC_PATHS) {
    check(`robots lets ${p} in`, !disallow.some((d) => p.startsWith(d)));
  }
  check("robots does not shut out verdicts (public by decision, 2026-09-05)", !disallow.some((d) => d.startsWith("/verdict")));
  check("robots points at the sitemap", r.sitemap === `${SITE}/sitemap.xml`);
}

async function head(url: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

async function liveChecks(site: string) {
  const origin = new URL(site);
  const httpOrigin = `http://${origin.host}`;

  const http = await head(`${httpOrigin}/faq`);
  check("live: http:// is a permanent redirect to https://", (http.status === 301 || http.status === 308) && (http.location ?? "").startsWith("https://"), `${http.status} ${http.location ?? ""}`);

  const slash = await head(`${site}/faq/`);
  check("live: a trailing slash redirects to the canonical", slash.status === 308 && !!slash.location && new URL(slash.location, site).pathname === "/faq", `${slash.status} ${slash.location ?? ""}`);

  const gone = await head(`${site}/check`);
  check("live: /check is gone (no second address for the form)", gone.status === 404, String(gone.status));

  for (const p of PUBLIC_PATHS) {
    const url = `${site}${p}`;
    const res = await fetch(url);
    const html = await res.text();
    const tag = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;
    check(`live: ${p} answers 200`, res.status === 200, String(res.status));
    // Next writes the root's canonical as the bare origin ("https://host"),
    // which RFC 3986 normalises to "https://host/" — one URL, two spellings.
    // Every other path must match to the character.
    const same = p === "/" ? tag === url || tag === site : tag === url;
    check(`live: ${p} declares itself canonical`, same, tag ?? "no canonical tag");
  }

  const robotsTxt = await (await fetch(`${site}/robots.txt`)).text();
  check("live: robots.txt names the sitemap", robotsTxt.includes(`Sitemap: ${site}/sitemap.xml`));
  check("live: robots.txt keeps the dashboard out", /Disallow:\s*\/dashboard/.test(robotsTxt));

  const sitemapXml = await (await fetch(`${site}/sitemap.xml`)).text();
  check("live: sitemap.xml lists the home page at the root", sitemapXml.includes(`<loc>${site}/</loc>`));
  check("live: sitemap.xml does not list /check", !sitemapXml.includes(`<loc>${site}/check</loc>`));
}

async function main() {
  staticChecks();
  const site = process.env.SEO_SITE?.replace(/\/$/, "");
  if (site) await liveChecks(site);
  else console.log("skip  live checks (set SEO_SITE=https://checkmyapp.dev to run them against a deployment)");
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
