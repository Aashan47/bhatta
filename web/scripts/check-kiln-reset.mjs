// Regression check (headless): verify kiln A, navigate in-app to kiln B, and assert that the Verify on
// chain panel starts fresh and that verifying B shows B's leaf.
//   npm run build:fixture && npx vite preview --port 4173 &   then   node scripts/check-kiln-reset.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const records = JSON.parse(readFileSync(join(here, "..", "src", "fixtures", "records.json"), "utf8"));
const [a, b] = process.env.KILNS ? process.env.KILNS.split(",") : Object.keys(records).slice(0, 2);
const leafB = process.env.LEAF_B ?? records[b]?.chain?.leaf;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(`${BASE}/kiln/${a}?lang=en`, { waitUntil: "networkidle" });
await page.locator(".verify .btn-primary").click();
await page.waitForSelector(".verify .verdict", { timeout: 60000 });
if (!(await page.locator(".verify .merkle").count())) fail("kiln A shows no Merkle tree after verifying");

// client-side navigation, as a link inside the app would do
await page.evaluate((id) => {
  window.history.pushState({}, "", `/kiln/${id}?lang=en`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}, b);
await page.waitForFunction((id) => document.querySelector(".kiln-id h1")?.textContent?.includes(id), b, { timeout: 15000 });

const states = await page.$$eval(".verify .step", (els) => els.map((e) => e.className));
if (!states.length || states.some((c) => !c.includes("step-idle"))) fail(`verify steps not reset on kiln B: ${states.join(" | ")}`);
if (await page.locator(".verify .verdict").count()) fail("a verdict from kiln A is still shown on kiln B");
if (await page.locator(".verify .merkle").count()) fail("kiln A's Merkle tree is still shown on kiln B");
const btn = await page.locator(".verify .btn-primary").innerText();
if (!/Verify now/.test(btn)) fail(`verify button not in its initial state: "${btn}"`);

await page.locator(".verify .btn-primary").click();
await page.waitForSelector(".verify .verdict", { timeout: 60000 });
const titles = await page.$$eval(".verify [title]", (els) => els.map((e) => e.getAttribute("title")?.toLowerCase()));
if (leafB && !titles.includes(leafB.toLowerCase())) fail(`kiln B's leaf ${leafB} is not shown after verifying B`);
const leafA = records[a]?.chain?.leaf;
if (leafA && !process.env.KILNS && titles.includes(leafA.toLowerCase())) fail("kiln A's leaf is shown on kiln B");

await browser.close();
console.log(process.exitCode ? "kiln reset check FAILED" : `kiln reset check passed (${a} -> ${b})`);
