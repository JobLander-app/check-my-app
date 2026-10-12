// CHE-238 verification: the funnel we derive from a walk.
//
// Everything downstream of `deriveFunnel` is a claim about the customer's
// product — "of 100 who start this, 12 finish". A funnel derived badly does not
// look wrong on screen; it looks like the customer converting badly. That is
// rule 8's failure exactly, so most of these checks are about REFUSING.
//
// The three headline cases are real walks of joblander.app, read out of
// production D1 on 2026-09-16 (journey ids in each case). They are here rather
// than invented inputs because two of the three would have been got wrong by a
// derivation reasoned out at a desk.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-funnel.ts

import {
  MAX_FUNNEL_STAGES,
  deriveFunnel,
  funnelDrifted,
  pagesWalked,
  refusalReason,
} from "@/lib/funnel";
import { normalizePath, requestSignature } from "@/lib/dedup";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** The shape `Step.actions` actually stores — only `outcome.urlAfter` matters here. */
const walk = (...urls: string[]) => urls.map((u) => ({ outcome: { urlAfter: u } }));

// ── Real trails, exactly as production recorded them ────────────────────────

// Journey cmu052gch000fvl0na86nvs7a — "Try the AI interview coach demo"
const REAL_DEMO = walk(
  "https://joblander.app/", "https://joblander.app/", "https://joblander.app/", "https://joblander.app/",
  "https://joblander.app/practice", "https://joblander.app/practice", "https://joblander.app/practice",
  "https://joblander.app/login?back=%2Fpractice", "https://joblander.app/login?back=%2Fpractice",
  "https://joblander.app/login?back=%2Fpractice", "https://joblander.app/login?back=%2Fpractice",
);

// Journey cmu30dsuf00281q0nvcpiwfg3 — "Tutorial onboarding for new users"
const REAL_TUTORIALS = walk(
  "https://joblander.app/",
  ...Array(10).fill("https://joblander.app/login"),
  "https://joblander.app/dashboard",
  "https://joblander.app/first-time",
  "https://joblander.app/tutorials",
  "https://joblander.app/tutorials/101-getting-live-insights",
  "https://joblander.app/tutorials/mirror-mode",
  "https://joblander.app/tutorials/102-personalize-ai-responses",
  "https://joblander.app/tutorials/my-stories",
  "https://joblander.app/tutorials/103-safe-practice-mock-interviews",
  "https://joblander.app/tutorials/104-reviewing-performance",
);

// Journey cmtudg58a0023zu0ntthgsyin — "Explore the app in different languages"
const REAL_I18N = walk(
  "https://joblander.app/",
  "https://joblander.app/de", "https://joblander.app/de/about", "https://joblander.app/de/login",
  "https://joblander.app/es", "https://joblander.app/es/about", "https://joblander.app/es/tutorials",
  "https://joblander.app/es/terms",
  ...Array(8).fill("https://joblander.app/es/login"),
);

function main() {
  console.log("Real walk A — the AI interview coach demo (a funnel, and a good one)");
  {
    const f = deriveFunnel(REAL_DEMO);
    check("it is a funnel", f.ok, JSON.stringify(f.stages));
    check("three stages: landing, the thing, the login wall",
      f.stages.join(" → ") === "/ → /practice → /login", f.stages.join(" → "));
    check("the query string is gone — ?back=%2Fpractice is not a different page",
      !f.stages.some((s) => s.includes("?")), f.stages.join(","));
    check("the four repeats of / collapsed to one stage",
      f.stages.filter((s) => s === "/").length === 1);
  }

  console.log("\nReal walk B — tutorial onboarding (six siblings must not become six stages)");
  {
    const raw = pagesWalked(REAL_TUTORIALS);
    check("the raw walk really does contain six sibling tutorial pages",
      new Set(raw.filter((p) => p.startsWith("/tutorials/"))).size === 6,
      String(new Set(raw.filter((p) => p.startsWith("/tutorials/"))).size));

    const f = deriveFunnel(REAL_TUTORIALS);
    check("it is a funnel", f.ok, JSON.stringify(f.stages));
    check("the six tutorials collapse into the one stage that means 'reached the tutorials'",
      f.stages.join(" → ") === "/ → /login → /dashboard → /first-time → /tutorials",
      f.stages.join(" → "));
    check("…so no individual tutorial page survives as a stage",
      !f.stages.some((s) => s.startsWith("/tutorials/")), f.stages.join(","));
    check("ten consecutive /login records are one stage",
      f.stages.filter((s) => s === "/login").length === 1);
  }

  console.log("\nReal walk C — i18n exploration (a wander, not a funnel)");
  {
    const f = deriveFunnel(REAL_I18N);
    check("it is refused", !f.ok, f.ok ? "accepted" : f.refusal);
    check("…because the walk doubled back", !f.ok && f.refusal === "revisits");
    check("…and the refusal is about US, not the customer",
      /\bours\b|\bwe\b|the walk/.test(refusalReason("revisits")), refusalReason("revisits"));
    check("the stages we did see are still reported, so the gap ticket can say what we saw",
      f.stages.length > 0, JSON.stringify(f.stages));
    // The locale prefix is why it doubles back: /de/about and /es/about are one page.
    check("the locale prefix is what makes them the same page",
      normalizePath("https://joblander.app/de/about") === normalizePath("https://joblander.app/es/about"),
      normalizePath("https://joblander.app/de/about"));
  }

  console.log("\nA walk that ends by going back is a path that ended (the gap filed from run #204 on)");
  {
    const form = deriveFunnel(walk(
      "https://checkmyapp.dev/check", "https://checkmyapp.dev/check?url=x", "https://checkmyapp.dev/checks/today",
      "https://checkmyapp.dev/verdict/cmu3hza4l0003oo1oreo67pde", "https://checkmyapp.dev/check",
    ));
    check("form → verdict → back to the form is a funnel, without the way back",
      form.ok && form.stages.join(" → ") === "/check → /checks/today → /verdict/:id", JSON.stringify(form));

    const signIn = deriveFunnel(walk(
      "https://checkmyapp.dev/check", "https://checkmyapp.dev/login", "https://checkmyapp.dev/dashboard",
      "https://checkmyapp.dev/check",
    ));
    check("sign in, then back to where it began, is a funnel",
      signIn.ok && signIn.stages.join(" → ") === "/check → /login → /dashboard", JSON.stringify(signIn));

    const pingPong = deriveFunnel(walk("https://x.dev/list", "https://x.dev/item/1", "https://x.dev/list", "https://x.dev/item/2"));
    check("list → item → list → another item ends on pages already seen: list → item",
      pingPong.ok && pingPong.stages.join(" → ") === "/list → /item/:id", JSON.stringify(pingPong));

    const middle = deriveFunnel(walk("https://x.dev/a", "https://x.dev/b", "https://x.dev/a", "https://x.dev/c"));
    check("doubling back and then going somewhere new is still a wander",
      !middle.ok && middle.refusal === "revisits", JSON.stringify(middle));

    const onlyBack = deriveFunnel(walk("https://x.dev/a", "https://x.dev/a"));
    check("going back does not turn one page into two",
      !onlyBack.ok && onlyBack.refusal === "single_stage", JSON.stringify(onlyBack));

    const long = deriveFunnel(walk(...Array.from({ length: MAX_FUNNEL_STAGES + 1 }, (_, i) => `https://x.dev/p${i}`), "https://x.dev/p0"));
    check("a way back does not rescue an itinerary",
      !long.ok && long.refusal === "wandering", JSON.stringify(long));
  }

  console.log("\nRefusing is the point");
  {
    check("one page is arrival, not conversion",
      deriveFunnel(walk("https://x.dev/pricing")).ok === false);
    check("…and says which refusal it is",
      (deriveFunnel(walk("https://x.dev/pricing")) as { refusal: string }).refusal === "single_stage");
    check("the same page twice is still one page",
      (deriveFunnel(walk("https://x.dev/a", "https://x.dev/a")) as { refusal: string }).refusal === "single_stage");
    check("a walk with no pages refuses rather than returning an empty funnel",
      (deriveFunnel([]) as { refusal: string }).refusal === "no_pages");
    check("actions with no urlAfter are not pages",
      (deriveFunnel([{ outcome: null }, { outcome: { urlAfter: "" } }]) as { refusal: string }).refusal === "no_pages");

    const long = walk(...Array.from({ length: MAX_FUNNEL_STAGES + 1 }, (_, i) => `https://x.dev/p${i}`));
    check("an itinerary is not a funnel",
      (deriveFunnel(long) as { refusal: string }).refusal === "wandering",
      String(pagesWalked(long).length));
    const atCap = walk(...Array.from({ length: MAX_FUNNEL_STAGES }, (_, i) => `https://x.dev/p${i}`));
    check("…but exactly the cap is still a funnel", deriveFunnel(atCap).ok);

    // Every refusal must have a sentence, or a gap ticket would say nothing.
    for (const r of ["no_pages", "single_stage", "revisits", "wandering"] as const) {
      check(`"${r}" has a reason a human can read`, refusalReason(r).length > 20);
    }
  }

  console.log("\nDrift means the shape CHANGED, not merely that the walk differed");
  {
    check("same shape is no drift", !funnelDrifted(["/", "/a"], ["/", "/a"]));
    check("a reordered funnel is drift — that is a different conversion path",
      funnelDrifted(["/", "/a", "/b"], ["/", "/b", "/a"]));
    check("a renamed stage is drift", funnelDrifted(["/", "/a"], ["/", "/aa"]));
    check("a wholly different path is drift", funnelDrifted(["/a", "/b"], ["/x", "/y"]));

    // The real case, from two consecutive production runs of the same journey.
    // Reporting this as drift would make the flag fire on ordinary entry-point
    // variance — and a flag that fires on everything hides the real change.
    check("entering from one page further back is NOT drift (run #204 vs #205)",
      !funnelDrifted(["/checks/today", "/verdict/:id"], ["/check", "/checks/today", "/verdict/:id"]));
    check("a walk that skipped a middle stage is NOT drift",
      !funnelDrifted(["/", "/a", "/b"], ["/", "/b"]));
    check("an extra stage in the middle is NOT drift",
      !funnelDrifted(["/", "/b"], ["/", "/a", "/b"]));
    check("…but dropping a stage AND reordering the rest is",
      funnelDrifted(["/", "/a", "/b"], ["/b", "/"]));
  }

  console.log("\nThe shared normaliser did not change under the tickets keyed on it");
  {
    // requestSignature now calls normalizePath. Every OPEN ticket's dedup key
    // was computed with the old inline version, so its output must be
    // unchanged — including the trailing slash it deliberately does not strip.
    check("a path with ids collapses as before",
      requestSignature(["GET https://joblander.app/api/users/12345/profile returned 500"]) ===
        "GET /api/users/:id/profile 500",
      String(requestSignature(["GET https://joblander.app/api/users/12345/profile returned 500"])));
    check("a locale prefix drops as before",
      requestSignature(["GET /de/api/thing 404"]) === "GET /api/thing 404",
      String(requestSignature(["GET /de/api/thing 404"])));
    check("a trailing slash is still NOT stripped, so open tickets do not refile",
      requestSignature(["POST /api/checks/ 502"]) === "POST /api/checks/ 502",
      String(requestSignature(["POST /api/checks/ 502"])));
    // …while the funnel does strip it, which is why it lives on the funnel side.
    check("the funnel treats /pricing and /pricing/ as one page",
      (deriveFunnel(walk("https://x.dev/", "https://x.dev/pricing", "https://x.dev/pricing/")) as { stages: string[] })
        .stages.join(" → ") === "/ → /pricing",
      JSON.stringify(deriveFunnel(walk("https://x.dev/", "https://x.dev/pricing", "https://x.dev/pricing/")).stages));
  }

  console.log("\nA funnel must not carry one visit's ids (found by running this over all 180 real trails)");
  {
    // Both of these came out of production as derived funnels before the fix.
    // Stored, each would drift on the next run — and "how many people reached
    // /practice/coaching_1788470882972" measures one session of one walk.
    const session = deriveFunnel(walk("https://joblander.app/dashboard", "https://joblander.app/practice/coaching_1788470882972"));
    check("a session id in a segment collapses",
      session.stages.join(" → ") === "/dashboard → /practice/:id", JSON.stringify(session.stages));

    const cuid = deriveFunnel(walk("https://checkmyapp.dev/check", "https://checkmyapp.dev/dashboard/cmtmsvbyx0001rz1tkzevj5dc"));
    check("a cuid collapses",
      cuid.stages.join(" → ") === "/check → /dashboard/:id", JSON.stringify(cuid.stages));

    const runA = deriveFunnel(walk("https://x.dev/a", "https://x.dev/s/coaching_1788470882972"));
    const runB = deriveFunnel(walk("https://x.dev/a", "https://x.dev/s/coaching_1799999999999"));
    check("…so two walks of the same journey agree, which is what makes a comparison mean anything",
      !funnelDrifted(runA.stages, runB.stages), `${runA.stages.join(",")} vs ${runB.stages.join(",")}`);

    // The rules erase distinctions, so they must stay narrow: a version, a year
    // and a numbered slug are part of a page's NAME, not one visit's identity.
    check("a short number in a slug survives — /tutorials/101-getting-live-insights is a page",
      pagesWalked(walk("https://x.dev/tutorials/101-getting-live-insights"))[0] === "/tutorials/101-getting-live-insights",
      pagesWalked(walk("https://x.dev/tutorials/101-getting-live-insights"))[0]);
    // A bare numeric segment was already an ":id" under the shared normaliser
    // long before this ticket, so a year-partitioned path collapses too. Left
    // as it is rather than special-cased: for a funnel "the blog archive" is
    // one stage whichever year it is, and carving an exception into a rule the
    // signatures also use is how the two start disagreeing.
    check("a bare year collapses, like every other bare number (pre-existing)",
      pagesWalked(walk("https://x.dev/blog/2026/review"))[0] === "/blog/:id/review",
      pagesWalked(walk("https://x.dev/blog/2026/review"))[0]);
    check("a word that merely starts with c is not a cuid",
      pagesWalked(walk("https://x.dev/checkout"))[0] === "/checkout");
  }

  console.log("\nThe derivation is a function of the walk and nothing else");
  {
    const once = deriveFunnel(REAL_TUTORIALS);
    const twice = deriveFunnel(REAL_TUTORIALS);
    check("the same walk gives the same funnel — the ticket's 'identical on two consecutive runs'",
      JSON.stringify(once) === JSON.stringify(twice));
    check("ids in a path collapse, so /orders/991 and /orders/992 are one stage",
      (deriveFunnel(walk("https://x.dev/", "https://x.dev/orders/991", "https://x.dev/orders/992")) as { stages: string[] })
        .stages.join(" → ") === "/ → /orders/:id",
      JSON.stringify(deriveFunnel(walk("https://x.dev/", "https://x.dev/orders/991", "https://x.dev/orders/992")).stages));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
