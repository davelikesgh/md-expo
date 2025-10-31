import fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import { PDFDocument } from "pdf-lib";

chromium.use(Stealth());

// ---------- Args ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const dealUrl = arg("url");
if (!dealUrl || /^--/.test(dealUrl)) {
  console.error('Nutze: node scrape-mydealz.js --url "https://…"');
  process.exit(1);
}
const PAGE_PROBE_CAP = Number(arg("cap") || process.env.PAGE_CAP || 5);

// ---------- Utils ----------
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
    await page.mouse.wheel(0, 1400);
    await wait(90);
  }
}

async function expandAllReplies(page) {
  let total = 0;
  for (let round = 0; round < 15; round++) {
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
          await c.click({ timeout: 800 });
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

// ALLE sichtbaren Kommentar-IDs sammeln (ohne Replies, die noch zugeklappt sind)
async function collectCommentIds(page) {
  return await page.$$eval('*[id^="comment-"]', (els) =>
    els.map((el) => el.id.replace("comment-", "")).filter(Boolean)
  );
}

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

async function readDomMaxPage(page) {
  const nums = await page.$$eval("a[href*='page='], button[aria-label*='Seite']", (as) =>
    Array.from(
      new Set(
        as
          .map((a) => {
            const t = (a.innerText || a.ariaLabel || "").trim();
            const m = t.match(/\b(\d+)\b/);
            const u = (a.href || "").match(/page=(\d+)/);
            return Number((m && m[1]) || (u && u[1]) || 0);
          })
          .filter(Boolean)
      )
    )
  );
  return nums.length ? Math.max(...nums) : 1;
}

// Seiten entdecken – nur echte neue Inhalte zulassen
async function discoverPages(page, baseUrl) {
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

  const seenIds = new Set();       // alle bisher gesehenen Kommentar-IDs
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

  // Weitere Seiten probieren
  for (let p = 2; p <= PAGE_PROBE_CAP; p++) {
    const u = new URL(baseUrl);
    u.searchParams.set("page", p);
    u.hash = "comments";

    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureLoaded(page);
    await scrollWarmup(page, 600);

    // Redirect-Check: wirkliche Seite?
    const real = new URL(page.url());
    const realP = Number(real.searchParams.get("page") || "1");
    if (realP !== p) break;

    // IDs vor dem Ausklappen sammeln (nur „native“ Comments der Seite)
    const ids = await collectCommentIds(page);
    const newIds = ids.filter((id) => !seenIds.has(id));

    if (newIds.length === 0) break; // keine neuen Kommentare → keine echte neue Seite

    // akzeptieren
    newIds.forEach((id) => seenIds.add(id));
    urls.push(u.toString());
  }

  // URLs deduplizieren (Sicherheitsnetz)
  return Array.from(new Set(urls));
}

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

    // jetzt erst alles ausklappen und rendern
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
