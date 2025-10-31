import fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import { PDFDocument } from "pdf-lib";

chromium.use(Stealth());

// ---------- Args ----------
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const dealUrl = getArg("url");
if (!dealUrl || /^--/.test(dealUrl)) {
  console.error("❌ Bitte starte mit:  node scrape-mydealz.js --url \"https://…\"");
  process.exit(1);
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acceptCookies(page) {
  const sels = [
    "button:has-text('Akzeptieren')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Einverstanden')",
    "[data-testid='uc-accept-all-button']",
  ];
  for (const s of sels) {
    const el = page.locator(s).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await sleep(400);
      break;
    }
  }
}

async function hideUI(page) {
  await page.addStyleTag({
    content: `
      header, .header, [id*="cookie"], [class*="cookie"], [class*="sticky"],
      .banner, .modal, .toast, .top-bar, .bottom-bar { display:none !important; }
      ::-webkit-scrollbar { display:none!important; } body{scrollbar-width:none!important;}
    `,
  });
}

async function ensureLoaded(page) {
  await page.waitForSelector("h1, [data-test='thread-title']", { timeout: 20000 }).catch(() => {});
}

async function autoScroll(page, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await page.mouse.wheel(0, 1200);
    await sleep(120);
  }
}

// klappt „mehr Antworten anzeigen“ & ähnliche, mehrere Runden
async function expandAllReplies(page) {
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const items = await page.locator("button, a, div[role='button']").all();
    let clicked = 0;
    for (const it of items) {
      const txt = ((await it.textContent()) || "").toLowerCase();
      if (
        txt.includes("mehr antworten anzeigen") ||
        txt.includes("weitere antworten") ||
        txt.includes("antworten anzeigen") ||
        txt.includes("mehr anzeigen") ||
        txt.includes("more replies") ||
        txt.includes("view more")
      ) {
        try {
          await it.scrollIntoViewIfNeeded();
          await it.click({ timeout: 900 });
          clicked++; total++;
          await sleep(220);
        } catch {}
      }
    }
    if (!clicked) break;
    await autoScroll(page, 800);
  }
  return total;
}

async function screenshotFull(page, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(150);
  await page.screenshot({ path: file, fullPage: true });
}

async function pngsToPdf(pngFiles, out) {
  const pdf = await PDFDocument.create();
  for (const p of pngFiles) {
    const bytes = fs.readFileSync(p);
    const img = await pdf.embedPng(bytes);
    const scale = 0.75; // A4-freundliche Größe
    const w = img.width * scale;
    const h = img.height * scale;
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  fs.writeFileSync(out, await pdf.save());
}

// ---- robuste Seitenerkennung ----
async function discoverAllCommentPages(page, baseUrl) {
  // 1) DOM-Scan (Paginierung kann unten stehen)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(800);

  const domPages = await page.$$eval("a[href*='page=']", (links) =>
    Array.from(
      new Set(
        links
          .map((a) => (a.href.match(/page=(\d+)/) || [])[1])
          .filter(Boolean)
          .map(Number)
      )
    )
  );
  let max = domPages.length ? Math.max(...domPages) : 1;

  // 2) Fallback: sequentiell probieren (endet sobald Seite „zurückspringt“)
  if (max < 2) {
    const urlObj = new URL(baseUrl);
    for (let p = 2; p <= 50; p++) {
      const test = new URL(urlObj.toString());
      test.searchParams.set("page", p);
      test.hash = "comments";
      await page.goto(test.toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      // Wenn die URL nach dem Laden NICHT auf page=p steht, gibt es diese Seite nicht
      const curP = Number(new URL(page.url()).searchParams.get("page") || "1");
      if (curP !== p) break;
      max = p;
    }
    // zurück auf Seite 1
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }

  // 3) Liste 1..max bauen
  return Array.from({ length: max }, (_, i) => {
    const u = new URL(baseUrl);
    u.searchParams.set("page", i + 1);
    u.hash = "comments";
    return u.toString();
  });
}

// ---------- Main ----------
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
  await acceptCookies(page);
  await hideUI(page);
  await ensureLoaded(page);

  // Cloudflare warten
  if (await page.locator("text=Verifying you are human").isVisible().catch(() => false)) {
    console.log("⚠️ Cloudflare – warte 10s…");
    await sleep(10000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  await autoScroll(page, 1500);

  // → alle Kommentar-Unterseiten ermitteln
  const pages = await discoverAllCommentPages(page, dealUrl);
  console.log("→ Kommentar-Unterseiten erkannt:", pages.length);

  // → jede Seite rendern
  const dir = "shots";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const shots = [];

  for (let i = 0; i < pages.length; i++) {
    console.log(`=== Render ${i + 1}/${pages.length} ===`);
    await page.goto(pages[i], { waitUntil: "domcontentloaded", timeout: 90000 });
    await acceptCookies(page);
    await hideUI(page);
    await ensureLoaded(page);
    await autoScroll(page, 2000);

    const expanded = await expandAllReplies(page);
    console.log("   ausgeklappt:", expanded);
    await autoScroll(page, 1200);

    const file = path.join(dir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await screenshotFull(page, file);
    shots.push(file);
    console.log("   ✓ Screenshot:", file);
  }

  const out = "mydealz-output.pdf";
  await pngsToPdf(shots, out);
  console.log("✓ PDF erstellt:", out);

  await browser.close();
})().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
