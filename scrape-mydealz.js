// scrape-mydealz.js — Screenshot-Modus (alle Antworten ausklappen + Vollseiten-Screenshots)
// Usage (wie bisher):
//   node scrape-mydealz.js --url "https://www.mydealz.de/deals/..."

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};

// Texte, die auf Mydealz für „Replies ausklappen“ vorkommen (robust, case-insensitive)
const REPLY_TEXTS = [
  "mehr antworten anzeigen",
  "weitere antworten",
  "antworten anzeigen",
  "more replies",          // fallback
  "view more replies"      // fallback
];

async function acceptCookies(page) {
  const candidates = [
    "//button[contains(., 'Akzeptieren')]",
    "//button[contains(., 'Alle akzeptieren')]",
    "//button[contains(., 'Zustimmen')]",
    "//button[contains(., 'Einverstanden')]",
    "button[aria-label*='kzept']",
    "[data-testid='uc-accept-all-button']",
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 400 });
        await sleep(300);
        break;
      }
    } catch {}
  }
}

async function hideStickyUI(page) {
  await page.addStyleTag({
    content: `
      * { scroll-behavior: auto !important; }
      header, .header, .app--header, [data-test*="header"], [data-test*="sticky"],
      .cookie, .consent, [aria-label*="cookie"], .toast, .modal, .Popover, .tooltip,
      .banner, .sticky, .bottom-bar, .top-bar, .gdpr, .newsletter,
      [class*="cookie"], [class*="consent"], [id*="cookie"] { display: none !important; }
      ::-webkit-scrollbar{ display:none !important; } body{ scrollbar-width: none !important; }
    `,
  });
}

async function ensureDealLoaded(page) {
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
  let last = await page.evaluate(() => document.documentElement.scrollHeight);
  while (Date.now() - start < totalMs) {
    await page.mouse.wheel(0, stepPx);
    await sleep(pauseMs);
    const cur = await page.evaluate(() => document.documentElement.scrollHeight);
    if (cur <= last) {
      await sleep(250);
      const check = await page.evaluate(() => document.documentElement.scrollHeight);
      if (check <= last) break;
    }
    last = cur;
  }
}

function buildPageUrl(base, n) {
  const u = new URL(base);
  u.searchParams.set("page", String(n));
  u.hash = "comments";
  return u.toString();
}

async function detectPages(page, startUrl) {
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

  // Fallback: sequential probe bis sich erster Kommentar wiederholt
  const urls = [buildPageUrl(startUrl, 1)];
  const firstSig = async () =>
    await page.evaluate(() => {
      const c = document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment");
      if (!c) return "";
      const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
      const a = pick(c.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']"));
      const t = c.querySelector("time");
      const d = (t?.getAttribute("datetime") || (t?.textContent || "").trim() || "");
      const b = pick(c.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || c);
      return `${a}|${d}|${b.slice(0, 60)}`;
    });

  let last = await firstSig();
  for (let i = 2; i <= 50; i++) {
    const test = buildPageUrl(startUrl, i);
    await page.goto(test, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureDealLoaded(page);
    await autoScroll(page, { totalMs: 2000 });
    const sig = await firstSig();
    if (!sig || sig === last) break;
    urls.push(test);
    last = sig;
  }
  return urls;
}

/* ----------------- HARTNÄCKIGES AUSKLAPPEN ----------------- */
function makeReplyLocator(page) {
  // erst nur in Kommentaren suchen (robuster)
  const container = "[data-test*='comment'], [id^='comment'], .c-comment, .comment";
  // :has-text ist case-insensitive; vor allem auf „Mehr Antworten anzeigen“ achten
  const parts = REPLY_TEXTS.map(t => `${container} >> :is(button,a,div[role='button'])[has-text('${t}')]`);
  // zusätzlich sehr breite Fallback-Suche (falls DOM-Struktur anders ist)
  parts.push(`:is(button,a,div[role='button'])[has-text('Mehr Antworten anzeigen')]`);
  parts.push(`:is(button,a,div[role='button'])[has-text('Weitere Antworten')]`);
  return page.locator(parts.join(", "));
}

async function expandAllReplies(page, { maxRounds = 20, scrollBetween = true } = {}) {
  let totalClicked = 0;
  const start = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    const loc = makeReplyLocator(page);
    let n = await loc.count();
    if (n === 0) {
      // evtl. erst durch Scrollen sichtbar machen
      await autoScroll(page, { totalMs: 1200, stepPx: 1800, pauseMs: 100 });
      n = await loc.count();
      if (n === 0) break;
    }

    let clickedThisRound = 0;
    for (let i = 0; i < n; i++) {
      try {
        const b = loc.nth(i);
        if (!(await b.isVisible())) continue;
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 1000 });
        clickedThisRound++;
        totalClicked++;
        // kurzer Wait, damit DOM die neuen Antworten rendert
        await sleep(120);
      } catch {}
      if (Date.now() - start > 90_000) break; // safety break
    }

    // falls wir geklickt haben, nochmal scrollen, um neue Buttons nachzuladen
    if (clickedThisRound > 0 && scrollBetween) {
      await autoScroll(page, { totalMs: 1400, stepPx: 2000, pauseMs: 90 });
    }

    if (clickedThisRound === 0 || Date.now() - start > 90_000) break;
  }

  // letzter Durchlauf: ganz nach unten, dann nochmal ganz nach oben
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);

  return totalClicked;
}

/* ----------------- Screenshots & PDF ----------------- */
async function screenshotPage(page, filePath) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await page.screenshot({ path: filePath, fullPage: true, type: "png" });
}

async function pngsToPdf(pngPaths, outputPath) {
  const pdf = await PDFDocument.create();
  for (const p of pngPaths) {
    const bytes = fs.readFileSync(p);
    const img = await pdf.embedPng(bytes);
    const wPt = img.width * 0.75;     // 96 CSS px -> 72 pt
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

  // Bilder zulassen (wir wollen exakte Optik), nur Medien/Fonts blocken
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "media" || t === "font") return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);

  console.log("→ Öffne:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await acceptCookies(page);
  await hideStickyUI(page);
  await ensureDealLoaded(page);
  await autoScroll(page, { totalMs: 3000 });

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

    // Erst alles laden …
    await autoScroll(page, { totalMs: 5000 });
    // … dann mit „starkem“ Verfahren ALLE Antworten ausklappen
    const clicks = await expandAllReplies(page, { maxRounds: 20, scrollBetween: true });
    console.log(`   ausgeklappt: ${clicks}`);
    // Noch einmal scrollen, damit frisch geöffnetes im DOM fix ist
    await autoScroll(page, { totalMs: 2500 });

    const file = path.join(tmpDir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await screenshotPage(page, file);
    pngPaths.push(file);
    console.log(`   ✓ Screenshot: ${file}`);
  }

  const output = "mydealz-output.pdf";
  await pngsToPdf(pngPaths, output);
  console.log(`\n✓ PDF erstellt: ${output} (Seiten: ${pngPaths.length})`);

  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
