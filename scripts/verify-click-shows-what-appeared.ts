// CHE-392 verification: a click reports the text that appeared right after it,
// so a confirmation that shows for a moment is seen — not reported as missing.
//
// Run #294 on our own guide page: the copy button flipped to "copied ✓" for
// 1.5 s, the click told the model only "the DOM changed — re-read the page",
// the re-read came seconds later and found "copy" again, and the verdict
// carried a finding: "Copy-snippet buttons give no 'Copied' confirmation".
// Our slowness, written up as their missing feedback (rule 8, interpretation).
//
// A real browser: whether a text node that lived for 300 ms is observable is a
// property of the browser's MutationObserver, not of a stub. One fake origin,
// served by route fulfilment; nothing touches the network.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-click-shows-what-appeared.ts
//        CLICK_APPEARED_CHANNEL=chrome … to run it on the system Chrome, as CI does

import { chromium, type Browser, type Page } from "playwright";
import { appearedSentence, executeTool, prepareAgentPage, type ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const TOP = "https://app.shop.test";
const APP = "https://embedded.shop.test";
const SECRET_EMAIL = "owner-test@example.test";
const LONG = "A very long region of the page re-rendered here. ".repeat(6).trim();

// A button whose label says so for `ms`, then says what it said before — the
// shape of the copy buttons on our own guide page (1.5 s there).
const flipping = (label: string, to: string, ms: number) =>
  `<button id="c">${label}</button><script>const b=document.getElementById('c');b.onclick=()=>{b.textContent=${JSON.stringify(to)};setTimeout(()=>{b.textContent=${JSON.stringify(label)}},${ms})}</script>`;

const PAGES: Record<string, string> = {
  // The case itself: the label says so, briefly.
  [`${TOP}/copy`]: `<!doctype html><title>Guide</title><pre>claude mcp add checkmyapp</pre>${flipping("copy", "copied ✓", 300)}`,
  // A toast: an element that is added and removed.
  [`${TOP}/toast`]: `<!doctype html><title>Settings</title>
    <button onclick="const t=document.createElement('div');t.setAttribute('role','status');t.textContent='Preferences refreshed';document.body.append(t);setTimeout(()=>t.remove(),300)">Refresh preferences</button>`,
  // An icon button whose accessible name is the only thing that changes.
  [`${TOP}/aria`]: `<!doctype html><title>Share</title>
    <button id="a" aria-label="Copy link" onclick="this.setAttribute('aria-label','Link copied');setTimeout(()=>this.setAttribute('aria-label','Copy link'),300)">⧉</button>`,
  // A reaction with no words: a class toggles. Nothing "appeared".
  [`${TOP}/quiet`]: `<!doctype html><title>Menu</title><button onclick="document.body.classList.toggle('open')">Show menu</button>`,
  // Text nobody could see: hidden nodes, a script's text, a style's text.
  [`${TOP}/hidden`]: `<!doctype html><title>Hidden</title>
    <button onclick="const h=document.createElement('div');h.style.display='none';h.textContent='hidden-words';document.body.append(h);
      const s=document.createElement('script');s.type='application/json';s.textContent='script-words';document.body.append(s);
      const v=document.createElement('div');v.style.visibility='hidden';v.textContent='invisible-words';document.body.append(v);
      const o=document.createElement('p');o.textContent='Shown words';document.body.append(o)">Show details</button>`,
  // A visible block that holds hidden text beside its visible text: the hidden
  // part did not appear to anyone (Codex on #242).
  [`${TOP}/nested`]: `<!doctype html><title>Form</title>
    <button onclick="const d=document.createElement('div');d.innerHTML='<span hidden>hidden-error</span><span style=&quot;display:none&quot;>gone-words</span><span style=&quot;visibility:hidden&quot;>unseen-words</span><span style=&quot;opacity:0&quot;>transparent-error</span><span>Saved fine</span>';document.body.append(d)">Show result</button>`,
  // A message that was in the page all along and is revealed for a moment:
  // by the hidden attribute, and by a class (round 2 of Codex on #242).
  [`${TOP}/reveal-hidden`]: `<!doctype html><title>Draft</title><p>Always here</p><p id="t" hidden>Draft stored</p>
    <button onclick="const t=document.getElementById('t');t.hidden=false;setTimeout(()=>{t.hidden=true},300)">Show status</button>`,
  [`${TOP}/reveal-class`]: `<!doctype html><title>Share</title><style>.off{display:none}</style><p>Always here</p><div id="t" class="toast off"><b>Done.</b> Link is on your clipboard</div>
    <button onclick="const t=document.getElementById('t');t.classList.remove('off');setTimeout(()=>t.classList.add('off'),300)">Show link status</button>`,
  // A toast that arrives transparent and fades in, as most do.
  [`${TOP}/fade`]: `<!doctype html><title>Fade</title><style>.toast{opacity:0;transition:opacity 150ms}.toast.in{opacity:1}</style>
    <button onclick="const t=document.createElement('div');t.className='toast';t.textContent='Changes refreshed';document.body.append(t);requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('in')));setTimeout(()=>t.remove(),700)">Refresh changes</button>`,
  // A web component: the button and its label live in an open shadow root,
  // where neither a document-level observer nor a tree walk reaches by itself
  // (round 3 of Codex on #242). One whose label flips, one that only changes
  // its own class, and a toast that brings its own shadow root with it.
  [`${TOP}/shadow`]: `<!doctype html><title>Component</title><p>Always here</p><div id="host"></div>
    <script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button id="c">copy</button><button id="k">Show panel</button>';
      const b=r.getElementById('c');b.onclick=()=>{b.textContent='copied ✓';setTimeout(()=>{b.textContent='copy'},300)};
      const k=r.getElementById('k');k.onclick=()=>k.classList.toggle('active');</script>
    <button onclick="const h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'open'}).innerHTML='<p>Stored in a component</p>';setTimeout(()=>h.remove(),300)">Show stored</button>`,
  // A client-side route change: the URL moves, the document stays, and the
  // confirmation is shown on the way (round 3 of Codex on #242).
  [`${TOP}/route`]: `<!doctype html><title>Wizard</title>
    <button onclick="history.pushState({},'','/route/next');const t=document.createElement('div');t.textContent='Step stored';document.body.append(t);setTimeout(()=>t.remove(),300)">Continue to next</button>`,
  // The shape of a popular toast list: fixed, no height of its own, nothing cut
  // off, each toast positioned out of it.
  [`${TOP}/sonner`]: `<!doctype html><title>Events</title><ol id="list" style="position:fixed;bottom:24px;right:24px;width:300px;margin:0;padding:0;list-style:none"></ol>
    <button onclick="const li=document.createElement('li');li.style.cssText='position:absolute;bottom:0;right:0;width:300px';li.textContent='Event refreshed';document.getElementById('list').append(li);setTimeout(()=>li.remove(),300)">Refresh event</button>`,
  // A notice that is always in the page, parked off-screen, and slides in.
  [`${TOP}/slide`]: `<!doctype html><title>Profile</title><style>#n{position:fixed;left:16px;bottom:16px;transform:translateY(300px);transition:transform 150ms}#n.in{transform:none}</style>
    <div id="n">Profile refreshed</div>
    <button onclick="const n=document.getElementById('n');n.classList.add('in');setTimeout(()=>n.classList.remove('in'),700)">Show notice</button>`,
  // Revealed by a data-state attribute and a CSS rule, as component kits do.
  [`${TOP}/data-state`]: `<!doctype html><title>Kit</title><style>[data-state=closed]{display:none}</style>
    <div id="p" data-state="closed">Details are open</div>
    <button onclick="const p=document.getElementById('p');p.dataset.state='open';setTimeout(()=>{p.dataset.state='closed'},300)">Show details</button>`,
  // Text only a screen reader gets: the usual 1px clipped live region, the same
  // inside an open shadow root, and one parked far off-screen.
  [`${TOP}/sr-only`]: `<!doctype html><title>Quiet</title><style>.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
    <div id="live" class="sr" aria-live="polite"></div><div id="far" style="position:absolute;left:-9999px"></div><div id="host"></div>
    <script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<div id="a" aria-live="assertive" style="position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap"></div>';
      function announce(){document.getElementById('live').textContent='Announced politely';document.getElementById('far').textContent='Announced far away';r.getElementById('a').textContent='Announced in shadow'}</script>
    <button onclick="announce()">Show nothing</button>`,
  // What Next.js does on a client-side navigation: the URL moves, the screen
  // changes, and the new title goes into <next-route-announcer>'s open shadow
  // root for screen readers.
  [`${TOP}/next-nav`]: `<!doctype html><title>Home – Example</title><main id="m"><h1>Welcome home</h1></main><a href="/next-nav/pricing" id="l">Pricing</a><next-route-announcer></next-route-announcer>
    <script>const ann=document.querySelector('next-route-announcer');ann.style.position='absolute';
      ann.attachShadow({mode:'open'}).innerHTML='<div id="__next-route-announcer__" aria-live="assertive" role="alert" style="position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;word-wrap:normal"></div>';
      document.getElementById('l').onclick=(e)=>{e.preventDefault();history.pushState({},'','/next-nav/pricing');document.title='Pricing – Example';
        document.getElementById('m').innerHTML='<h1>Plans start at nine</h1>';ann.shadowRoot.firstChild.textContent=document.title}</script>`,
  // A tab bar re-rendered from scratch with the words it already had.
  [`${TOP}/remount`]: `<!doctype html><title>Tabs</title><nav id="nav"><button>Overview</button><button>Reports</button><button>Settings</button></nav>
    <script>document.getElementById('nav').addEventListener('click',()=>{const nav=document.getElementById('nav');const labels=[...nav.children].map((b)=>b.textContent);nav.innerHTML='';for(const l of labels){const b=document.createElement('button');b.textContent=l;nav.append(b)}})</script>`,
  // A row added far below what is on screen.
  [`${TOP}/below`]: `<!doctype html><title>Long</title><button onclick="const p=document.createElement('p');p.textContent='Row added below';document.getElementById('end').append(p)">Show more rows</button><div style="height:4000px"></div><div id="end"></div>`,
  // A control whose own class changes says nothing new: its label was there.
  [`${TOP}/active`]: `<!doctype html><title>Tabs</title><p>Always here</p><button onclick="this.classList.toggle('active');this.style.fontWeight='bold'">Show overview</button>`,
  // A whole region re-rendering is not a message.
  [`${TOP}/long`]: `<!doctype html><title>List</title>
    <button onclick="const r=document.createElement('section');r.textContent=${JSON.stringify(LONG).replace(/"/g, "&quot;")};document.body.append(r);const k=document.createElement('p');k.textContent='List refreshed';document.body.append(k)">Refresh list</button>`,
  // Many pieces: the last ones win.
  [`${TOP}/many`]: `<!doctype html><title>Steps</title>
    <button onclick="for(let i=1;i<=9;i++){const p=document.createElement('p');p.textContent='line '+i;document.body.append(p)}">Show steps</button>`,
  // The page says who is signed in when asked — the test account's email.
  [`${TOP}/whoami`]: `<!doctype html><title>Account</title>
    <button onclick="const p=document.createElement('p');p.textContent='Signed in as ${SECRET_EMAIL}';document.body.append(p)">Show account</button>`,
  // A click that goes somewhere: the new page is read, not "appeared".
  [`${TOP}/nav`]: `<!doctype html><title>Start</title><a href="/landed">Continue to the next page</a>`,
  [`${TOP}/landed`]: `<!doctype html><title>Landed</title><h1>Landed words</h1><script>const p=document.createElement('p');p.textContent='rendered after load';document.body.append(p)</script>`,
  // The same button inside an embedded app on another origin.
  [`${TOP}/embedded`]: `<!doctype html><title>Admin</title><h1>Admin</h1><iframe name="app-iframe" src="${APP}/" width="600" height="300"></iframe>`,
  [`${APP}/`]: `<!doctype html><title>App</title>${flipping("copy", "copied ✓", 300)}`,
};

async function launch(): Promise<Browser> {
  // CI has no Playwright build and runs the system Chrome (verify-frame-tools).
  const channel = process.env.CLICK_APPEARED_CHANNEL;
  if (channel) return chromium.launch({ channel });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

async function envAt(browser: Browser, path: string, allowedOrigins?: string[]): Promise<ToolEnv & { page: Page }> {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const body = PAGES[`${url.origin}${url.pathname}`];
    if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  const page = await context.newPage();
  const env = {
    page,
    targetOrigin: TOP,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    testEmail: SECRET_EMAIL,
    testPassword: "s3cret-click-pass",
    credentials: { rejected: false },
    networkLog: [],
    consoleLog: [],
    actionTrail: [],
    undrivenControls: [],
  } as unknown as ToolEnv & { page: Page };
  await prepareAgentPage(env);
  const nav = await executeTool(env, "navigate", { url: `${TOP}${path}` });
  if (!nav.startsWith("Navigated")) throw new Error(`fixture did not load: ${nav}`);
  for (const frame of page.frames()) await frame.waitForLoadState("load");
  return env;
}

const APPEARED = "Text that became visible within a few seconds of the click:";
const NAMES = "Accessible names (aria-label or title — not text on the page) that changed in that time:";

async function main() {
  // --- the sentence -----------------------------------------------------------
  const text = (t: string) => ({ t, k: "text" as const });
  const name = (t: string) => ({ t, k: "name" as const });
  check("nothing became visible → nothing is said", appearedSentence([]) === "");
  check(
    "what became visible is quoted, in order, once each",
    appearedSentence([text("copied ✓"), text("Saved"), text("copied ✓")]).includes(`${APPEARED} "copied ✓", "Saved".`),
    appearedSentence([text("copied ✓"), text("Saved"), text("copied ✓")]),
  );
  check(
    "the sentence claims what was observed and no more: no cause, no 'confirmation'",
    !/confirmation|because|caused|right after/i.test(appearedSentence([text("Saved"), name("Link copied")])) &&
      appearedSentence([text("Saved")]).includes("text shown briefly was still shown"),
    appearedSentence([text("Saved"), name("Link copied")]),
  );
  check(
    "an accessible name is said to be one, apart from text on the page",
    appearedSentence([name("Link copied")]) === ` ${NAMES} "Link copied".` &&
      appearedSentence([text("Saved"), name("Link copied")]).includes(`${APPEARED} "Saved".`) &&
      appearedSentence([text("Saved"), name("Link copied")]).includes(`${NAMES} "Link copied".`),
    appearedSentence([text("Saved"), name("Link copied")]),
  );

  const browser = await launch();
  try {
    // --- the case from run #294 -----------------------------------------------
    {
      const env = await envAt(browser, "/copy");
      const result = await executeTool(env, "click", { role: "button", name: "copy" });
      check(
        "a label that flips for 300 ms is named in the click's own result — and the label coming back is not news",
        result.includes(`${APPEARED} "copied ✓".`),
        result,
      );
      const after = await executeTool(env, "read_page", {});
      check(
        "…and is gone by the next read (the fixture really is transient — this is what run #294 saw)",
        !after.includes("copied ✓") && /copy/.test(after),
        after.slice(0, 200),
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/toast");
      const result = await executeTool(env, "click", { role: "button", name: "Refresh preferences" });
      check("a toast that is added and removed is named", result.includes('"Preferences refreshed"'), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/aria");
      const result = await executeTool(env, "click", { role: "button", name: "Copy link" });
      check(
        "an accessible name that changes is named as a name, not as text on the page; the old name coming back is not news",
        result.includes(`${NAMES} "Link copied".`) && !result.includes(APPEARED),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/sonner");
      const result = await executeTool(env, "click", { role: "button", name: "Refresh event" });
      check("a toast positioned out of a list with no height (and no clipping) is seen", result.includes('"Event refreshed"'), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/slide");
      const result = await executeTool(env, "click", { role: "button", name: "Show notice" });
      check("a notice that was in the page off-screen and slides in is seen", result.includes('"Profile refreshed"'), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/data-state");
      const result = await executeTool(env, "click", { role: "button", name: "Show details" });
      check("text revealed by a data-state attribute is seen", result.includes('"Details are open"'), result);
      await env.page.context().close();
    }

    // --- what nobody saw (cross-review of #242) ---------------------------------
    {
      const env = await envAt(browser, "/sr-only");
      const result = await executeTool(env, "click", { role: "button", name: "Show nothing" });
      check(
        "text written for screen readers only — a 1px clipped live region, light DOM or shadow, and one parked off-screen — is not reported as shown",
        result.startsWith("Clicked") && !result.includes(APPEARED) && !result.includes("Announced") && !result.includes("did not react"),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/next-nav");
      const result = await executeTool(env, "click", { role: "link", name: "Pricing" });
      check(
        "a client-side navigation that writes the new title into a route announcer reports no text for it",
        result.includes("/next-nav/pricing") && !result.includes("Pricing – Example"),
        result,
      );
      check("…while what the new screen visibly shows is reported", result.includes('"Plans start at nine"'), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/remount");
      const result = await executeTool(env, "click", { role: "button", name: "Reports" });
      check(
        "a component re-mounted with the words it already showed has not said anything new",
        result.startsWith("Clicked") && !result.includes(APPEARED),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/below");
      const result = await executeTool(env, "click", { role: "button", name: "Show more rows" });
      check("text added below the fold was not seen", result.startsWith("Clicked") && !result.includes(APPEARED), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/embedded", [APP]);
      const result = await executeTool(env, "click", { role: "button", name: "copy", frame: "app-iframe" });
      check("the same inside an embedded app's frame", result.includes('"copied ✓"'), result);
      await env.page.context().close();
    }

    // --- what must not be said --------------------------------------------------
    {
      const env = await envAt(browser, "/quiet");
      const result = await executeTool(env, "click", { role: "button", name: "Show menu" });
      check("a reaction with no words adds no sentence", result.startsWith("Clicked") && !result.includes(APPEARED), result);
      check("…and is still told to re-read", result.includes("re-read the page"), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/hidden");
      const result = await executeTool(env, "click", { role: "button", name: "Show details" });
      check("visible text is named", result.includes('"Shown words"'), result);
      check(
        "text nobody could see is not: display:none, visibility:hidden, a script's text",
        !result.includes("hidden-words") && !result.includes("invisible-words") && !result.includes("script-words"),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/nested");
      const result = await executeTool(env, "click", { role: "button", name: "Show result" });
      check(
        "of a block that appeared, only its visible text is named — not the hidden or transparent error inside it",
        result.includes('"Saved fine"') &&
          !result.includes("hidden-error") &&
          !result.includes("gone-words") &&
          !result.includes("unseen-words") &&
          !result.includes("transparent-error"),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/reveal-hidden");
      const result = await executeTool(env, "click", { role: "button", name: "Show status" });
      check("a message revealed by removing `hidden` for 300 ms is named", result.includes('"Draft stored"'), result);
      check("…and text that was visible all along is not", !result.includes("Always here") && !result.includes("Show status"), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/reveal-class");
      const result = await executeTool(env, "click", { role: "button", name: "Show link status" });
      check("a message revealed by a class change is named, as one piece", result.includes('"Done. Link is on your clipboard"'), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/fade");
      const result = await executeTool(env, "click", { role: "button", name: "Refresh changes" });
      check("a toast that arrives transparent and fades in is named", result.includes('"Changes refreshed"'), result);
      const after = await executeTool(env, "read_page", {});
      check("…and it too is gone by the next read", !after.includes("Changes refreshed"), after.slice(0, 160));
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/shadow");
      const flipped = await executeTool(env, "click", { role: "button", name: "copy" });
      check("a label that flips inside an open shadow root is named — and counted as a reaction at all", flipped.includes('"copied ✓"') && !flipped.includes("did not react"), flipped);
      const toggled = await executeTool(env, "click", { role: "button", name: "Show panel" });
      check("a shadow control whose own class changes has not said anything new", toggled.startsWith("Clicked") && !toggled.includes(APPEARED) && !toggled.includes("did not react"), toggled);
      const stored = await executeTool(env, "click", { role: "button", name: "Show stored" });
      check("a toast that arrives with its own shadow root is named", stored.includes('"Stored in a component"'), stored);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/route");
      const result = await executeTool(env, "click", { role: "button", name: "Continue to next" });
      check(
        "a click that changes the route without leaving the document keeps what it showed",
        result.includes("/route/next") && result.includes("navigated") && result.includes('"Step stored"'),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/active");
      const result = await executeTool(env, "click", { role: "button", name: "Show overview" });
      check("a control whose own class and style change has not said anything new", result.startsWith("Clicked") && !result.includes(APPEARED), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/long");
      const result = await executeTool(env, "click", { role: "button", name: "Refresh list" });
      check("a re-rendered region is not quoted; the short message beside it is", result.includes('"List refreshed"') && !result.includes("A very long region"), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/many");
      const result = await executeTool(env, "click", { role: "button", name: "Show steps" });
      check(
        "at most six pieces, the last ones",
        result.includes('"line 4", "line 5", "line 6", "line 7", "line 8", "line 9".') && !result.includes('"line 3"'),
        result,
      );
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/whoami");
      const result = await executeTool(env, "click", { role: "button", name: "Show account" });
      check("the test account's email never reaches the model this way either", result.includes(APPEARED) && !result.includes(SECRET_EMAIL), result);
      await env.page.context().close();
    }
    {
      const env = await envAt(browser, "/nav");
      const result = await executeTool(env, "click", { role: "link", name: "Continue to the next page" });
      check("a click that navigates says where it landed, not that the new page 'appeared'", result.includes("/landed") && !result.includes(APPEARED), result);
      await env.page.context().close();
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.log(`\nverify-click-shows-what-appeared: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nverify-click-shows-what-appeared: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
