// scrape-mydealz.js
// Usage (GitHub Action ruft so auf):
//   node scrape-mydealz.js --url "https://www.mydealz.de/diskussion/..." [--ntfy https://ntfy.sh/dein-topic]
import fs from "fs";
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Texte/Buttons auf mydealz, die das Ausklappen triggern
const BTN_TEXT = /(Mehr Antworten anzeigen|Weitere Antworten|Mehr Kommentare|Mehr anzeigen|Antworten anzeigen)/i;
const PAGIN_NEXT_TEXT = /(Nächste|Weiter|›|»)/i;

function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Playwright-Helfer ----------

// Sucht alle Seiten eines langen Threads (Pagination)
async function findAllPages(page) {
  const urls = new Set([page.url()]);
  for (let guard = 0; guard < 40; guard++) {
    // 1) klassisch: rel=next
    const relNext = await page.$("a[rel='next']");
    if (relNext) {
      const href = await relNext.getAttribute("href");
      if (!href) break;
      const abs = new URL(href, page.url()).toString();
      if (urls.has(abs)) break;
      urls.add(abs);
      await page.goto(abs, { waitUntil: "networkidle" });
      continue;
    }
    // 2) Fallback: Button/Link mit „Nächste/Weiter/›/»“
    const links = await page.$$("a,button");
    let moved = false;
    for (const h of links) {
      const txt = ((await h.innerText().catch(() => "")) || "").trim();
      if (PAGIN_NEXT_TEXT.test(txt)) {
        const href = await h.getAttribute("href");
        if (href) {
          const abs = new URL(href, page.url()).toString();
          if (urls.has(abs)) break;
          urls.add(abs);
          await page.goto(abs, { waitUntil: "networkidle" });
          moved = true;
          break;
        } else {
          await h.click().catch(() => {});
          await page.waitForLoadState("networkidle").catch(() => {});
          const u = page.url();
          if (!urls.has(u)) {
            urls.add(u);
            moved = true;
          }
          break;
        }
      }
    }
    if (!moved) break;
  }
  return Array.from(urls);
}

// Klickt wiederholt alle „Mehr Antworten“/„Mehr anzeigen“-Elemente.
// Wichtig: wir klicken *mit Playwright*, nicht nur per JS, damit Events „trusted“ wirken.
async function expandAllReplies(page, maxRounds = 25) {
  let total = 0;
  for (let r = 0; r < maxRounds; r++) {
    // sanft scrollen, damit lazy-load triggert
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1200);
      await sleep(150);
    }
    const loc = page.locator("button, a[role='button'], a, div[role='button']").filter({ hasText: BTN_TEXT });
    const count = await loc.count();
    if (count === 0) break;

    // nacheinander klicken (DOM verändert sich, daher jedes Mal neu auflösen)
    for (let i = 0; i < Math.min(count, 50); i++) {
      try {
        await loc.nth(i).scrollIntoViewIfNeeded();
        await loc.nth(i).click({ timeout: 3000 });
        total++;
        await sleep(120);
      } catch { /* ignorieren und weiter */ }
    }
    await sleep(400);
  }
  return total;
}

// Extrahiert Deal-Infos (Titel + Beschreibung) von der *Startseite*
async function extractDealInfo(page) {
  return await page.evaluate(() => {
    function pickText(el) {
      return el ? (el.innerText || el.textContent || "").trim() : "";
    }
    const titleEl =
      document.querySelector("[data-test='thread-title'], h1") ||
      document.querySelector("h1");
    const descEl =
      document.querySelector("[data-test*='description'], .threadBody, article .content, .userHtml") ||
      document.querySelector("article");

    const title = pickText(titleEl);
    const description = pickText(descEl);

    // (Optional) Bilder/LTE: wir sammeln nur ihre URLs als Textliste
    const imageEls = Array.from(document.querySelectorAll("img"));
    const images = imageEls
      .map((img) => img.getAttribute("src") || img.getAttribute("data-src"))
      .filter(Boolean)
      .slice(0, 12); // Limit: 12

    return { title, description, images };
  });
}

// Extrahiert *Kommentare* auf der aktuellen Seite.
// depth wird heuristisch über Einrückung geschätzt → dient für PDF-Einrückung.
async function extractCommentsOnPage(page) {
  return await page.evaluate(() => {
    const out = [];

    const nodes = document.querySelectorAll(
      "[data-test*='comment'], [id^='comment'], article, li, .comment, .c-comment"
    );

    function depthOf(el) {
      let x = 0, e = el;
      while (e && e !== document.body) {
        const st = getComputedStyle(e);
        const ml = parseInt(st.marginLeft) || 0;
        const pl = parseInt(st.paddingLeft) || 0;
        x += Math.max(ml, pl);
        e = e.parentElement;
      }
      return Math.max(0, Math.min(8, Math.round(x / 24))); // bis zu 8 Ebenen
    }

    function txt(el) { return (el?.innerText || el?.textContent || "").trim(); }

    for (const el of nodes) {
      // grober Filter: echte Kommentar-Knoten enthalten meist Text-Container
      const body =
        el.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || el;

      const text = txt(body);
      if (!text || text.length < 2) continue;

      const authorEl = el.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']");
      const timeEl   = el.querySelector("time");
      const scoreEl  = el.querySelector("[data-test*='vote'], [class*='vote'], [aria-label*='Gefällt']");

      out.push({
        author: txt(authorEl) || "—",
        datetime: (timeEl?.getAttribute("datetime") || txt(timeEl)) || "—",
        score: (scoreEl?.getAttribute?.("aria-label") || txt(scoreEl)) || "",
        text,
        depth: depthOf(el)
      });
    }
    return out;
  });
}

// ---------- PDF-Helfer ----------

async function buildPDF({ deal, allComments, output = "mydealz-output.pdf" }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Seite anlegen
  let page = pdf.addPage([595.28, 841.89]); // A4 pt
  const margin = 36;
  const lineH = 13; // Zeilenhöhe
  const maxWidth = page.getWidth() - margin * 2;
  let cursorY = page.getHeight() - margin;

  function newPage() {
    page = pdf.addPage([595.28, 841.89]);
    cursorY = page.getHeight() - margin;
  }

  function wrapLines(str, fontObj, size, width) {
    const words = (str || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      const tw = fontObj.widthOfTextAtSize(test, size);
      if (tw > width && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    // harte Zeilenumbrüche respektieren
    return lines
      .map(l => l.split(/\n/))
      .flat();
  }

  function drawTextBlock(text, { size = 11, bold = false, color = rgb(0,0,0), indent = 0 } = {}) {
    const f = bold ? fontBold : font;
    const width = maxWidth - indent;
    const lines = (text || "")
      .split(/\n\n+/) // Absätze
      .flatMap(par => {
        const wrapped = wrapLines(par, f, size, width);
        return wrapped.length ? [...wrapped, ""] : [""];
      });

    for (const ln of lines) {
      if (cursorY - lineH < margin) newPage();
      page.drawText(ln, { x: margin + indent, y: cursorY - lineH, size, font: f, color });
      cursorY -= lineH;
    }
  }

  // Titel
  drawTextBlock(deal.title || "Mydealz Thread", { size: 16, bold: true, color: rgb(0.05,0.05,0.35) });
  // URL (falls gewünscht als Text – hier ausgelassen, kann aber ergänzt werden)

  // Deal-Beschreibung
  if (deal.description) {
    drawTextBlock("Dealbeschreibung", { size: 12, bold: true });
    drawTextBlock(deal.description, { size: 11 });
  }

  // (Optional) Bild-URLs auflisten
  if (deal.images && deal.images.length) {
    drawTextBlock("Bilder (URLs):", { size: 12, bold: true });
    for (const u of deal.images) drawTextBlock(u, { size: 10, color: rgb(0.25,0.25,0.25) });
  }

  // Kommentare
  drawTextBlock("Kommentare", { size: 12, bold: true });
  drawTextBlock(`Gesamt: ${allComments.length}`, { size: 10, color: rgb(0.25,0.25,0.25) });

  for (const c of allComments) {
    const indent = Math.min(8, Math.max(0, c.depth || 0)) * 12; // 12pt pro Ebene
    drawTextBlock(`${c.author}  —  ${c.datetime}  ${c.score ? " — "+c.score : ""}`, { bold: true, size: 10, indent });
    drawTextBlock(c.text, { size: 10, indent });
    cursorY -= 6; // kleine Lücke
    if (cursorY < margin + 40) newPage();
  }

  const bytes = await pdf.save();
  fs.writeFileSync(output, bytes);
  return output;
}

// ---------- Main ----------

async function main() {
  const url = arg("url");
  const ntfy = arg("ntfy", null);
  if (!url) {
    console.error('Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..." [--ntfy https://ntfy.sh/topic]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  // 1) Startseite laden
  await page.goto(url, { waitUntil: "networkidle" });

  // Cookie-Dialog (falls vorhanden) wegklicken
  try {
    const consent = page.locator("button:has-text('Akzeptieren'), button:has-text('Einverstanden'), button:has-text('Zustimmen')");
    if (await consent.count()) await consent.first().click({ timeout: 2000 }).catch(() => {});
  } catch {}

  // 2) Deal-Infos
  const deal = await extractDealInfo(page);

  // 3) Alle Seiten finden (Pagination)
  const pages = await findAllPages(page);

  // 4) Alle Seiten abarbeiten → ausklappen → Kommentare sammeln
  const allComments = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    await page.goto(p, { waitUntil: "networkidle" });
    await expandAllReplies(page, 28);
    const part = await extractCommentsOnPage(page);
    allComments.push(...part);
    await sleep(400);
  }

  // 5) PDF erzeugen (eine Datei, kompletter Deal + alle Kommentare)
  const outFile = await buildPDF({ deal, allComments, output: "mydealz-output.pdf" });
  console.log(`PDF erstellt: ${outFile} (Kommentare: ${allComments.length})`);

  // 6) (optional) ntfy-Ping
  if (ntfy) {
    try {
      const msg = `Mydealz Export ✓\nKommentare: ${allComments.length}\nDatei: mydealz-output.pdf`;
      await fetch(ntfy, { method: "POST", body: msg, headers: { Title: "Mydealz PDF erstellt", Tags: "floppy_disk" } });
    } catch (e) {
      console.error("ntfy error:", e.message);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
