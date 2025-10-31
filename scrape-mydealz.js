import fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const url = process.argv[2] || process.argv[process.argv.indexOf("--url") + 1];
if (!url) {
  console.error("❌ Bitte gib eine URL mit --url an");
  process.exit(1);
}

const outputDir = "shots";
const pdfFile = "mydealz-output.pdf";
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 2500 } });

  console.log("🌐 Lade:", url);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // === ALLES AUSKLAPPEN ===
  async function expandAll() {
    let expanded = 0;
    for (;;) {
      const buttons = await page.$$('button:has-text("mehr")');
      if (buttons.length === 0) break;

      for (const btn of buttons) {
        try {
          await btn.click({ timeout: 1000 });
          expanded++;
          await page.waitForTimeout(300);
        } catch {}
      }
    }
    console.log(`✅ Ausgeklappt: ${expanded} Bereiche`);
  }

  await expandAll();
  await page.waitForTimeout(2000);

  // === GANZE SEITE ALS SCREENSHOT(S) ===
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = page.viewportSize().height;
  const totalShots = Math.ceil(bodyHeight / viewportHeight);
  console.log(`📸 Seitenhöhe: ${bodyHeight}px → Screenshots: ${totalShots}`);

  for (let i = 0; i < totalShots; i++) {
    const y = i * viewportHeight;
    await page.evaluate((_y) => window.scrollTo(0, _y), y);
    await page.waitForTimeout(1000);
    const file = path.join(outputDir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✔ Screenshot gespeichert: ${file}`);
  }

  // === PDF bauen ===
  const pdfPath = path.join(".", pdfFile);
  await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  console.log(`📄 PDF erstellt: ${pdfPath}`);

  await browser.close();
})();
