// CHE-156 acceptance: a self-check is identified by its TARGET, and a run of
// our own product neither mails anyone nor lands in a customer number.
//
// The defect this proves gone: CLAUDE.md §6 promised silence and keyed it on
// `User.isTestAccount`, while checkmyapp.dev — the app the rule was written for
// — belongs to the owner's ordinary account (isTestAccount = 0). In production
// that meant 30 runs and 66 findings on our own product, 29 of those runs
// carrying a notifyEmail; on 2026-09-07 run #156 mailed the owner a `broken`
// verdict about a sign-in page our own checker had broken.
//
// Everything below drives the real functions:
//   - notifyVerdictReady (src/agent/notify-verdict.ts) against a stub database
//     and a stub fetch, so "an email was sent" means a request to Resend was
//     actually made;
//   - isSelfHost (src/agent/self-hosts.ts), the one predicate that answers
//     "is this ours", on the four production slugs;
//   - sweepTestAccounts (src/agent/janitor.ts), to hold the boundary that the
//     test account's placeholder is still swept and our own app never is.
//
// Two things cannot be driven — a page that needs a Next request scope, and a
// measurement script that queries D1 at import time — so for those the source
// is the evidence, the same way verify-self-check-guard.ts reads the guard's
// position in each handler.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-silence.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isOwnRun,
  notifyVerdictReady,
  silenceReason,
  type NotifiableRun,
} from "@/agent/notify-verdict";
import { isSelfHost } from "@/agent/self-hosts";
import { sweepTestAccounts } from "@/agent/janitor";
import type { AgentBindings, AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// ─── The notify gate, driven ─────────────────────────────────────────────────
// One stub database and one stub fetch. The only observable that matters is
// whether a POST to Resend happened.

interface Scenario {
  targetUrl: string;
  appSlug: string;
  isTestAccount: boolean;
  selfCheckHosts?: string;
  notifyEmail?: string | null;
  // Default: a signed-in run. `null` is the public home-page form's anonymous run.
  ownerId?: string | null;
  watchId?: string | null;
  baselineRunId?: string | null;
  notifyOnChangeOnly?: boolean;
  baselineVerdict?: string | null;
}

async function didEmail(s: Scenario): Promise<{ sent: boolean; log: string[] }> {
  const run: NotifiableRun = {
    publicId: "pub_1",
    appSlug: s.appSlug,
    targetUrl: s.targetUrl,
    notifyEmail: s.notifyEmail === undefined ? "owner@example.com" : s.notifyEmail,
    ownerId: s.ownerId === undefined ? "u_owner" : s.ownerId,
    watchId: s.watchId ?? null,
    baselineRunId: s.baselineRunId ?? null,
  };
  const db = {
    run: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { publicId?: string; id?: string };
        select: Record<string, unknown>;
      }) => {
        if ("owner" in select) return { owner: { isTestAccount: s.isTestAccount } };
        if ("verdict" in select) return { verdict: s.baselineVerdict ?? null };
        if (where.publicId !== "pub_1") return null;
        return { bottomLine: "Everything we walked worked.", findings: [{ category: "broken" }] };
      },
    },
    watch: {
      findUnique: async () => ({ notifyOnChangeOnly: Boolean(s.notifyOnChangeOnly) }),
    },
  };
  const env = { db } as unknown as AgentEnv;
  const bindings = {
    EMAIL_API_KEY: "re_stub",
    EMAIL_FROM: "checks@checkmyapp.dev",
    APP_URL: "https://checkmyapp.dev",
    SELF_CHECK_HOSTS: s.selfCheckHosts,
  } as unknown as AgentBindings;

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const log: string[] = [];
  let sent = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("api.resend.com")) sent = true;
    return new Response(JSON.stringify({ id: "stub" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => log.push(args.map(String).join(" "));
  try {
    await notifyVerdictReady(env, bindings, run, "broken");
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return { sent, log };
}

async function main(): Promise<void> {
  console.log("\n1 — the notify gate, driven through the real notifyVerdictReady\n");

  for (const isTestAccount of [false, true]) {
    const who = isTestAccount ? "a test account" : "the owner's ordinary account";
    for (const [label, targetUrl, hosts] of [
      ["our production host", "https://checkmyapp.dev/", undefined],
      ["a subdomain of ours", "https://www.checkmyapp.dev/dashboard", undefined],
      [
        "a SELF_CHECK_HOSTS preview host",
        "https://pr-42.checkmyapp-web.pages.dev/",
        "checkmyapp-web.pages.dev",
      ],
    ] as const) {
      const { sent, log } = await didEmail({
        targetUrl,
        appSlug: new URL(targetUrl).host,
        isTestAccount,
        selfCheckHosts: hosts,
      });
      check(`${label}, our run, owned by ${who}: no email`, !sent);
      check(
        `${label}, our run, owned by ${who}: the log names the reason`,
        log.some((l) => l.includes("staying silent") && l.includes("our own product, checked by us")),
        log.join(" | ") || "(no log line)",
      );
    }
  }

  // Our host, a watch's run, nobody signed in as its owner: still ours.
  {
    const { sent, log } = await didEmail({
      targetUrl: "https://checkmyapp.dev/",
      appSlug: "checkmyapp.dev",
      isTestAccount: false,
      ownerId: null,
      watchId: "w_self",
    });
    check("our host, a watch run with no owner: no email", !sent);
    check(
      "our host, a watch run: the log names the reason",
      log.some((l) => l.includes("our own product, checked by us")),
      log.join(" | ") || "(no log line)",
    );
  }

  // Our host, somebody else's run. Pointing the public checker at the checker is
  // an ordinary first run, and it gets its mail (team-lead ruling, 2026-09-08).
  for (const [label, targetUrl] of [
    ["our production host", "https://checkmyapp.dev/"],
    ["a subdomain of ours", "https://www.checkmyapp.dev/"],
  ] as const) {
    const { sent, log } = await didEmail({
      targetUrl,
      appSlug: new URL(targetUrl).host,
      isTestAccount: false,
      ownerId: null,
      watchId: null,
    });
    check(`${label}, anonymous visitor's run with an address: email is sent`, sent);
    check(
      `${label}, anonymous visitor's run: nothing was silenced`,
      !log.some((l) => l.includes("staying silent")),
      log.join(" | "),
    );
  }

  // The boundary from the ticket: two real observed apps on the SAME account.
  for (const [slug, url] of [
    ["joblander.app", "https://joblander.app/"],
    ["meetbashar.com", "https://meetbashar.com/"],
  ] as const) {
    const { sent } = await didEmail({ targetUrl: url, appSlug: slug, isTestAccount: false });
    check(`${slug} on the owner's account still emails`, sent);
  }

  // A look-alike host is a customer, not us — the dot-boundary rule, reached
  // through the gate rather than through the predicate alone.
  {
    const { sent } = await didEmail({
      targetUrl: "https://evil-checkmyapp.dev/",
      appSlug: "evil-checkmyapp.dev",
      isTestAccount: false,
    });
    check("a look-alike host (evil-checkmyapp.dev) still emails", sent);
  }

  // The old marker still works where it is the only one: a placeholder the
  // self-check registers is not on our hosts, and must stay silent.
  {
    const { sent, log } = await didEmail({
      targetUrl: "https://example.com/",
      appSlug: "example.com",
      isTestAccount: true,
    });
    check("a test-account placeholder (example.com) stays silent", !sent);
    check(
      "the placeholder's log line names the account, not the product",
      log.some((l) => l.includes("staying silent") && l.includes("a self-check account")),
      log.join(" | ") || "(no log line)",
    );
  }

  // The gates that already existed still gate.
  {
    const { sent } = await didEmail({
      targetUrl: "https://joblander.app/",
      appSlug: "joblander.app",
      isTestAccount: false,
      notifyEmail: null,
    });
    check("no address on the run: nothing is sent", !sent);

    const quiet = await didEmail({
      targetUrl: "https://joblander.app/",
      appSlug: "joblander.app",
      isTestAccount: false,
      watchId: "w1",
      baselineRunId: "r0",
      notifyOnChangeOnly: true,
      baselineVerdict: "broken",
    });
    check("a notifyOnChangeOnly watch on an unchanged verdict still stays quiet", !quiet.sent);
  }

  // The rule as a value, so a caller cannot read it differently from the gate.
  check(
    "silenceReason: our host + our run wins over the account flag",
    silenceReason({
      targetUrl: "https://checkmyapp.dev/",
      ownRun: true,
      ownedByTestAccount: true,
    }) === "our own product, checked by us",
  );
  check(
    "silenceReason: our host + a visitor's run is a different answer — not silent",
    silenceReason({
      targetUrl: "https://checkmyapp.dev/",
      ownRun: false,
      ownedByTestAccount: false,
    }) === null,
  );
  check(
    "silenceReason: a customer host on an ordinary account is not silenced",
    silenceReason({
      targetUrl: "https://joblander.app/",
      ownRun: true,
      ownedByTestAccount: false,
    }) === null,
  );
  check(
    "silenceReason: an unparsable target is not silently treated as ours",
    silenceReason({ targetUrl: "not a url", ownRun: true, ownedByTestAccount: false }) === null,
  );
  check(
    "isOwnRun: an owner or a watch makes it ours; neither makes it a visitor's",
    isOwnRun({ ownerId: "u", watchId: null }) &&
      isOwnRun({ ownerId: null, watchId: "w" }) &&
      !isOwnRun({ ownerId: null, watchId: null }),
  );
  // CHE-253: ownership became a team's. This case is the one that would strand
  // the rule — a run written with a team and no owner. It fails against the
  // code as it stood before teams existed, which is the only kind of assertion
  // worth adding to a predicate that already passes.
  check(
    "isOwnRun: a team-owned run is ours even with no ownerId",
    isOwnRun({ ownerId: null, teamId: "team_u", watchId: null }),
  );
  check(
    "a team-owned run of OUR host is silenced",
    silenceReason({
      targetUrl: "https://checkmyapp.dev/dashboard",
      ownRun: isOwnRun({ ownerId: null, teamId: "team_u", watchId: null }),
      ownedByTestAccount: false,
    }) === "our own product, checked by us",
  );
  check(
    "…and an anonymous visitor's free check of the same host still gets its mail",
    silenceReason({
      targetUrl: "https://checkmyapp.dev/",
      ownRun: isOwnRun({ ownerId: null, teamId: null, watchId: null }),
      ownedByTestAccount: false,
    }) === null,
  );
  // The owner's rule of 2026-09-08, stated as four rows rather than as prose:
  // the HOST answers "is this app ours", the ACCOUNT answers "whose run is
  // this", and they are different questions. Teams add a third way to say
  // "ours", which is exactly the kind of addition that flattens a distinction
  // by accident — so each combination is asserted, not inferred.
  for (const [label, targetUrl, ownRun, ownedByTestAccount, expected] of [
    ["our host + a team's run", "https://checkmyapp.dev/x", true, false, "our own product, checked by us"],
    ["our host + a stranger's run", "https://checkmyapp.dev/x", false, false, null],
    ["a customer host + a team's run", "https://joblander.app/x", true, false, null],
    ["a customer host + a test account", "https://joblander.app/x", true, true, "a self-check account"],
  ] as const) {
    check(
      `host and account answer separately: ${label}`,
      silenceReason({ targetUrl, ownRun, ownedByTestAccount }) === expected,
      String(silenceReason({ targetUrl, ownRun, ownedByTestAccount })),
    );
  }

  // ─── Customer counting ─────────────────────────────────────────────────────

  console.log("\n2 — customer counting reads the same predicate\n");

  for (const [slug, isOurs] of [
    ["checkmyapp.dev", true],
    ["www.checkmyapp.dev", true],
    ["joblander.app", false],
    ["meetbashar.com", false],
    ["example.com", false],
    ["evil-checkmyapp.dev", false],
  ] as const) {
    check(`isSelfHost("${slug}") === ${isOurs}`, isSelfHost(slug) === isOurs, `got ${isSelfHost(slug)}`);
  }
  check(
    "a SELF_CHECK_HOSTS preview slug counts as ours",
    isSelfHost("pr-42.checkmyapp-web.pages.dev", "checkmyapp-web.pages.dev"),
  );

  // gate-ready-supply.ts queries D1 at import time, so it cannot be imported
  // here. Its classification is one function; the evidence is that the function
  // asks the shared predicate and that the hand-kept slug constant is gone.
  {
    const supply = source("scripts/measure/gate-ready-supply.ts");
    check(
      "supply count: bucket() asks isSelfHost, not a hardcoded slug",
      /const ours = \(appSlug: string\) => isSelfHost\(/.test(supply) &&
        /if \(ours\(appSlug\)\) return "ours";/.test(supply),
    );
    check("supply count: no `const OURS = …` remains", !/const OURS\s*=/.test(supply));
    check(
      "supply count: placeholders and test-account targets are still excluded separately",
      /PLACEHOLDER\.test\(appSlug\)/.test(supply) && /testAccounts\.has\(ownerId\)/.test(supply),
    );
  }

  // The accuracy page needs a Next request scope (requireUser,
  // getCloudflareContext), so the same treatment.
  {
    const page = source("src/app/(app)/health/accuracy/page.tsx");
    check(
      "accuracy page: the self split reads isSelfHost",
      /isSelfHost\(a\.appSlug, extraHosts\)/.test(page) && /isSelfHost\(s, extraHosts\)/.test(page),
    );
    check(
      "accuracy page: no equality against a single remembered slug",
      !/appSlug: \{ not: selfSlug \}/.test(page) && !/ourOwnSlug/.test(page),
    );
  }

  // ─── The janitor, unchanged ────────────────────────────────────────────────
  // Disposability is still the test account's property: the placeholder apps the
  // self-check registers are swept, and the real app row that watches our own
  // product — owned by an ordinary account, and the configuration the daily
  // self-check runs from — is never touched.

  console.log("\n3 — the janitor still sweeps by account, and only by account\n");

  {
    const old = new Date("2026-08-01T00:00:00.000Z");
    const now = new Date("2026-09-08T00:00:00.000Z");
    const users = [
      { id: "u_test", isTestAccount: true },
      { id: "u_owner", isTestAccount: false },
    ];
    const apps = [
      { id: "app_placeholder", ownerId: "u_test", appSlug: "example.com", createdAt: old },
      { id: "app_self", ownerId: "u_owner", appSlug: "checkmyapp.dev", createdAt: old },
      { id: "app_customer", ownerId: "u_owner", appSlug: "joblander.app", createdAt: old },
    ];
    const isTest = (ownerId: string) => users.find((u) => u.id === ownerId)?.isTestAccount === true;
    type Where = Record<string, unknown> & {
      owner?: { isTestAccount?: boolean };
      id?: { in?: string[] };
    };
    const nothing = {
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    };
    const db = {
      app: {
        findMany: async ({ where }: { where: Where }) =>
          apps.filter((a) => (where.owner?.isTestAccount ? isTest(a.ownerId) : true)),
        deleteMany: async ({ where }: { where: Where }) => {
          const ids = where.id?.in ?? [];
          for (const id of ids) {
            const i = apps.findIndex((a) => a.id === id);
            if (i >= 0) apps.splice(i, 1);
          }
          return { count: ids.length };
        },
      },
      run: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
      watch: { count: async () => 0, deleteMany: async () => ({ count: 0 }) },
      createdResource: nothing,
      issueLink: nothing,
      appSnapshot: nothing,
      ticketPolicy: nothing,
      trackerIntegration: nothing,
      repoIntegration: nothing,
      testAccount: nothing,
    };
    const result = await sweepTestAccounts({ db } as unknown as AgentEnv, now);
    check(
      "janitor: the test account's placeholder is still swept",
      result.slugs.includes("example.com"),
      result.slugs.join(", ") || "(none)",
    );
    check(
      "janitor: our own app row survives the sweep",
      apps.some((a) => a.appSlug === "checkmyapp.dev"),
    );
    check(
      "janitor: a customer app on the same account survives the sweep",
      apps.some((a) => a.appSlug === "joblander.app"),
    );
    check("janitor: exactly one app removed", result.appsRemoved === 1, String(result.appsRemoved));
  }

  // ─── The rule and its mechanism say the same thing ─────────────────────────

  {
    const rules = source("CLAUDE.md");
    check(
      "CLAUDE.md §6 names the target, not the account, as the marker",
      /identified by its target, not by whose account owns/.test(rules) && /silenceReason/.test(rules),
    );
  }
}

main().then(
  () => {
    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
