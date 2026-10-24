// Screenshots every route at phone and desktop sizes, in English and Urdu, light and dark, and reports
// console errors and horizontal overflow. Expects the app at BASE (default: vite preview on 4173).
//   npm run build:fixture && npx vite preview --port 4173 &   then   node scripts/screenshots.mjs
// CHROME_PATH may point at a Chromium binary if Playwright's own download is missing.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "screenshots");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";

const ledger = JSON.parse(readFileSync(join(here, "..", "src", "fixtures", "ledger.json"), "utf8"));
const conflictKiln = ledger.events.find((e) => e.type === "Conflict")?.kiln_id;
const certKiln = (() => {
  const proven = new Set(ledger.events.filter((e) => e.type === "SatelliteProven").map((e) => e.kiln_id));
  return ledger.events.find((e) => e.type === "FindingAttested" && e.detail.finding === 1 && proven.has(e.kiln_id))?.kiln_id;
})();
const records = JSON.parse(readFileSync(join(here, "..", "src", "fixtures", "records.json"), "utf8"));
const notSeen = Object.values(records).find((r) => r.status === "NOT_DETECTED")?.id;

const ROUTES = [
  ["overview", "/"],
  ["map", "/map"],
  ["map-drawer", `/map?kiln=${conflictKiln}`],
  ["kiln-conflict", `/kiln/${conflictKiln}`],
  ["kiln-certified", `/kiln/${certKiln}`],
  ["kiln-notseen", `/kiln/${notSeen}`],
  ["certificate", `/kiln/${certKiln}/certificate`],
  ["inspect", "/inspect"],
  ["ledger", "/ledger"],
  ["method", "/method"],
  ["notfound", "/nope"],
];
const VIEWPORTS = [
  ["390", { width: 390, height: 844 }],
  ["1440", { width: 1440, height: 900 }],
];
const VARIANTS = [
  ["en-light", "lang=en&theme=light"],
  ["ur-light", "lang=ur&theme=light"],
  ["en-dark", "lang=en&theme=dark"],
];
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const problems = [];
for (const [vname, vp] of VIEWPORTS) {
  for (const [variant, q] of VARIANTS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vname === "390" ? 2 : 1, serviceWorkers: "block" });
    for (const [name, path] of ROUTES) {
      if (only && !only.includes(name)) continue;
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(String(e)));
      const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}${q}`;
      await page.goto(url, { waitUntil: "networkidle" }).catch(() => undefined);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(name.startsWith("map") || name === "overview" ? 2500 : 600);
      if (name.startsWith("kiln-")) {
        const btn = page.getByRole("button", { name: /Verify now|ابھی تصدیق کریں/ });
        if (await btn.count()) {
          await btn.click();
          await page.waitForTimeout(2200);
        }
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const file = join(OUT, `${name}-${vname}-${variant}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const real = errors.filter((e) => !/tiles\.openfreemap|tiles\.maps\.eox|Failed to load resource/.test(e));
      if (overflow > 0 || real.length) problems.push({ name, vname, variant, overflow, errors: real });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? JSON.stringify(problems, null, 1) : "no console errors, no horizontal overflow");
