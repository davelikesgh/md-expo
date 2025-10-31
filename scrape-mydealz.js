// scrape-mydealz.js
import fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import { PDFDocument } from "pdf-lib";

chromium.use(Stealth());

// ---------- CLI / ENV ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const dealUrl = arg("url");
if (!dealUrl || /^--/.test(dealUrl)) {
  console.error('Nutze: node scrape-mydealz.js --url "https://…"');
  process.exit(1);
}
const PAGE_PROBE_CAP = Number(arg("cap") || process.env.PAGE_CAP || 8);
const FORCE_PAGES = Number(arg("forcePages") || process.env.FORCE_PAGES || 0);

// ---------- helpers ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickCookies(page) {
  const sels = [
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Akzeptieren')",
    "button:has-text('Einverstanden')",
    "[data-testid='uc-accept-all-button']",
  ];
  for (const s of sels) {
    const el = page.locator(s).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await wait(250);
      break;
    }
  }
}

async function hideOverlays(page) {
  await page.addStyleTag({
    content: `
      header, .header, [id*="cookie"], [class*="cookie"], [class*="sticky"],
      .banner, .modal, .toast, .top-bar, .bottom-bar { display:none !important; }
      ::-webkit-scrollbar{display:none!important}
      body{scrollbar-width:none!important}
    `,
  });
}

async function ensureLoaded(page) {
  await page.waitForSelector("h1, [data-test='thread-title']", { timeout: 20000 }).catch(() => {});
}

async function scrollWarmup(page, ms = 1100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.mouse.wheel(0, 1300);
    await wait(90);
  }
}

async function expandAllReplies(page) {
  let total = 0;
  for (let round = 0; round < 16; round++) {
    const ctrls = await page.locator("button, a, div[role='button']").all();
    let clicked = 0;
    for (const c of ctrls) {
      const txt = ((await c.textContent()) || "").toLowerCase();
      if (
        txt.includes("mehr antworten anzeigen") ||
        txt.includes("weitere antworten") ||
        txt.includes("antworten anzeigen") ||
        txt.includes("mehr anzeigen") ||
        txt.includes("more replies") ||
        txt.includes("view more")
      ) {
        try {
          await c.scrollIntoViewIfNeeded();
          await c.click({ timeout: 900 });
          clicked++; total++;
          await wait(140);
        } catch {}
      }
    }
    if (!clicked) break;
    await scrollWarmup(page, 500);
  }
  return total;
}

// --- Kommentar-IDs robust einsammeln (vor dem Ausklappen) ---
async function collectCommentIds(page) {
  const ids = await page.evaluate(() => {
    const set = new Set();
    // id="comment-123"
    document.querySelectorAll('[id^="comment-"]').forEach(el => {
      const m = el.id.match(/^comment-(\d+)/);
      if (m) set.add(m[1]);
    });
    // data-comment-id
    document.querySelectorAll("[data-comment-id]").forEach(el => {
      const v = el.getAttribute("data-comment-id");
      if (v) set.add(v);
    });
    // data-testid enthält "comment"
    document.querySelectorAll('[data-testid*="comment"]').forEach(el => {
      const v = el.getAttribute("data-testid");
      // oft z.B. "comment-123456"
      const m = v && v.match(/(\d{4,})/);
      if (m) set.add(m[1]);
    });
    // article[data-test="comment"]
    document.querySelectorAll('article[data-test="comment"]').forEach(el => {
      // versuche in Unterelementen IDs abzuleiten
      const byId = el.querySelector('[id^="comment-"]');
      if (byId) {
        const m = byId.id.match(/^comment-(\d+)/);
        if (m) set.add(m[1]);
      }
      const byData = el.querySelector("[data-comment-id]");
      if (byData) {
        const v = byData.getAttribute("data-comment-id");
        if (v) set.add(v);
      }
    });
    return Array.from(set);
  });
  return ids;
}

// PNG -> PDF
async function pngsToPdf(pngPaths, outPath) {
  const pdf = await PDFDocument.create();
  for (const p of pngPaths) {
    const bytes = fs.readFileSync(p);
    const img = await pdf.embedPng(bytes);
    const scale = 0.75;
    const w = img.width * scale;
    const h = img.height * scale;
    const pg = pdf.addPage([w, h]);
    pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  fs.writeFileSync(outPath, await pdf.save());
}

// DOM-Pagination lesen (größte Seitenzahl)
async function readDomMaxPage(page) {
  // Suche Zahlen in Pagination-Leiste
  const nums = await page.$$eval("a[href*='page='], button[aria-label*='Seite'], nav, ul", (nodes) => {
    const set = new Set();
    nodes.forEach((n) => {
      const txt = (n.innerText || n.textContent || "").trim();
      // Zahlen wie "1", "2", "3", "Seite 2", "… 1 2 …"
      (txt.match(/\b\d+\b/g) || []).forEach((d) => set.add(Number(d)));
      // Links mit page=N
      n.querySelectorAll("a[href*='page=']").forEach((a) => {
        const m = a.href.match(/page=(\d+)/);
        if (m) set.add(Number(m[1]));
      });
    });
    return Array.from(set);
  });
  if (!nums.length) return 1;
  return Math.max(...nums);
}

// Seitenliste bestimmen
async function discoverPages(page, baseUrl) {
  // Override erlaubt (z. B. --forcePages 2)
  if (FORCE_PAGES && FORCE_PAGES > 0) {
    return Array.from({ length: FORCE_PAGES }, (_, i) => {
      const u = new URL(baseUrl);
      u.searchParams.set("page", i + 1);
      u.hash = "comments";
      return u.toString();
    });
  }

  await scrollWarmup(page, 600);
  let domMax = await readDomMaxPage(page);
  if (domMax > 1) {
    return Array.from({ length: domMax }, (_, i) => {
      const u = new URL(baseUrl);
      u.searchParams.set("page", i + 1);
      u.hash = "comments";
      return u.toString();
    });
  }

  // Fallback mit ID-Vergleich
  const seenIds = new Set();
  const urls = [];
  const u0 = new URL(baseUrl);
  u0.hash = "comments";

  // Seite 1
  await page.goto(u0.toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await ensureLoaded(page);
  await scrollWarmup(page, 700);
  const ids1 = await collectCommentIds(page);
  ids1.forEach((id) => seenIds.add(id));
  urls.push(u0.toString());

  for (let p = 2; p <= PAGE_PROBE_CAP; p++) {
    const u = new URL(baseUrl);
    u.searchParams.set("page", p);
    u.hash = "comments";

    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureLoaded(page);
    await scrollWarmup(page, 600);

    // tatsächlich auf page=N?
    const real = new URL(page.url());
    const realP = Number(real.searchParams.get("page") || "1");
    if (realP !== p) break;

    const ids = await collectCommentIds(page);
    const newIds = ids.filter((id) => !seenIds.has(id));
    if (newIds.length === 0) break; // keine neuen Kommentare

    newIds.forEach((id) => seenIds.add(id));
    urls.push(u.toString());
  }
  return Array.from(new Set(urls));
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const page = await ctx.newPage();

  console.log("→ Öffne:", dealUrl);
  await page.goto(dealUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await clickCookies(page);
  await hideOverlays(page);
  await ensureLoaded(page);

  // Cloudflare-Wartefenster?
  if (await page.locator("text=Verifying you are human").isVisible().catch(() => false)) {
    console.log("⚠️ Cloudflare: 10s warten …");
    await wait(10000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  const pages = await discoverPages(page, dealUrl);
  console.log("→ Kommentar-Unterseiten erkannt:", pages.length);

  if (!fs.existsSync("shots")) fs.mkdirSync("shots");
  const images = [];

  for (let i = 0; i < pages.length; i++) {
    console.log(`=== Render ${i + 1}/${pages.length} ===`);
    await page.goto(pages[i], { waitUntil: "domcontentloaded", timeout: 90000 });
    await clickCookies(page);
    await hideOverlays(page);
    await ensureLoaded(page);
    await scrollWarmup(page, 1100);

    const expanded = await expandAllReplies(page);
    console.log("   ausgeklappt:", expanded);

    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(120);
    const file = path.join("shots", `shot-${String(i + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    images.push(file);
    console.log("   ✓ Screenshot:", file);
  }

  const out = "mydealz-output.pdf";
  await pngsToPdf(images, out);
  console.log("✓ PDF erstellt:", out);

  await browser.close();
})().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
