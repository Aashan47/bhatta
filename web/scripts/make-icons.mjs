// Renders the zigzag mark to PNG app icons with Playwright's Chromium. Run: node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const icon = readFileSync(join(dir, "icon.svg"), "utf8");
const mask = readFileSync(join(dir, "maskable.svg"), "utf8");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
for (const [svg, size, name] of [
  [icon, 192, "icon-192.png"],
  [icon, 512, "icon-512.png"],
  [icon, 180, "icon-180.png"],
  [mask, 512, "maskable-512.png"],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: join(dir, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log("icons written");
