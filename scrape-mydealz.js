// scrape-mydealz.js — robuste MyDealz-Version mit Auto-Scroll & stabiler Pagination
// Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..." [--ntfy https://ntfy.sh/topic]
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

/* ========= Utilities ========= */
async function autoScroll(page, { totalMs = 25000, step = 1200, pause = 120 } = {}) {
  const start = Date.now();
  let lastH = await page.evaluate(() => document.body.scrollHeight);
  while (Date.now() - start < totalMs) {
    await page.mouse.wheel(0, step);
    await sleep(pause);
    const newH = await page.evaluate(() => document.body.scrollHeight);
    if (newH <= lastH) {
      // am Ende? kurz warten & nochmal checken
      await sleep(250);
      const chk = await page.evaluate(() => document.body.scrollHeight);
      if (chk <= lastH) break;
    }
    lastH = newH;
  }
}

async function ensureDealLoaded(page) {
  // Warten bis Titel/H1/og:title vorhanden ist
  await page.waitForFunction(() => {
    const h1 = document.querySelector("[data-test='thread-title'], h1");
    const og = document.querySelector("meta[property='og:title']")?.getAttribute("content");
    return (h1 && (h1.textContent || "").trim().length > 3) || (og && og.length > 3);
  }, { timeout: 20000 }).catch(() => {});
}

async function ensureCommentsMaybe(page) {
  // Versuche Kommentare sichtbar zu bekommen
  await autoScroll(page, { totalMs: 12000, step: 1600, pause: 100 });
  // Warte bis min. 1 Kommentar im DOM ist (nicht fatal, wenn nicht)
  await page.waitForFunction(() => {
    return !!document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment");
  }, { timeout: 8000 }).catch(() => {});
}

function buildPageUrl(base, n) {
  const u = new URL(base);
  u.searchParams.set("page", String(n));
  if (!u.hash) u.hash = "comments";
  return u.toString();
}

/* ========= Deal-Head ========= */
async function extractDealHead(page) {
  return await page.evaluate(() => {
    const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";

    const title =
      pick(document.querySelector("[data-test='thread-title']")) ||
      meta("meta[property='og:title']") ||
      document.title ||
      "MyDealz Deal";

    const description =
      pick(document.querySelector("[data-test*='description'], .threadBody, article .content, .userHtml")) ||
      meta("meta[name='description']") ||
      "";

    const price =
      pick(document.querySelector("[data-test='thread-price'], .thread-price")) ||
      description.match(/\b\d+[,.]\d{2}\s*€\b/)?.[0] ||
      "";

    const merchant =
      pick(document.querySelector("[data-test='merchant-name'], [class*='merchant']")) || "";

    const expiry =
      pick(document.querySelector("[data-test='deal-expiry-date'], [class*='deal-expiry']")) || "";

    const link =
      document.querySelector("a[data-test='thread-deal-link']")?.href ||
      document.querySelector("link[rel='canonical']")?.href ||
      location.href;

    const images = Array.from(document.querySelectorAll("img"))
      .map((img) => img.src || img.getAttribute("data-src"))
      .filter(Boolean)
      .filter((u) => !u.startsWith("data:"))
      .slice(0, 12);

    return { title, description, price, merchant, expiry, link, images };
  });
}

/* ========= Comments ========= */
async function expandAllReplies(page, maxRounds = 12) {
  let total = 0;
  const start = Date.now();
  for (let round = 1; round <= maxRounds; round++) {
    // nur Buttons IN Kommentarcontainern
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
      if (Date.now() - start > 60000) break;
    }
    if (clicked === 0 || Date.now() - start > 60000) break;
    await sleep(250);
  }
  return total;
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
      const text = txt(body);
      if (!text || text.length < 2) continue;
      const author = txt(el.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']")) || "—";
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
    const key = `${c.author}|${(c.datetime || "").slice(0, 25)}|${c.text.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ========= Pagination ========= */
async function firstCommentSignature(page) {
  return await page.evaluate(() => {
    const n =
      document.querySelector("[data-test*='comment'], [id^='comment'], .c-comment, .comment") || null;
    if (!n) return "";
    const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const author = pick(n.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']")) || "—";
    const timeEl = n.querySelector("time");
    const time = timeEl?.getAttribute("datetime") || pick(timeEl) || "—";
    const body = n.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || n;
    const text = pick(body).slice(0, 80);
    return `${author}|${time}|${text}`;
  });
}

async function findAllPagesRobust(page, startUrl) {
  // 1) Direkt nach sichtbarer Pagination suchen
  await autoScroll(page, { totalMs: 2000 });
  const maxInDom = await page.evaluate(() => {
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

  if (maxInDom > 1) {
    const n = Math.min(maxInDom, 50);
    return Array.from({ length: n }, (_, i) => buildPageUrl(startUrl, i + 1));
  }

  // 2) Fallback: sequentiell prüfen, bis sich erster Kommentar wiederholt
  const urls = [buildPageUrl(startUrl, 1)];
  let lastSig = await firstCommentSignature(page);
  for (let i = 2; i <= 50; i++) {
    const test = buildPageUrl(startUrl, i);
    await page.goto(test, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureDealLoaded(page);
    await ensureCommentsMaybe(page);
    const sig = await firstCommentSignature(page);
    if (!sig || sig === lastSig) break;
    urls.push(test);
    lastSig = sig;
  }
  return urls;
}

/* ========= PDF ========= */
function findFontPath() {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error("Kein Unicode-Font gefunden (DejaVuSans/NotoSans).");
}

async function makePDF({ deal, comments, output = "mydealz-output.pdf" }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(findFontPath()), { subset: true });

  let page = pdf.addPage([595.28, 841.89]); // A4
  const margin = 36, lh = 12;
  let y = page.getHeight() - margin;

  const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = page.getHeight() - margin; };
  const draw = (t, { size = 10, color = rgb(0, 0, 0), indent = 0 } = {}) => {
    for (const line of (t || "").split(/\r?\n/)) {
      if (y - lh < margin) newPage();
      page.drawText(line, { x: margin + indent, y: y - lh, size, font, color });
      y -= lh;
    }
  };

  draw(deal.title, { size: 15, color: rgb(0.08, 0.08, 0.55) });
  draw("");
  if (deal.price) draw(`💰 Preis: ${deal.price}`);
  if (deal.merchant) draw(`🏷️ Händler: ${deal.merchant}`);
  if (deal.expiry) draw(`📅 Ablaufdatum: ${deal.expiry}`);
  draw(`🔗 Link: ${deal.link}`);
  draw("");
  if (deal.description) {
    draw("📝 Beschreibung:");
    draw(deal.description);
    draw("");
  }
  if (deal.images?.length) {
    draw("🖼️ Bilder (URLs):");
    for (const u of deal.images) draw(u, { size: 8, color: rgb(0.35, 0.35, 0.35) });
    draw("");
  }

  draw("────────────────────────────────────", { color: rgb(0.2, 0.2, 0.2) });
  draw("");
  draw(`💬 Kommentare (nach Dedupe: ${comments.length})`);
  draw("");

  for (const c of comments) {
    const indent = Math.min(8, c.depth || 0) * 12;
    draw(`${c.author} — ${c.datetime}${c.score ? " — " + c.score : ""}`, { size: 9, indent });
    draw(c.text, { size: 9, indent });
    y -= 6;
  }

  fs.writeFileSync(output, await pdf.save());
  return output;
}

/* ========= Main ========= */
async function main() {
  const url = arg("url");
  if (!url) {
    console.error('Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..."');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });

  // Ressourcen drosseln (aber CSS/JS erlauben!)
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);

  console.log("→ Lade Deal:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await ensureDealLoaded(page);
  await ensureCommentsMaybe(page);

  const deal = await extractDealHead(page);

  // Pagination bestimmen
  const pages = await findAllPagesRobust(page, page.url());
  console.log(`→ Kommentar-Seiten erkannt: ${pages.length}`);

  const all = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    console.log(`\n=== Seite ${i + 1}/${pages.length} ===`);
    await page.goto(p, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await ensureDealLoaded(page);
    await ensureCommentsMaybe(page);
    const clicks = await expandAllReplies(page);
    const part = await extractCommentsOnPage(page);
    console.log(`   ausgeklappt: ${clicks} | extrahiert: ${part.length}`);
    all.push(...part);
  }

  const deduped = deduplicate(all);
  console.log(`→ Gesamt: ${all.length} | nach Dedupe: ${deduped.length}`);

  const out = await makePDF({ deal, comments: deduped, output: "mydealz-output.pdf" });
  console.log("✓ PDF erstellt:", out);

  await browser.close();
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
