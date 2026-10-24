// Renders the no-WebGL fallback stills for the 3D kiln explainer from the app's own three.js scene.
// Needs the app running (npm run build:fixture && npx vite preview --port 4173) and a Chromium with
// SwiftShader. Writes public/explainer/{full,fire,top,tenm}.png.
//   CHROME_PATH=... node scripts/make-explainer-stills.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "explainer");
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const b = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const p = await b.newPage({ viewport: { width: 1290, height: 1000 } });
await p.goto(`${BASE}/?lang=en&theme=light`, { waitUntil: "networkidle" });
await p.addStyleTag({ content: ".stage-hint,.stage-label{display:none!important}" });
const sec = p.locator("#kilns-3d");
await sec.scrollIntoViewIfNeeded();
await p.waitForSelector("#kilns-3d .stage.is-3d canvas", { timeout: 30000 });
await p.waitForTimeout(2500);
const stage = sec.locator(".stage");
await stage.screenshot({ path: join(out, "full.png") });
await sec.getByRole("button", { name: "Fire" }).click();
await p.waitForTimeout(3000);
await stage.screenshot({ path: join(out, "fire.png") });
await sec.getByRole("button", { name: "Fire" }).click();
await sec.locator('input[type="range"]').fill("50");
await p.waitForTimeout(1000);
await stage.screenshot({ path: join(out, "top.png") });
await sec.locator('input[type="range"]').fill("100");
await p.waitForTimeout(1000);
await stage.screenshot({ path: join(out, "tenm.png") });
await b.close();
console.log("stills written to", out);
