// scrape-mydealz.js — Fix für dynamisches Nachladen auf MyDealz
// by ChatGPT 2025
import fs from "fs";
import { chromium } from "playwright";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const BTN_TEXT = /(Mehr Antworten anzeigen|Weitere Antworten)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d = null) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : d;
};

async function extractDealHead(page) {
  return await page.evaluate(() => {
    const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const out = {};
    out.title =
      pick(document.querySelector("[data-test='thread-title']")) ||
      pick(document.querySelector("h1")) ||
      "MyDealz Deal";
    out.price =
      pick(document.querySelector("[data-test='thread-price']")) ||
      pick(document.querySelector(".thread-price")) ||
      "";
    out.merchant =
      pick(document.querySelector("[data-test='merchant-name']")) ||
      pick(document.querySelector("[class*='merchant']")) ||
      "";
    out.expiry =
      pick(document.querySelector("[data-test='deal-expiry-date']")) ||
      pick(document.querySelector("[class*='deal-expiry']")) ||
      "";
    out.link = document.querySelector("a[data-test='thread-deal-link']")?.href || location.href;
    out.description =
      pick(document.querySelector("[data-test*='description'], .threadBody, article .content, .userHtml")) ||
      "";
    out.images = Array.from(document.querySelectorAll("img"))
      .map((img) => img.src)
      .filter((x) => x && !x.startsWith("data:"))
      .slice(0, 10);
    return out;
  });
}

async function extractComments(page) {
  return await page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll(
      "[data-test*='comment'], [id^='comment'], .c-comment, .comment"
    );
    const txt = (el) => (el?.innerText || el?.textContent || "").trim();
    const depthOf = (el) => {
      let x = 0, e = el;
      while (e && e !== document.body) {
        const s = getComputedStyle(e);
        x += Math.max(parseInt(s.marginLeft) || 0, parseInt(s.paddingLeft) || 0);
        e = e.parentElement;
      }
      return Math.max(0, Math.min(8, Math.round(x / 24)));
    };
    for (const el of nodes) {
      const body =
        el.querySelector("[data-test*='body'], [class*='body'], .md, .markdown, p") || el;
      const text = txt(body);
      if (!text || text.length < 3) continue;
      const author = txt(
        el.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']")
      ) || "—";
      const timeEl = el.querySelector("time");
      const time = timeEl?.getAttribute("datetime") || txt(timeEl) || "—";
      const score = txt(el.querySelector("[data-test*='vote'], [class*='vote'], [aria-label*='Gefällt']"));
      out.push({ author, datetime: time, score, text, depth: depthOf(el) });
    }
    return out;
  });
}

function deduplicate(comments) {
  const seen = new Set();
  return comments.filter((c) => {
    const key = c.author + "|" + c.text.slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function expandAllReplies(page, maxRounds = 10) {
  let total = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const buttons = page
      .locator("[data-test*='comment'] >> :is(button,a[role='button'],a,div[role='button'])")
      .filter({ hasText: BTN_TEXT });
    const n = await buttons.count();
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      try {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 800 });
        total++;
        await sleep(50);
      } catch {}
    }
    await sleep(200);
  }
  return total;
}

function findFontPath() {
  const fonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
  ];
  for (const f of fonts) if (fs.existsSync(f)) return f;
  throw new Error("Kein Font gefunden.");
}

async function makePDF({ deal, comments, output = "mydealz-output.pdf" }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(findFontPath()), { subset: true });
  let page = pdf.addPage([595.28, 841.89]);
  const margin = 36, width = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;
  const lh = 12;
  const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = page.getHeight() - margin; };
  const draw = (t, { size = 10, color = rgb(0, 0, 0), indent = 0 } = {}) => {
    for (const line of (t || "").split(/\r?\n/)) {
      if (y - lh < margin) newPage();
      page.drawText(line, { x: margin + indent, y: y - lh, size, font, color });
      y -= lh;
    }
  };
  draw(deal.title, { size: 15, color: rgb(0.1, 0.1, 0.5) });
  draw("");
  draw(`💰 Preis: ${deal.price}`);
  draw(`🏷️ Händler: ${deal.merchant}`);
  draw(`📅 Ablaufdatum: ${deal.expiry}`);
  draw(`🔗 Link: ${deal.link}`);
  draw("");
  draw("📝 Beschreibung:");
  draw(deal.description);
  if (deal.images.length) {
    draw("");
    draw("🖼️ Bilder:");
    deal.images.forEach((u) => draw(u, { size: 8, color: rgb(0.3, 0.3, 0.3) }));
  }
  draw("");
  draw("──────────────────────────────", { color: rgb(0.2, 0.2, 0.2) });
  draw("");
  draw(`💬 Kommentare (${comments.length}):`);
  draw("");
  for (const c of comments) {
    const indent = Math.min(8, c.depth) * 12;
    draw(`${c.author} — ${c.datetime}${c.score ? " — " + c.score : ""}`, { size: 9, indent });
    draw(c.text, { size: 9, indent });
    y -= 6;
  }
  fs.writeFileSync(output, await pdf.save());
  return output;
}

async function main() {
  const url = arg("url");
  if (!url) return console.error("Usage: --url <DealURL>");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route("**/*", (r) => {
    const t = r.request().resourceType();
    if (["image", "media", "font"].includes(t)) return r.abort();
    r.continue();
  });
  const page = await ctx.newPage();

  console.log("→ Lade Deal:", url);
  await page.goto(url, { waitUntil: "networkidle" }); // 🟢 1. jetzt auf echtes Laden warten
  await page.waitForSelector("[data-test='thread-title'], h1", { timeout: 15000 }); // 🟢 2. sicheres Element abwarten
  await sleep(1000); // 🟢 3. Pufferzeit, damit JS-Content fertig ist

  const deal = await extractDealHead(page);
  console.log("✓ Dealkopf geladen:", deal.title);

  const comments = await extractComments(page);
  console.log("✓ Kommentare gefunden:", comments.length);

  const deduped = deduplicate(comments);
  await makePDF({ deal, comments: deduped });
  console.log("✓ PDF erstellt: mydealz-output.pdf");
  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
