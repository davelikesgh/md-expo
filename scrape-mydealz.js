// scrape-mydealz.js – funktioniert robust auch mit Cloudflare & allen Kommentaren
// Ziel: komplette Seiten-Screenshots (Deal + alle Kommentare ausgeklappt)

import fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { PDFDocument } from "pdf-lib";

// Stealth-Modus aktivieren (um Cloudflare zu umgehen)
chromium.use(stealth());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};

async function acceptCookies(page) {
  const sel = [
    "button:has-text('Akzeptieren')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Einverstanden')",
    "[data-testid='uc-accept-all-button']"
  ];
  for (const s of sel) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click({ timeout: 500 }).catch(() => {});
        await sleep(500);
        break;
      }
    } catch {}
  }
}

async function hideStickyUI(page) {
  await page.addStyleTag({
    content: `
      header, .header, [data-test*="header"], [id*="cookie"], [class*="cookie"], 
      [class*="sticky"], [data-test*="sticky"], .banner, .modal, .toast, .bottom-bar, .top-bar {
        display: none !important;
      }
      ::-webkit-scrollbar { display:none !important; }
      body { scrollbar-width: none !important; }
    `
  });
}

async function ensureLoaded(page) {
  await page.waitForSelector("h1, [data-test='thread-title']", { timeout: 20000 }).catch(() => {});
}

async function autoScroll(page, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await page.mouse.wheel(0, 1200);
    await sleep(150);
  }
}

async function detectPages(page, baseUrl) {
  const pages = await page.$$eval("a[href*='page=']", (a) =>
    [...new Set(a.map(x => (x.href.match(/page=(\d+)/) || [])[1]).filter(Boolean).map(Number))]
  );
  const max = pages.length ? Math.max(...pages) : 1;
  return Array.from({ length: max }, (_, i) => {
    const u = new URL(baseUrl);
    u.searchParams.set("page", i + 1);
    u.hash = "comments";
    return u.toString();
  });
}

async function expandAll(page) {
  let total = 0;
  for (let round = 0; round < 15; round++) {
    const buttons = await page.locator("button, a, div[role='button']").all();
    let clicked = 0;
    for (const btn of buttons) {
      const text = (await btn.textContent())?.toLowerCase() || "";
      if (text.includes("mehr antworten anzeigen") ||
          text.includes("weitere antworten") ||
          text.includes("antworten anzeigen") ||
          text.includes("view more") ||
          text.includes("more replies")) {
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 1000 });
          clicked++; total++;
          await sleep(250);
        } catch {}
      }
    }
    if (clicked === 0) break;
    await autoScroll(page, 1200);
  }
  return total;
}

async function screenshotPage(page, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await page.screenshot({ path: file, fullPage: true });
}

async function makePDF(images, outFile) {
  const pdf = await PDFDocument.create();
  for (const img of images) {
    const bytes = fs.readFileSync(img);
    const image = await pdf.embedPng(bytes);
    const page = pdf.addPage([image.width * 0.75, image.height * 0.75]);
    page.drawImage(image, { x: 0, y: 0, width: image.width * 0.75, height: image.height * 0.75 });
  }
  fs.writeFileSync(outFile, await pdf.save());
}

async function main() {
  const url = arg("url");
  if (!url) {
    console.error("Usage: node scrape-mydealz.js --url <Deal-URL>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin"
  });
  const page = await ctx.newPage();

  console.log("→ Öffne:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  await acceptCookies(page);
  await hideStickyUI(page);
  await ensureLoaded(page);

  // Cloudflare-Schutz abwarten
  const cf = page.locator("text=Verifying you are human");
  if (await cf.isVisible().catch(() => false)) {
    console.log("⚠️ Cloudflare Schutz erkannt – warte...");
    await sleep(10000);
    await page.reload();
  }

  await autoScroll(page, 4000);
  const subpages = await detectPages(page, url);
  console.log("→ Kommentar-Unterseiten erkannt:", subpages.length);

  const dir = "shots";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const imgs = [];

  for (let i = 0; i < subpages.length; i++) {
    console.log(`=== Render ${i + 1}/${subpages.length} ===`);
    await page.goto(subpages[i], { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await acceptCookies(page);
    await hideStickyUI(page);
    await ensureLoaded(page);
    await autoScroll(page, 4000);
    const expanded = await expandAll(page);
    console.log("   ausgeklappt:", expanded);
    await autoScroll(page, 2000);
    const file = path.join(dir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await screenshotPage(page, file);
    imgs.push(file);
    console.log("   ✓ Screenshot:", file);
  }

  const out = "mydealz-output.pdf";
  await makePDF(imgs, out);
  console.log("✓ PDF erstellt:", out);
  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
