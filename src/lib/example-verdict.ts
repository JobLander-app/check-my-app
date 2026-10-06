// GitHub issue #9 / CHE-108: a visitor had no way to see what a verdict looks
// like without handing over a link of their own. This is the one place that
// decides which public verdict stands in as the example.
//
// Requirements for the target:
//   - public, so it opens without signing in (every verdict does, by publicId);
//   - produced after the leak gate (src/lib/verdict-language.ts) existed, and
//     read once more by a person before it is linked here. The first target,
//     run #18 of theins.ru from 2026-08-16, was retired for a rule §1 leak in
//     a journey step ("This needs a real-browser check.") written before the
//     gate; the second, theins.ru run #143, for being someone else's product.
//
// Since CHE-421 the home page quotes the example on the page itself
// (src/lib/home-copy.ts, PROOF) — bottom line, one finding, the price — and
// this path is that run's verdict, so the excerpt and the link can never name
// two different checks.
//
// Current: joblander.app, run #312, "Needs attention", 2 findings, completed
// 2026-10-03. Our own product, so nobody else's finding is on our home page.
// Swap the run in home-copy.ts and nowhere else.
import { PROOF } from "@/lib/home-copy";

export const EXAMPLE_VERDICT_PATH = `/verdict/${PROOF.publicId}`;
