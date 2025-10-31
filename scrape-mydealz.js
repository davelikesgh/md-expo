// scrape-mydealz.js — Screenshot-Modus: jede Unterseite voll rendern, alles ausklappen,
// Vollseiten-Screenshots erstellen und zu einer PDF zusammenfügen.
// Usage (wie bisher):
//   node scrape-mydealz.js --url "https://www.mydealz.de/deals/..."

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const BTN_TEXT = /(Mehr Antworten anzeigen|Weitere Antworten|Antworten anzeigen|mehr Antworten)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};

async function acceptCookies(page) {
  // Versuche häufige Varianten des Consent-Buttons
  const candidates = [
    "//button[contains(., 'Akzeptieren')]",
    "//button[contains(., 'Alle akzeptieren')]",
    "//button[contains(., 'Zustimmen')]",
    "//button[contains(., 'Einverstanden')]",
    "button[aria-label*='akzept']",
    "[data-testid='uc-accept-all-button']",
  ];
  for (const sel of candidates) {
    try {
      const el = await page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 500 });
        await sleep(300);
        break;
      }
    } catch {}
  }
}

async function hideStickyUI(page) {
  // Entfernt fixierte Header/Footers/Overlays, damit der Screenshot „ruhig“ ist.
  await page.addStyleTag({
    content: `
      * { scroll-behavior: auto !important; }
      header, .header, .app--header, [data-test*="header"], [data-test*="sticky"],
      .cookie, .consent, [aria-label*="cookie"], .toast, .modal, .Popover, .tooltip,
      .banner, .sticky, .bottom-bar, .top-bar, .gdpr, .newsletter,
      [class*="cookie"], [class*="consent"], [id*="cookie"] {
        display: none !important;
      }
      ::-webkit-scrollbar{ display:none !important; }
      body{ scrollbar-width: none !important; }
    `,
  });
}

async function ensureDealLoaded(page) {
  // Warte bis Titel/Thread geladen ist
  await page.waitForFunction(() => {
    const t1 = document.querySelector("[data-test='thread-title']");
    const h1 = document.querySelector("h1");
    const og = document.querySelector("meta[property='og:title']")?.getAttribute("content");
    const ok =
      (t1 && (t1.textContent || "").trim().length > 3) ||
      (h1 && (h1.textContent || "").trim().length > 3) ||
      (og && og.length > 3);
    return ok;
  }, { timeout: 20000 }).catch(() => {});
}

async function autoScroll(page, { totalMs = 25000, stepPx = 1600, pauseMs = 120 } = {}) {
  const start = Date.now();
  let lastHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  while (Date.now() - start < totalMs) {
    await page.mouse.wheel(0, stepPx);
    await sleep(pauseMs);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h <= lastHeight) {
      await sleep(250);
      const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h2 <= lastHeight) break;
    }
    lastHeight = h;
  }
}

async function expandAllReplies(page, maxRounds = 14) {
  let total = 0;
  const start = Date.now();
  for (let round = 1; round <= maxRounds; round++) {
    // Buttons NUR in Kommentaren suchen:
    const buttons = page
      .locator("[data-test*='comment'] >> :is(button, a[role='button'], a, div[role='button'])")
      .filter({ hasText: BTN_TEXT });
    const n = await buttons.count();
    if (n === 0) break;

    let clicked = 0;
    for (let i = 0; i < n; i++) {
      try {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 900 });
        clicked++;
        total++;
        await sleep(60);
      } catch {}
      if (Date.now() - start > 60_000) break;
    }
    if (clicked === 0 || Date.now() - start > 60_000) break;
    await sleep(250);
  }
  return total;
}

function buildPageUrl(base, n) {
  const u = new URL(base);
  u.searchParams.set("page", String(n));
  u.hash = "comments";
  return u.toString();
}

async function detectPages(page, startUrl) {
  // 1) DOM-Pagination versuchen
  await autoScroll(page, { totalMs: 1500 });
  const maxDom = await page.evaluate(() => {
    const isVisible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      if (el.closest("[hidden],[aria-hidden='true']")) return false;
      return true;
    };
    const nums = [];
    document.querySelectorAll("a[href*='page=']").forEach((a) => {
      if (!isVisible(a)) return;
      const m = (a.getAttribute("href") || "").match(/[?&]page=(\d+)/);
      if (m) nums.push(parseInt(m[1], 10));
      const t = parseInt((a.textContent || "").trim(), 10);
      if (!Number.isNaN(t)) nums.push(t);
    });
    return nums.length ? Math.max(...nums) : 1;
  });
  if (maxDom > 1) {
    const n = Math.min(maxDom, 50);
    return Array.from({ length: n }, (_, i) => buildPageUrl(startUrl, i + 1));
  }

  // 2) Fallback: sequentiell prüfen bis sich der erste Kommentar wiederholt
  const urls = [buildPageUrl(startUrl, 1)];
  let lastSig = await page.evaluate(() => {
    const c = document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment");
    if (!c) return "";
    const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const a = pick(c.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']"));
    const t = c.querySelector("time");
    const d = (t?.getAttribute("datetime") || (t?.textContent || "").trim() || "");
    const b = pick(c.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || c);
    return `${a}|${d}|${b.slice(0, 60)}`;
  });

  for (let i = 2; i <= 50; i++) {
    const test = buildPageUrl(startUrl, i);
    await page.goto(test, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureDealLoaded(page);
    await autoScroll(page, { totalMs: 3000 });
    const sig = await page.evaluate(() => {
      const c = document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment");
      if (!c) return "";
      const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
      const a = pick(c.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']"));
      const t = c.querySelector("time");
      const d = (t?.getAttribute("datetime") || (t?.textContent || "").trim() || "");
      const b = pick(c.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || c);
      return `${a}|${d}|${b.slice(0, 60)}`;
    });
    if (!sig || sig === lastSig) break;
    urls.push(test);
    lastSig = sig;
  }
  return urls;
}

async function screenshotPage(page, filePath) {
  // Fokus oben
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  // Vollseite
  await page.screenshot({ path: filePath, fullPage: true, type: "png" });
}

/* ---------- PDF aus PNGs ---------- */
async function pngsToPdf(pngPaths, outputPath) {
  const pdf = await PDFDocument.create();
  for (const p of pngPaths) {
    const bytes = fs.readFileSync(p);
    const img = await pdf.embedPng(bytes);
    // PDF arbeitet in Punkten (72 dpi). Playwright liefert ~CSS-Pixel (96 dpi).
    // Um Seitenlänge korrekt abzubilden: Punkte = Pixel * (72/96) = px * 0.75
    const wPt = img.width * 0.75;
    const hPt = img.height * 0.75;
    const page = pdf.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }
  fs.writeFileSync(outputPath, await pdf.save());
}

/* ======================= MAIN ======================= */
async function main() {
  const url = arg("url");
  if (!url) {
    console.error('Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..."');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 1000, deviceScaleFactor: 1 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });

  // CSS & JS zulassen; schwere Medien blocken
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "media" || t === "font") return route.abort();
    // Bilder lassen wir an – wir wollen visuell exakt rendern
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);

  console.log("→ Öffne:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await acceptCookies(page);
  await hideStickyUI(page);
  await ensureDealLoaded(page);
  await autoScroll(page, { totalMs: 4000 });

  // Kommentar-Seiten erkennen
  const pages = await detectPages(page, page.url());
  console.log(`→ Kommentar-Unterseiten erkannt: ${pages.length}`);

  const tmpDir = "shots";
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const pngPaths = [];
  for (let i = 0; i < pages.length; i++) {
    const u = pages[i];
    console.log(`\n=== Render ${i + 1}/${pages.length} ===`);
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await acceptCookies(page);
    await hideStickyUI(page);
    await ensureDealLoaded(page);

    // Alles laden und Antworten ausklappen
    await autoScroll(page, { totalMs: 6000 });
    await expandAllReplies(page, 14);
    // Nochmals scrollen, damit frisch geladene Replies sichtbar sind
    await autoScroll(page, { totalMs: 4000 });

    const file = path.join(tmpDir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await screenshotPage(page, file);
    pngPaths.push(file);
    console.log(`   ✓ Screenshot: ${file}`);
  }

  // PNGs -> PDF
  const output = "mydealz-output.pdf";
  await pngsToPdf(pngPaths, output);
  console.log(`\n✓ PDF erstellt: ${output} (Seiten: ${pngPaths.length})`);

  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
