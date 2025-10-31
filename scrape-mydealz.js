// scrape-mydealz.js
// Usage:
//   node scrape-mydealz.js --url "https://www.mydealz.de/..." [--ntfy https://ntfy.sh/topic]
import fs from "fs";
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Nur echte Reply-Expander (bewusst eng gefasst)
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
      document.querySelector("[data-test='thread-title']") ||
      document.querySelector("h1");
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
      images: imgs,
    };
  });
}

async function extractCommentsOnPage(page) {
  return await page.evaluate(() => {
    const out = [];
    // Engerer Selektor: nur echte Kommentar-Container
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
        depth: depthOf(el),
      });
    }
    return out;
  });
}

/* -------------------- PDF -------------------- */
async function buildPDF({ deal, comments, output = "mydealz-output.pdf" }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([595.28, 841.89]); // A4 portrait (pt)
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

  const draw = (text, { size = 10, b = false, color = rgb(0, 0, 0), indent = 0 } = {}) => {
    const f = b ? bold : font;
    const width = maxWidth - indent;
    const lines = (text || "")
      .split(/\n\n+/)
      .flatMap((par) => [...wrap(par, f, size, width), ""]);
    for (const ln of lines) {
      if (y - lineH < margin) newPage();
      page.drawText(ln, { x: margin + indent, y: y - lineH, size, font: f, color });
      y -= lineH;
    }
  };

  // Header
  draw(deal.title, { size: 15, b: true, color: rgb(0.06, 0.06, 0.35) });
  if (deal.description) {
    draw("Dealbeschreibung", { size: 11, b: true });
    draw(deal.description, { size: 10 });
  }
  if (deal.images?.length) {
    draw("Bilder (URLs):", { size: 11, b: true });
    for (const u of deal.images) draw(u, { size: 9, color: rgb(0.3, 0.3, 0.3) });
  }

  // Comments
  draw("Kommentare", { size: 11, b: true });
  draw(`Gesamt: ${comments.length}`, { size: 9, color: rgb(0.3, 0.3, 0.3) });

  for (const c of comments) {
    const indent = Math.min(8, Math.max(0, c.depth || 0)) * 12;
    draw(`${c.author}  —  ${c.datetime}${c.score ? " — " + c.score : ""}`, {
      size: 9,
      b: true,
      indent,
    });
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
  const PAGE_MAX_MS = 90_000; // max. 90s pro Seite
  const t0 = Date.now();

  let total = 0;
  for (let round = 1; round <= maxRounds; round++) {
    // sanft scrollen, damit Lazy-Buttons sichtbar werden
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1400); await sleep(80); }

    // Nur Buttons innerhalb von Kommentarcontainern
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
        await b.click({ timeout: 1000 }); // kurz halten
        clicked++;
        total++;
        await sleep(60);
      } catch {
        // Fehlklicks ignorieren
      }
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
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    viewport: { width: 1366, height: 900 },
  });

  // Nur Bilder/Media/Fonts blocken – CSS & JS müssen laden
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(60000);

  async function nav(u) {
    console.log("→ Lade:", u);
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      console.log("   goto warn:", e.message);
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(500);
  }

  // Start
  await nav(url);

  // Consent schließen (falls vorhanden)
  try {
    const consent = page.locator(
      "button:has-text('Akzeptieren'), button:has-text('Einverstanden'), button:has-text('Zustimmen')"
    );
    if (await consent.count()) await consent.first().click({ timeout: 2000 }).catch(() => {});
  } catch {}

  const deal = await extractDealInfo(page);

  /* -------------------- Pagination -------------------- */
  function buildPageUrl(base, n) {
    const u = new URL(base);
    u.searchParams.set("page", String(n));
    if (!u.hash) u.hash = "comments";
    return u.toString();
  }

  async function firstCommentSignature() {
    return await page.evaluate(() => {
      const n =
        document.querySelector(
          "[data-test*='comment'], [id^='comment'], .c-comment, .comment"
        ) || null;
      if (!n) return "";
      const pick = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
      const author =
        pick(n.querySelector("a[href*='/profil'], [rel='author'], [data-test*='author'], [class*='author']")) || "—";
      const timeEl = n.querySelector("time");
      const time = (timeEl?.getAttribute("datetime") || pick(timeEl)) || "—";
      const body =
        n.querySelector("[data-test*='body'], [class*='body'], [class*='content'], .md, .markdown, p") || n;
      const text = pick(body).slice(0, 80);
      return `${author}|${time}|${text}`;
    });
  }

  async function findAllPagesRobust(startUrl) {
    // Kleine Scrolls, damit Pagination sichtbar wird
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

      // sichtbare Links mit page=
      document.querySelectorAll("a[href*='page=']").forEach((a) => {
        if (!isVisible(a)) return;
        const href = a.getAttribute("href") || "";
        const m = href.match(/[?&]page=(\d+)/);
        if (m) nums.push(parseInt(m[1], 10));
        const t = parseInt((a.textContent || "").trim(), 10);
        if (!Number.isNaN(t)) nums.push(t);
      });

      // typische Container
      document
        .querySelectorAll("nav[aria-label*='Pagination' i], .pagination, [class*='Pagination'], [data-test*='pagination']")
        .forEach((c) => {
          if (!isVisible(c)) return;
          const m = (c.innerText || "").match(/\b\d+\b/g) || [];
          m.forEach((s) => {
            const n = parseInt(s, 10);
            if (!Number.isNaN(n)) nums.push(n);
          });
        });

      const max = nums.length ? Math.max(...nums) : 1;
      return Math.max(1, Math.min(max, 50)); // Obergrenze 50
    });

    if (maxPage > 1 && maxPage <= 50) {
      console.log(`   Pagination im DOM erkannt: ${maxPage} Seiten`);
      return Array.from({ length: maxPage }, (_, i) => buildPageUrl(startUrl, i + 1));
    }

    // Fallback: sequentiell prüfen, Clamp über ersten Kommentar
    console.log("   DOM-Erkennung unklar – prüfe Seiten sequentiell …");
    const urls = [buildPageUrl(startUrl, 1)];
    await nav(urls[0]);
    let lastSig = await firstCommentSignature();

    const MAX_PROBE = 50;
    for (let i = 2; i <= MAX_PROBE; i++) {
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

    console.log("   Maximale Prüftiefe erreicht – vermutlich letzte Seite 50.");
    return urls;
  }

  const pages = await findAllPagesRobust(page.url());
  console.log(`==> Gefundene Seiten: ${pages.length}`);

  /* -------------------- Iterate pages -------------------- */
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
    await sleep(250);
  }

  /* -------------------- Build PDF -------------------- */
  const out = await buildPDF({ deal, comments: all, output: "mydealz-output.pdf" });
  console.log(`PDF erstellt: ${out} | Kommentare insgesamt: ${all.length}`);

  // ntfy (optional)
  if (ntfy) {
    try {
      const msg = `Mydealz Export ✓\nKommentare: ${all.length}\nDatei: mydealz-output.pdf`;
      await fetch(ntfy, {
        method: "POST",
        body: msg,
        headers: { Title: "Mydealz PDF erstellt", Tags: "floppy_disk" },
      });
    } catch (e) {
      console.error("ntfy error:", e.message);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
