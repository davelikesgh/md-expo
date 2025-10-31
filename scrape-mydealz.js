// scrape-mydealz.js — Screenshot-Modus mit stabilem "alle Antworten ausklappen"
// funktioniert in GitHub Actions und lokal mit Playwright >=1.40

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};

async function acceptCookies(page) {
  const selectors = [
    "button:has-text('Akzeptieren')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Zustimmen')",
    "button:has-text('Einverstanden')",
    "[data-testid='uc-accept-all-button']"
  ];
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
      await el.click().catch(() => {});
      await sleep(400);
      break;
    }
  }
}

async function hideStickyUI(page) {
  await page.addStyleTag({
    content: `
      header, .header, [data-test*="header"], [class*="cookie"], [class*="sticky"],
      [id*="cookie"], .banner, .bottom-bar, .top-bar, .modal, .toast {
        display: none !important;
      }
      ::-webkit-scrollbar { display:none !important; }
      body { scrollbar-width: none !important; }
    `
  });
}

async function ensureDealLoaded(page) {
  await page.waitForSelector("h1, [data-test='thread-title']", { timeout: 15000 }).catch(() => {});
}

async function autoScroll(page, totalMs = 20000) {
  const start = Date.now();
  let last = await page.evaluate(() => document.body.scrollHeight);
  while (Date.now() - start < totalMs) {
    await page.mouse.wheel(0, 1200);
    await sleep(120);
    const cur = await page.evaluate(() => document.body.scrollHeight);
    if (cur <= last) break;
    last = cur;
  }
}

async function detectPages(page, baseUrl) {
  const pages = await page.$$eval("a[href*='page=']", (links) =>
    Array.from(new Set(
      links
        .map((a) => (a.href.match(/page=(\d+)/) || [])[1])
        .filter(Boolean)
        .map(Number)
    ))
  );
  const maxPage = pages.length ? Math.max(...pages) : 1;
  return Array.from({ length: maxPage }, (_, i) => {
    const u = new URL(baseUrl);
    u.searchParams.set("page", i + 1);
    u.hash = "comments";
    return u.toString();
  });
}

// 🔽 Neuer & stabiler Ausklapp-Mechanismus
async function expandAllReplies(page) {
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const buttons = await page.locator("button, a, div[role='button']").all();
    let clicked = 0;
    for (const btn of buttons) {
      const text = (await btn.textContent())?.toLowerCase() || "";
      if (
        text.includes("mehr antworten anzeigen") ||
        text.includes("weitere antworten") ||
        text.includes("antworten anzeigen") ||
        text.includes("view more") ||
        text.includes("more replies")
      ) {
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 1000 });
          clicked++;
          total++;
          await sleep(200);
        } catch {}
      }
    }
    if (clicked === 0) break;
    await autoScroll(page, 1500);
  }
  return total;
}

async function screenshotPage(page, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await page.screenshot({ path: file, fullPage: true });
}

async function pngsToPdf(pngs, out) {
  const pdf = await PDFDocument.create();
  for (const p of pngs) {
    const img = await pdf.embedPng(fs.readFileSync(p));
    const w = img.width * 0.75, h = img.height * 0.75;
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  fs.writeFileSync(out, await pdf.save());
}

async function main() {
  const url = arg("url");
  if (!url) {
    console.error("Usage: node scrape-mydealz.js --url <mydealz-link>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await ctx.newPage();

  console.log("→ Öffne:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);
  await hideStickyUI(page);
  await ensureDealLoaded(page);
  await autoScroll(page, 3000);

  const subpages = await detectPages(page, url);
  console.log("→ Kommentar-Unterseiten erkannt:", subpages.length);

  const dir = "shots";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const shots = [];
  for (let i = 0; i < subpages.length; i++) {
    console.log(`=== Render ${i + 1}/${subpages.length} ===`);
    await page.goto(subpages[i], { waitUntil: "domcontentloaded", timeout: 60000 });
    await hideStickyUI(page);
    await ensureDealLoaded(page);
    await autoScroll(page, 4000);
    const clicks = await expandAllReplies(page);
    console.log("   ausgeklappt:", clicks);
    await autoScroll(page, 2500);
    const file = path.join(dir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await screenshotPage(page, file);
    shots.push(file);
    console.log("   ✓ Screenshot:", file);
  }

  const out = "mydealz-output.pdf";
  await pngsToPdf(shots, out);
  console.log("✓ PDF erstellt:", out);
  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
