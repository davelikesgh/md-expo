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

// wie viele Seiten maximal probieren (Sicherheits-Cap)
const PAGE_PROBE_CAP = Number(getArg("cap") || process.env.PAGE_CAP || 10);

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acceptCookies(page) {
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
      await sleep(300);
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

async function autoScroll(page, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.mouse.wheel(0, 1400);
    await sleep(100);
  }
}

async function getCommentSignature(page) {
  // nimmt die ersten drei comment-IDs (z.B. id="comment-123456")
  const ids = await page.$$eval('*[id^="comment-"]', (els) =>
    els.slice(0, 3).map((e) => e.id)
  );
  return ids.join("|");
}

// klappt „mehr Antworten/mehr anzeigen“ mehrfach
async function expandAllReplies(page) {
  let total = 0;
  for (let round = 0; round < 15; round++) {
    const controls = await page.locator("button, a, div[role='button']").all();
    let clicked = 0;
    for (const c of controls) {
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
          await sleep(180);
        } catch {}
      }
    }
    if (!clicked) break;
    await autoScroll(page, 600);
  }
  return total;
}

async function screenshotFull(page, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(120);
  await page.screenshot({ path: file, fullPage: true });
}

async function pngsToPdf(pngFiles, out) {
  const pdf = await PDFDocument.create();
  for (const p of pngFiles) {
    const bytes = fs.readFileSync(p);
    const img = await pdf.embedPng(bytes);
    const scale = 0.75;
    const w = img.width * scale;
    const h = img.height * scale;
    const pg = pdf.addPage([w, h]);
    pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  fs.writeFileSync(out, await pdf.save());
}

// ---- robuste Seitenerkennung ----
async function discoverAllCommentPages(page, baseUrl) {
  // 1) DOM-Scan
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(600);
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

  // 2) Fallback-Probing mit Signaturvergleich
  if (max < 2) {
    const u0 = new URL(baseUrl);
    // Signatur der ersten Seite holen
    const sig1 = await getCommentSignature(page);

    for (let p = 2; p <= PAGE_PROBE_CAP; p++) {
      const u = new URL(u0.toString());
      u.searchParams.set("page", p);
      u.hash = "comments";

      await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await ensureLoaded(page);
      await autoScroll(page, 600);

      const sigN = await getCommentSignature(page);
      if (!sigN) break;                 // keine Comments → Seite existiert nicht
      if (sigN === sig1) break;         // gleiche Signatur wie Seite 1 → keine echte Folgeseite

      max = p;                          // echte Folge-Seite gefunden
    }

    // zurück auf Seite 1
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }

  // 3) Liste bauen
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
  await autoScroll(page, 1200);

  // Cloudflare?
  if (await page.locator("text=Verifying you are human").isVisible().catch(() => false)) {
    console.log("⚠️ Cloudflare – warte 10s…");
    await sleep(10000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  const pages = await discoverAllCommentPages(page, dealUrl);
  console.log("→ Kommentar-Unterseiten erkannt:", pages.length);

  const dir = "shots";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const shots = [];

  for (let i = 0; i < pages.length; i++) {
    console.log(`=== Render ${i + 1}/${pages.length} ===`);
    await page.goto(pages[i], { waitUntil: "domcontentloaded", timeout: 90000 });
    await acceptCookies(page);
    await hideUI(page);
    await ensureLoaded(page);
    await autoScroll(page, 1500);

    const expanded = await expandAllReplies(page);
    console.log("   ausgeklappt:", expanded);

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
