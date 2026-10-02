// Product → Journeys (CHE-362, phase 1): each journey of an app as the screens
// of the walk that last went through it.
//
//   1. The words: the header, the last-walked line, a journey with no walk.
//   2. The small copy of a screenshot: its address, made once, the original
//      when it cannot be made, nothing for a screenshot we do not hold.
//   3. The loader on a real D1: the newest walk in a finished, published check
//      — never a carried copy, never another team's, never another app's.
//   4. The page: behind the flag, pictures as small copies, no script.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journeys-page.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "../src/generated/prisma/client";
import { fileURLToPath } from "node:url";
import { failingLine, frameLabel, journeysHref, journeysLine, lastWalkedLabel, NOT_WALKED, sortJourneys, walkCountLabel } from "../src/lib/journeys-page";
import { journeysOfApp } from "../src/lib/journeys-load";
import { numbersForJourneys } from "../src/lib/journey-numbers-load";
import { extensionReportPublished } from "../src/lib/extension-target";
import { evidenceUrl, screenshotKeyOfThumb, thumbKeyOf, thumbUrl, THUMB_WIDTH } from "../src/lib/storage";
import { thumbnail, type ThumbResizer, type ThumbStore } from "../src/lib/thumbnail";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";

const hasLeak = (s: string) => hasEnvironmentLeak(s) || hasHomework(s);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The words ────────────────────────────────────────────────────────────
const now = new Date(Date.UTC(2026, 9, 2, 9));
const day = (d: number, month = 9) => new Date(Date.UTC(2026, month, d, 1));
const sentences = [
  journeysLine("checkmyapp.dev", 0, 0),
  journeysLine("checkmyapp.dev", 1, 1),
  journeysLine("checkmyapp.dev", 12, 12),
  journeysLine("checkmyapp.dev", 5, 4),
  journeysLine("checkmyapp.dev", 5, 1),
  journeysLine("checkmyapp.dev", 4, 0),
  lastWalkedLabel(day(2), now),
  lastWalkedLabel(day(1), now),
  lastWalkedLabel(day(28, 8), now),
  walkCountLabel(1),
  walkCountLabel(5),
  NOT_WALKED,
  failingLine(3, null, now)!,
  failingLine(3, day(28, 8), now)!,
  failingLine(1, day(1), now)!,
  frameLabel(1, 5, "Enter email and password"),
];
eq("header: no journeys", sentences[0], "No journeys of checkmyapp.dev yet. They appear after its first full check.");
eq("header: one", sentences[1], "1 journey of checkmyapp.dev, as the screens of its last walk.");
eq("header: all walked", sentences[2], "12 journeys of checkmyapp.dev, each as the screens of its last walk.");
eq("header: some walked", sentences[3], "5 journeys of checkmyapp.dev; 4 are shown as the screens of their last walk.");
eq("header: one walked", sentences[4], "5 journeys of checkmyapp.dev; 1 is shown as the screens of its last walk.");
eq("header: none walked", sentences[5], "4 journeys of checkmyapp.dev. None has been walked yet.");
eq("last walked: today", sentences[6], "Last walked today");
eq("last walked: yesterday", sentences[7], "Last walked yesterday");
eq("last walked: a date", sentences[8], "Last walked 28 September");
eq("last walked: a check with no finish time still reads", lastWalkedLabel(null, now), "Last walked");
eq("count: once", sentences[9], "walked once");
eq("count: many", sentences[10], "walked 5 times");
eq("count: none says nothing", walkCountLabel(0), "");
eq("no walk in a published check", sentences[11], "Not walked yet");
eq("in trouble: a check with no finish time still reads", sentences[12], "In trouble — 3 walks in a row.");
eq("in trouble: since a date, in a row", sentences[13], "In trouble since 28 September — 3 walks in a row.");
eq("in trouble: one walk", sentences[14], "In trouble since yesterday.");
eq("in trouble: a healthy last walk says nothing", failingLine(0, day(1), now), null);
eq("frame: its accessible name", sentences[15], "Step 2 of 5: Enter email and password");
eq("address: one app", journeysHref("app 1"), "/product/journeys?app=app%201");
check("no sentence of the page names how we check (CLAUDE.md §1)", sentences.every((s) => !hasLeak(s)), sentences.filter((s) => hasLeak(s)).join(" | "));
check("no sentence promises when a journey will be walked", sentences.every((s) => !/next (full )?check/i.test(s)));

const j = (id: string, status: string | null) => ({ id, walk: status ? { status } : null });
eq("order: by how the last walk ended, worst first, never-walked last, the catalog's order inside each",
  sortJourneys([j("ok1", "ok"), j("never", null), j("partial", "partial"), j("risky", "risky"), j("broken", "broken"), j("ok2", "ok"), j("confusing", "confusing")]).map((x) => x.id).join(","),
  "broken,risky,confusing,partial,ok1,ok2,never");

// ── 2. The small copy ───────────────────────────────────────────────────────
const HASH = "a".repeat(64);
const SHOT = `screenshots/${HASH}.png`;
const THUMB = `thumbs/${THUMB_WIDTH}/${HASH}.webp`;
eq("thumb key of a screenshot", thumbKeyOf(SHOT), THUMB);
eq("…and back", screenshotKeyOfThumb(THUMB), SHOT);
eq("another width is no thumbnail (the width is not the caller's to choose)", screenshotKeyOfThumb(`thumbs/2000/${HASH}.webp`), null);
eq("a key that is not a content hash is no thumbnail", screenshotKeyOfThumb("thumbs/480/../../private/x.webp"), null);
eq("a private artifact has no thumbnail", thumbKeyOf("private/runs/r/1.png"), null);
eq("a video has no thumbnail", thumbKeyOf("videos/x.webm"), null);
eq("a page's src for a screenshot is its small copy", thumbUrl(evidenceUrl(SHOT)), `/api/evidence/${THUMB}`);
eq("…and for an address that is not our screenshot, the address itself", thumbUrl("https://elsewhere.example/a.png"), "https://elsewhere.example/a.png");

const bytes = (n: number) => new Uint8Array(n).fill(7);
const stream = (b: Uint8Array) => new Response(b).body as ReadableStream<Uint8Array>;
function fakeStore(initial: Record<string, Uint8Array>) {
  const held = new Map(Object.entries(initial));
  const puts: string[] = [];
  const store: ThumbStore = {
    async get(key) {
      const b = held.get(key);
      return b ? { body: stream(b), httpEtag: `"etag-${key}"`, httpMetadata: { contentType: key.endsWith(".webp") ? "image/webp" : "image/png" } } : null;
    },
    async put(key, body) {
      puts.push(key);
      held.set(key, new Uint8Array(body));
    },
  };
  return { store, puts, held };
}
function fakeResizer(result: "small" | "throws" | "empty") {
  const calls: number[] = [];
  const resizer: ThumbResizer = {
    input: () => ({
      transform: ({ width }) => ({
        output: async () => {
          calls.push(width);
          if (result === "throws") throw new Error("9422: the month's transformations are used up");
          return { image: () => stream(bytes(result === "small" ? 64 : 0)) };
        },
      }),
    }),
  };
  return { resizer, calls };
}
const size = async (body: ReadableStream<Uint8Array> | ArrayBuffer) => (await new Response(body).arrayBuffer()).byteLength;

async function smallCopy() {
  const kept: Promise<unknown>[] = [];
  const keep = (p: Promise<unknown>) => void kept.push(p);

  const a = fakeStore({ [SHOT]: bytes(4000) });
  const ra = fakeResizer("small");
  const first = await thumbnail({ store: a.store, resizer: ra.resizer, thumbKey: THUMB, screenshotKey: SHOT, keep });
  await Promise.all(kept);
  eq("first request: resized to the one width", ra.calls.join(","), String(THUMB_WIDTH));
  eq("first request: the small copy is what is served", `${first?.kind} ${first?.contentType} ${await size(first!.body)}`, "thumb image/webp 64");
  eq("first request: …and it is stored beside the original", a.puts.join(","), THUMB);
  const second = await thumbnail({ store: a.store, resizer: ra.resizer, thumbKey: THUMB, screenshotKey: SHOT, keep });
  eq("second request: served from the store, not resized again", `${second?.kind} ${ra.calls.length} ${a.puts.length} ${second?.etag}`, `thumb 1 1 "etag-${THUMB}"`);

  const b = fakeStore({ [SHOT]: bytes(4000) });
  const none = await thumbnail({ store: b.store, resizer: null, thumbKey: THUMB, screenshotKey: SHOT, keep });
  eq("no resizer bound: the original stands in, and is not stored as the copy", `${none?.kind} ${none?.contentType} ${await size(none!.body)} ${b.puts.length}`, "original image/png 4000 0");

  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    for (const how of ["throws", "empty"] as const) {
      const c = fakeStore({ [SHOT]: bytes(4000) });
      const failed = await thumbnail({ store: c.store, resizer: fakeResizer(how).resizer, thumbKey: THUMB, screenshotKey: SHOT, keep });
      eq(`the resize ${how === "throws" ? "fails (the allowance is used up)" : "returns nothing"}: the original stands in, nothing is stored`,
        `${failed?.kind} ${await size(failed!.body)} ${c.puts.length}`, "original 4000 0");
    }
  } finally {
    console.error = realError;
  }
  eq("…and each failure is written to our log, not swallowed", errors.length, 2);

  const d = fakeStore({});
  eq("a screenshot we do not hold has no thumbnail", await thumbnail({ store: d.store, resizer: fakeResizer("small").resizer, thumbKey: THUMB, screenshotKey: SHOT, keep }), null);
}

// ── 3. The loader ───────────────────────────────────────────────────────────
async function loader() {
  const real = await realD1();
  try {
    const { db } = real;
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "journeys@example.test" } });
    await db.team.createMany({ data: [{ id: "t", name: "T", plan: "business" }, { id: "o", name: "Other", plan: "business" }] });
    await db.app.createMany({
      data: [
        { id: "a", teamId: "t", ownerId: "u", appSlug: "a.test", targetUrl: "https://a.test", targetKind: "website" },
        { id: "b", teamId: "t", ownerId: "u", appSlug: "b.test", targetUrl: "https://b.test", targetKind: "website" },
        { id: "e", teamId: "t", ownerId: "u", appSlug: "extension:abc", targetUrl: "https://chromewebstore.google.com/detail/abc", targetKind: "extension" },
        { id: "x", teamId: "o", ownerId: "u", appSlug: "x.test", targetUrl: "https://x.test", targetKind: "website" },
      ],
    });
    const at = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
    const run = (id: string, n: number, appId: string, teamId: string, d: number, over: object = {}) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId, appId, appSlug: `${appId}.test`, targetUrl: `https://${appId}.test`, targetKind: "website",
      status: "completed", verdict: "mostly_ok", priceUsd: 0.5, startedAt: at(d), createdAt: at(d), completedAt: at(d), ...over,
    });
    await db.run.createMany({
      data: [
        run("r1", 1, "a", "t", 10),
        run("r2", 2, "a", "t", 11),
        run("r3", 3, "a", "t", 12), // carries "signup" forward, walks "pay"
        run("r4", 4, "a", "t", 13, { status: "failed", verdict: null, priceUsd: null }), // walked both, published nothing
        run("r5", 5, "a", "t", 14, { status: "canceled", verdict: null, priceUsd: null }),
        run("y1", 6, "x", "o", 14), // another team's check
        run("b1", 7, "b", "t", 14), // the team's other app
        run("e1", 8, "e", "t", 14, { targetKind: "extension", verdict: null }), // an extension's check with no verdict
      ] as never,
    });
    const catalog = (id: string, appId: string, title: string, over: object = {}) => ({ id, appId, key: id, title, walkCount: 0, ...over });
    await db.appJourney.createMany({
      data: [
        // The catalog as the failed #4 left it: it walked "signup" and "pay",
        // found both broken, renamed one, moved the counters — and published
        // nothing. None of that may reach a card (Codex P1 on #256).
        catalog("signup", "a", "Sign up (as the failed check called it)", { walkCount: 3, lastWalkedRunId: "r4", failingSince: at(13), consecutiveBad: 1 }),
        catalog("pay", "a", "Pay", { walkCount: 3, lastWalkedRunId: "r4", failingSince: at(12), consecutiveBad: 2 }),
        catalog("never", "a", "Invite a teammate"),
        catalog("unfinished", "a", "Export a report", { walkCount: 1, lastWalkedRunId: "r5" }),
        catalog("listed", "a", "Change the plan", { walkCount: 1, lastWalkedRunId: "r1" }),
        catalog("streak", "a", "Reset the password", { walkCount: 3, lastWalkedRunId: "r3" }),
        catalog("retired", "a", "Old checkout", { walkCount: 9, retiredAt: at(9) }),
        catalog("b-home", "b", "Open the dashboard", { walkCount: 1 }),
        catalog("e-practice", "e", "Practice", { walkCount: 1 }),
        catalog("x-login", "x", "Their login", { walkCount: 1 }),
      ],
    });
    const walk = (id: string, runId: string, order: number, appJourneyId: string, status: string, over: object = {}) => ({ id, runId, order, title: appJourneyId, status, appJourneyId, journeyKey: appJourneyId, ...over });
    await db.journey.createMany({
      data: [
        walk("r1_signup", "r1", 0, "signup", "ok"),
        walk("r2_signup", "r2", 0, "signup", "partial", { title: "Sign up", summary: "Sign-up works up to the confirmation mail." }),
        // Healthy, then two unhealthy walks in a row.
        walk("r1_streak", "r1", 4, "streak", "ok"),
        walk("r2_streak", "r2", 4, "streak", "risky"),
        walk("r3_streak", "r3", 4, "streak", "broken"),
        walk("r2_pay", "r2", 1, "pay", "ok"),
        walk("r3_signup", "r3", 0, "signup", "partial", { carriedFromRunId: "r2" }),
        walk("r3_pay", "r3", 1, "pay", "broken"),
        // #3 listed this one and did not walk it: its walk is still #1's.
        walk("r1_listed", "r1", 3, "listed", "ok"),
        walk("r3_listed", "r3", 3, "listed", "skipped"),
        walk("r4_signup", "r4", 0, "signup", "broken"),
        walk("r4_pay", "r4", 1, "pay", "broken"),
        walk("r5_unfinished", "r5", 0, "unfinished", "ok"),
        walk("r2_retired", "r2", 2, "retired", "ok"),
        walk("y1_login", "y1", 0, "x-login", "ok"),
        walk("b1_home", "b1", 0, "b-home", "ok"),
        walk("e1_practice", "e1", 0, "e-practice", "ok"),
        // A row of another team's check that names this team's journey: the
        // statement is bound to the team, so it is never this journey's walk.
        walk("y1_signup", "y1", 1, "signup", "broken"),
      ],
    });
    const shot = (c: string) => `/api/evidence/screenshots/${c.repeat(64)}.png`;
    const step = (journeyId: string, order: number, label: string, status: string, screenshotUrl: string | null) => ({ id: `${journeyId}_s${order}`, journeyId, order, label, status, screenshotUrl });
    await db.step.createMany({
      data: [
        // Stored out of order: the strip is in step order whatever the rows' order.
        step("r2_signup", 2, "Confirm the email", "skipped", null),
        step("r2_signup", 0, "Open the sign-up page", "ok", shot("1")),
        step("r2_signup", 1, "Fill the form", "ok", shot("2")),
        step("r3_pay", 0, "Open pricing", "ok", shot("3")),
        step("r3_pay", 1, "Pay by card", "broken", "/api/evidence/private/runs/r3/pay.png"),
        step("r4_signup", 0, "Open the sign-up page", "broken", shot("4")),
        step("y1_signup", 0, "Their page", "broken", shot("5")),
        step("b1_home", 0, "Open the dashboard", "ok", shot("6")),
      ],
    });

    const cards = await journeysOfApp(db, "t", "a");
    eq("real D1: the app's live journeys in the catalog's order — not the retired one, not another app's", cards.map((c) => c.id).join(","), "signup,pay,never,unfinished,listed,streak");
    const [signup, pay, never, unfinished, listed, streak] = cards;
    eq("real D1: a check that failed after walking the journey moves nothing on its card — not the title, the count or the trouble mark",
      `${signup.title} | ${signup.walkCount} | ${signup.failingWalks} | ${signup.failingSince}`, "Sign up | 2 | 0 | null");
    eq("real D1: in trouble = the unhealthy walks that end the published history, since the day of the first of them",
      `${streak.walkCount} ${streak.failingWalks} ${streak.failingSince?.toISOString()}`, `3 2 ${at(11).toISOString()}`);
    eq("real D1: a check that listed the journey without walking it (skipped) is not its walk — the last real one is", `${listed.walk?.journeyId} #${listed.walk?.runNumber}`, "r1_listed #1");
    eq("real D1: the walk is the newest one in a finished check — not the carried copy in #3, not the failed #4, not another team's row",
      `${signup.walk?.journeyId} #${signup.walk?.runNumber} ${signup.walk?.status}`, "r2_signup #2 partial");
    eq("real D1: …with that check's own day, link and words", `${signup.walk?.at?.toISOString()} ${signup.walk?.publicId} ${signup.walk?.summary}`, `${at(11).toISOString()} p_r2 Sign-up works up to the confirmation mail.`);
    eq("real D1: its frames in step order", signup.walk?.frames.map((f) => f.label).join(" → "), "Open the sign-up page → Fill the form → Confirm the email");
    eq("real D1: a frame's picture is the small copy, its link the full screenshot", JSON.stringify(signup.walk?.frames[0].shot), JSON.stringify({ thumb: `/api/evidence/thumbs/${THUMB_WIDTH}/${"1".repeat(64)}.webp`, full: shot("1") }));
    eq("real D1: a step with no picture has none", signup.walk?.frames[2].shot, null);
    eq("real D1: another journey of the same check is its own walk", `${pay.walk?.journeyId} #${pay.walk?.runNumber} ${pay.walk?.status}`, "r3_pay #3 broken");
    eq("real D1: an address that is not a content-addressed screenshot is not shown as a picture", pay.walk?.frames[1].shot, null);
    eq("real D1: its count and trouble mark are the published walks' — #2 and #3, not the failed #4", `${pay.walkCount} ${pay.failingWalks} ${pay.failingSince?.toISOString()}`, `2 1 ${at(12).toISOString()}`);
    eq("real D1: a journey never walked has no walk", `${never.walk} ${never.walkCount}`, "null 0");
    eq("real D1: a journey walked only by a check that did not finish is not walked (rule 4)", `${unfinished.walk} ${unfinished.walkCount} ${unfinished.title}`, "null 0 Export a report");
    check("real D1: nothing of another team's is in it", !JSON.stringify(cards).includes("Their") && !JSON.stringify(cards).includes("5".repeat(64)));

    eq("real D1: another team asking for this app gets nothing — not its walks, not the names of its journeys", (await journeysOfApp(db, "o", "a")).length, 0);
    eq("real D1: the team's other app has its own", (await journeysOfApp(db, "t", "b")).map((c) => `${c.id} #${c.walk?.runNumber}`).join(","), "b-home #7");
    const ext = await journeysOfApp(db, "t", "e");
    eq("real D1: an extension's check with no verdict shows nothing", ext.map((c) => String(c.walk)).join(","), "null");
    eq("…which is what extensionReportPublished says of that check", extensionReportPublished({ targetKind: "extension", status: "completed", verdict: null }), false);
    eq("real D1: an app with no journeys", (await journeysOfApp(db, "t", "nope")).length, 0);

    // At real size: more journeys than D1 binds values in one statement.
    await db.appJourney.createMany({ data: Array.from({ length: 130 }, (_, i) => catalog(`many${i}`, "b", `Journey ${i}`, { walkCount: 1 })) });
    await db.journey.createMany({ data: Array.from({ length: 130 }, (_, i) => walk(`b1_many${i}`, "b1", i + 1, `many${i}`, "ok")) });
    await db.step.createMany({ data: Array.from({ length: 130 }, (_, i) => step(`b1_many${i}`, 0, `Open ${i}`, "ok", shot("7"))) });
    const many = await journeysOfApp(db, "t", "b");
    eq("real D1: 131 journeys, each with its walk and its frame", `${many.length} ${many.filter((c) => c.walk?.frames.length === 1).length}`, "131 131");
    // …and the numbers block's loader, asked about all of them as the page asks (Codex P2 on #256).
    const numbers = await numbersForJourneys(db, many.map((c) => ({ id: c.walk!.journeyId, appJourneyId: c.id, status: c.walk!.status })));
    eq("real D1: the two numbers are read for all 131", Object.keys(numbers).length, 131);
    // Why neither loader cuts its lists itself: the cap is on a statement's
    // bound values, this database enforces it, and Prisma splits a model
    // query's `in` list under it — merging the parts itself, so every column
    // the query orders by has to be selected (one that is not aborts the query
    // engine with "unreachable"; seen here before `order` was selected, which
    // is why this cannot be a case of its own: it takes the process down). A
    // raw statement is not split — which is why the one raw statement above
    // binds two values, whatever the app's size.
    const ids = many.map((c) => c.walk!.journeyId);
    let rawRefused = "";
    try {
      await db.$queryRaw(Prisma.sql`SELECT id FROM "Step" WHERE journeyId IN (${Prisma.join(ids)})`);
    } catch (err) {
      rawRefused = err instanceof Error ? err.message : String(err);
    }
    check("real D1: a raw statement with 131 bound values is refused — the cap is real here", /too many SQL variables/i.test(rawRefused), rawRefused.slice(0, 120));
    eq("real D1: …and a model query with the same list is split by Prisma, ordered, when what it orders by is selected",
      (await db.step.findMany({ where: { journeyId: { in: ids } }, orderBy: [{ journeyId: "asc" }, { order: "asc" }], select: { id: true, journeyId: true, order: true } })).length, 131);
  } finally {
    await real.dispose();
  }
}

// ── 4. The page ─────────────────────────────────────────────────────────────
const lib = read("src/lib/journeys-load.ts");
check("the loader holds no nested journey → steps select", !/steps:\s*\{/.test(lib) && !/checks:\s*\{/.test(lib));
check("its raw statement binds the team, and its checks are read as the team's", /r\.teamId = \$\{teamRows\(teamId\)\}/.test(lib) && /\.\.\.teamOwned\(teamId\), id: \{ in: runIds \}/.test(lib));
check("the catalog is read through an app of the team", /where: \{ appId, retiredAt: null, app: \{ \.\.\.teamOwned\(teamId\) \} \}/.test(lib));
check("its one raw statement binds no list (a raw statement's values are not split under D1's cap)", (lib.match(/\$queryRaw/g) ?? []).length === 1 && !/Prisma\.join/.test(lib));
check("the steps are ordered by columns the query selects", /orderBy: \[\{ journeyId: "asc" \}, \{ order: "asc" \}\],\s*select: \{ id: true, journeyId: true, order: true,/.test(lib));
const numbersLib = read("src/lib/journey-numbers-load.ts");
check("…and so are the numbers block's last steps", /select: \{ journeyId: true, order: true, status: true, unverifiedReason: true \},\s*orderBy: \{ order: "desc" \}/.test(numbersLib));
check("a carried copy is never the walk, nor a row the check skipped", /j\.carriedFromRunId IS NULL AND j\.status <> 'skipped'/.test(lib));
check("only a finished check, and not an extension's without a verdict", /r\.status IN \('completed', 'partial'\)/.test(lib) && /r\.targetKind <> 'extension' OR \(r\.verdict IS NOT NULL AND r\.verdict <> ''\)/.test(lib));
check("the loader reads no cost (CLAUDE.md §10)", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(lib));
const loaderBody = lib.slice(lib.indexOf("export async function journeysOfApp"));
check("nothing on a card is read from the catalog's counters, which an unpublished check moves too",
  /select: \{ id: true, title: true \},/.test(loaderBody) && !/walkCount: true|failingSince: true|consecutiveBad|lastWalked/.test(loaderBody));

const page = read("src/app/(app)/product/journeys/page.tsx");
check("the page does not exist for whoever lacks the lens", /if \(!\(await productLensFor\(user\)\)\) notFound\(\);/.test(page) && page.indexOf("productLensFor(user)") < page.indexOf("journeysOfApp("));
check("an app from the address that is not the team's is no choice", /shell\.apps\.find\(\(a\) => a\.id === appParam\) \?\? shell\.apps\[0\] \?\? null/.test(page));
check("the walk opens its check inside the app", /href=\{appPath\.check\(app\.id, j\.walk\.runNumber\)\}/.test(page));
check("the two numbers come from the verdict's own block, in its words", /numbersForJourneys\(/.test(page) && /<JourneyNumbersBlock \{\.\.\.journeyNumbers\} title=\{j\.title\} \/>/.test(page));
check("the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));

const strip = read("src/components/filmstrip.tsx");
check("the strip is server-rendered: no client code, no effect", !/^"use client"/.test(strip) && !/useEffect|useState/.test(strip));
check("a frame's picture is the small copy, loaded when it comes into view; its link is the full screenshot",
  /src=\{frame\.shot\.thumb\}/.test(strip) && /loading="lazy"/.test(strip) && /href=\{frame\.shot\.full\}/.test(strip) && !/src=\{frame\.shot\.full\}/.test(strip));
check("every picture has its step's words as its name", /alt=\{name\}/.test(strip) && /frameLabel\(i, frames\.length, frame\.label\)/.test(strip));
check("the strip scrolls sideways with snap", /snap-x snap-mandatory/.test(strip) && /snap-start/.test(strip) && /overflow-x-auto/.test(strip));

const route = read("src/app/api/evidence/[...path]/route.ts");
check("private artifacts are refused before anything else is read", route.indexOf('key.startsWith("private/")') < route.indexOf("screenshotKeyOfThumb(key)"));
check("a stand-in original is cached briefly; the small copy for good",
  /answer\.kind === "thumb" \? "private, max-age=31536000, immutable" : "private, max-age=300"/.test(route));
const wrangler = read("wrangler.jsonc");
check("the web worker binds the resizer", /"images":\s*\{\s*"binding":\s*"IMAGES"\s*\}/.test(wrangler));
const ephemeral = read("src/lib/ephemeral.ts");
check("a deleted screenshot takes its small copy with it", /const thumbs = keys\.map\(\(k\) => thumbKeyOf\(k\)\)/.test(ephemeral) && /deleteObjects\(evidenceBucket, \[\.\.\.keys, \.\.\.thumbs\]\)/.test(ephemeral));

smallCopy()
  .then(loader)
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
