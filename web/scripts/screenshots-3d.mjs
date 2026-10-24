// Screenshots of the interactive 3D states: kiln explainer (full, fire, 10 m), map in 3D, and the
// Merkle proof animation end state, at 390 and 1440. Needs SwiftShader WebGL in headless Chromium.
//   node scripts/screenshots-3d.mjs   (BASE defaults to the fixture preview on 4173)
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "screenshots");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const records = JSON.parse(readFileSync(join(here, "..", "src", "fixtures", "records.json"), "utf8"));
const kilnId = process.env.KILN ?? Object.values(records).find((r) => r.status === "FCBK")?.id;

const b = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const problems = [];
for (const [vn, vp, dpr] of [
  ["390", { width: 390, height: 844 }, 1.5],
  ["1440", { width: 1440, height: 900 }, 1],
]) {
  for (const lang of ["en", "ur"]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: dpr, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push(String(e)));
    const shot = async (name, loc) => {
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ov > 0) problems.push({ name, vn, lang, overflow: ov });
      // section shots keep the full page width, so the page gutters are visible in review
      const box = loc ? await loc.boundingBox() : null;
      if (box) await page.screenshot({ path: join(OUT, `3d-${name}-${vn}-${lang}.png`), clip: { x: 0, y: Math.max(0, box.y - 16 + (await page.evaluate(() => window.scrollY))), width: vp.width, height: Math.min(box.height + 32, Math.floor(7600 / dpr)) }, fullPage: true, animations: "allow" });
      else await page.screenshot({ path: join(OUT, `3d-${name}-${vn}-${lang}.png`), animations: "allow" });
    };
    // explainer
    await page.goto(`${BASE}/?lang=${lang}&theme=light`, { waitUntil: "networkidle" });
    const sec = page.locator("#kilns-3d");
    await sec.scrollIntoViewIfNeeded();
    await page.waitForSelector("#kilns-3d .stage.is-3d canvas", { timeout: 30000 });
    await page.waitForTimeout(2000);
    await shot("explainer-full", sec);
    await sec.locator(".explainer-controls .toggle").first().click();
    await page.waitForTimeout(2500);
    await shot("explainer-fire", sec);
    await sec.locator('input[type="range"]').fill("100");
    await page.waitForTimeout(1200);
    await shot("explainer-10m", sec);
    await sec.locator(".explainer-buttons .toggle").click();
    await page.waitForTimeout(1500);
    await shot("explainer-10m-chip", sec);
    // map 3D
    await page.goto(`${BASE}/map?lang=${lang}&theme=light`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.locator(".mappage-bar .toggle").click();
    await page.waitForTimeout(3500);
    await shot("map", null);
    // Merkle end state
    await page.goto(`${BASE}/kiln/${kilnId}?lang=${lang}&theme=light`, { waitUntil: "networkidle" });
    await page.locator(".verify .btn-primary").click();
    await page.waitForSelector(".verdict", { timeout: 30000 });
    await page.waitForTimeout(1500);
    await shot("merkle", page.locator(".verify"));
    const real = errs.filter((e) => !/tiles\.|Failed to load resource|GPU stall|WebGL/i.test(e));
    if (real.length) problems.push({ vn, lang, errors: real.slice(0, 5) });
    await ctx.close();
  }
}
await b.close();
console.log(problems.length ? JSON.stringify(problems, null, 1) : "no console errors, no horizontal overflow");
