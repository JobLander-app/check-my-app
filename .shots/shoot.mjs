import { chromium } from "playwright";
const b = await chromium.launch();
for (const [name, path] of [["guide", "/guides/check-every-release"], ["guides-index", "/guides"], ["connect-agent", "/guides/connect-your-agent"]]) {
  for (const w of [1440, 390]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    await p.goto("http://localhost:3370" + path, { waitUntil: "networkidle", timeout: 120000 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: `.shots/${name}-${w}.png`, fullPage: true });
    console.log(name, w, "overflow px:", over);
    await p.close();
  }
}
await b.close();
