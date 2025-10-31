// scrape-mydealz.js
// Usage:
//   node scrape-mydealz.js --url "https://www.mydealz.de/..." [--ntfy https://ntfy.sh/topic]
import fs from "fs";
import { chromium } from "playwright";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// Nur echte Reply-Expander
const BTN_TEXT = /(Mehr Antworten anzeigen|Weitere Antworten)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};

/* -------------------- Extraction helpers -------------------- */
async function extractDealInfo(page) {
  return await page.evaluate(() => {
    const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const titleEl =
      document.querySelector("[data-test='thread-title']") || document.querySelector("h1");
    const descEl =
      document.querySelector("[data-test*='description'], .threadBody, article .content, .userHtml") ||
      document.querySelector("article");
    const imgs = Array.from(document.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") || img.getAttribute("data-src"))
      .filter(Boolean)
      .slice(0, 12);
    return {
      title: pick(titleEl) || "Mydealz Thread",
      description: pick(descEl),
      images: imgs
    };
  });
}

async function extractCommentsOnPage(page) {
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
        el.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || el;
      const t = txt(body);
      if (!t || t.length < 2) continue;

      const authorEl = el.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']");
      const timeEl = el.querySelector("time");
      const scoreEl = el.querySelector("[data-test*='vote'], [class*='vote'], [aria-label*='Gefällt']");

      out.push({
        author: txt(authorEl) || "—",
        datetime: (timeEl?.getAttribute("datetime") || txt(timeEl)) || "—",
        score: (scoreEl?.getAttribute?.("aria-label") || txt(scoreEl)) || "",
        text: t,
        depth: depthOf(el)
      });
    }
    return out;
  });
}

/* -------------------- PDF (Unicode-Font mit fontkit) -------------------- */
function findFontPath() {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  throw new Error("Kein Unicode-Font gefunden (DejaVuSans / NotoSans).");
}

async function buildPDF({ deal, comments, output = "mydealz-output.pdf" }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const fontPath = findFontPath();
  const fontBytes = fs.readFileSync(fontPath);
  const font = await pdf.embedFont(fontBytes, { subset: true });

  let page = pdf.addPage([595.28, 841.89]); // A4
  const margin = 36;
  const lineH = 12;
  const maxWidth = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;

  const newPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = page.getHeight() - margin;
  };

  const wrap = (text, f, size, width) => {
    const words = (text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const cand = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(cand, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = cand;
    }
    if (line) lines.push(line);
    return lines.flatMap((ln) => ln.split(/\n/));
  };

  const draw = (text, { size = 10, color = rgb(0, 0, 0), indent = 0 } = {}) => {
    const width = maxWidth - indent;
    const lines = wrap(text, font, size, width);
    for (const ln of lines) {
      if (y - lineH < margin) newPage();
      page.drawText(ln, { x: margin + indent, y: y - lineH, size, font, color });
      y -= lineH;
    }
  };

  draw(deal.title, { size: 14, color: rgb(0, 0, 0.6) });
  if (deal.description) {
    draw("\nDealbeschreibung", { size: 11 });
    draw(deal.description, { size: 10 });
  }
  if (deal.images?.length) {
    draw("\nBilder (URLs):", { size: 11 });
    for (const u of deal.images) draw(u, { size: 9, color: rgb(0.3, 0.3, 0.3) });
  }

  draw("\nKommentare:", { size: 11 });
  draw(`Gesamt: ${comments.length}`, { size: 9, color: rgb(0.3, 0.3, 0.3) });

  for (const c of comments) {
    const indent = Math.min(8, Math.max(0, c.depth || 0)) * 12;
    draw(`${c.author} — ${c.datetime}${c.score ? " — " + c.score : ""}`, { size: 9, indent });
    draw(c.text, { size: 9, indent });
    y -= 6;
    if (y < margin + 40) newPage();
  }

  const bytes = await pdf.save();
  fs.writeFileSync(output, bytes);
  return output;
}

/* -------------------- Expand replies (präzise & schnell) -------------------- */
async function expandAllReplies(page, maxRounds = 15) {
  const PAGE_MAX_MS = 90_000;
  const t0 = Date.now();
  let total = 0;

  for (let round = 1; round <= maxRounds; round++) {
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1400); await sleep(80); }

    const buttons = page
      .locator("[data-test*='comment'] >> :is(button, a[role='button'], a, div[role='button'])")
      .filter({ hasText: BTN_TEXT });

    let n = await buttons.count();
    if (n === 0) {
      await sleep(200);
      n = await buttons.count();
      if (n === 0) break;
    }

    let clicked = 0;
    for (let i = 0; i < n; i++) {
      try {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 1000 });
        clicked++;
        total++;
        await sleep(60);
      } catch {}
      if (Date.now() - t0 > PAGE_MAX_MS) break;
    }

    console.log(`expand: Runde ${round} — geklickt ${clicked} (gesamt ${total})`);
    if (clicked === 0) break;
    if (Date.now() - t0 > PAGE_MAX_MS) {
      console.log("   Abbruch: Zeitlimit pro Seite erreicht");
      break;
    }
    await sleep(200);
  }
  return total;
}

/* -------------------- Main -------------------- */
async function main() {
  const url = arg("url");
  const ntfy = arg("ntfy", null);
  if (!url) {
    console.error('Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..." [--ntfy https://ntfy.sh/topic]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    viewport: { width: 1366, height: 900 }
  });

  // CSS/JS erlauben, nur Images/Media/Fonts blocken
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);

  async function nav(u) {
    console.log("→ Lade:", u);
    try { await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }); }
    catch (e) { console.log("   goto warn:", e.message); }
    await sleep(500);
  }

  await nav(url);
  const deal = await extractDealInfo(page);

  function buildPageUrl(base, n) {
    const u = new URL(base);
    u.searchParams.set("page", String(n));
    if (!u.hash) u.hash = "comments";
    return u.toString();
  }

  async function firstCommentSignature() {
    return await page.evaluate(() => {
      const n =
        document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment") || null;
      if (!n) return "";
      const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
      const author = pick(n.querySelector("a[href*='/profil'], [rel='author']")) || "—";
      const timeEl = n.querySelector("time");
      const time = (timeEl?.getAttribute("datetime") || pick(timeEl)) || "—";
      const body = n.querySelector("[data-test*='body'], [class*='body'], .md, .markdown, p") || n;
      const text = pick(body).slice(0, 80);
      return `${author}|${time}|${text}`;
    });
  }

  async function findAllPagesRobust(startUrl) {
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1500); await sleep(100); }
    console.log("   Suche Pagination im DOM …");

    let maxPage = await page.evaluate(() => {
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
      const max = nums.length ? Math.max(...nums) : 1;
      return Math.max(1, Math.min(max, 50));
    });

    if (maxPage > 1 && maxPage <= 50) {
      console.log(`   Pagination im DOM erkannt: ${maxPage} Seiten`);
      return Array.from({ length: maxPage }, (_, i) => buildPageUrl(startUrl, i + 1));
    }

    console.log("   DOM-Erkennung unklar – prüfe Seiten sequentiell …");
    const urls = [buildPageUrl(startUrl, 1)];
    await nav(urls[0]);
    let lastSig = await firstCommentSignature();

    for (let i = 2; i <= 50; i++) {
      const test = buildPageUrl(startUrl, i);
      await nav(test);
      const sig = await firstCommentSignature();
      if (!sig || sig === lastSig) {
        console.log(`   Ende erkannt – letzte gültige Seite: ${i - 1}`);
        return urls;
      }
      urls.push(test);
      lastSig = sig;
      await sleep(150);
    }
    return urls;
  }

  const pages = await findAllPagesRobust(page.url());
  console.log(`==> Gefundene Seiten: ${pages.length}`);

  const all = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    console.log(`\n=== Seite ${i + 1}/${pages.length} ===`);
    await nav(p);
    const clicks = await expandAllReplies(page, 15);
    const part = await extractCommentsOnPage(page);
    console.log(`   ausgeklappt: ${clicks} | extrahiert: ${part.length}`);
    all.push(...part);
    console.log(`   Gesamt-Kommentare bisher: ${all.length}`);
  }

  const out = await buildPDF({ deal, comments: all, output: "mydealz-output.pdf" });
  console.log(`PDF erstellt: ${out} | Kommentare insgesamt: ${all.length}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
