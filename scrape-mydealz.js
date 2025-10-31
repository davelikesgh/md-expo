// scrape-mydealz.js
// Usage: node scrape-mydealz.js --url "https://www.mydealz.de/..." [--out outprefix] [--ntfy https://ntfy.sh/mytopic]

const fs = require('fs');
const { chromium } = require('playwright');

const BTN_TEXT = /(Mehr Antworten anzeigen|Weitere Antworten|Mehr Kommentare|Mehr anzeigen|Antworten anzeigen)/i;
const PAGIN_NEXT_TEXT = /(Nächste|Weiter|›|»)/i;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function arg(name, def=null){ const i=process.argv.indexOf('--'+name); return i>0 ? process.argv[i+1] : def; }

async function expandAllReplies(page, maxRounds=25){
  let total=0;
  for (let r=0; r<maxRounds; r++){
    for (let i=0;i<10;i++){ await page.mouse.wheel(0,1200); await sleep(150); }
    const clicked = await page.evaluate((reSrc)=>{
      const TXT = new RegExp(reSrc,'i');
      const vis = el=>{
        if(!el) return false;
        const s=getComputedStyle(el);
        if(s.visibility==='hidden'||s.display==='none') return false;
        const r=el.getBoundingClientRect();
        return r.width>1&&r.height>1&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
      };
      let c=0;
      document.querySelectorAll('button,a,[role="button"],summary,div,span').forEach(el=>{
        const t=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
        if(t && TXT.test(t) && vis(el)){
          el.scrollIntoView({block:'center'});
          try{
            el.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));
            el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
            el.click();
            el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
            el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
            c++;
          }catch(_){}
        }
      });
      return c;
    }, BTN_TEXT.source);
    total+=clicked;
    if(clicked===0) break;
    await sleep(500);
  }
  return total;
}

async function findAllPages(page){
  const urls=new Set([page.url()]);
  for (let guard=0; guard<50; guard++){
    const relNext=await page.$('a[rel="next"]');
    if (relNext){
      const href=await relNext.getAttribute('href');
      if (!href) break;
      const absolute=new URL(href, page.url()).toString();
      if (urls.has(absolute)) break;
      urls.add(absolute);
      await page.goto(absolute,{waitUntil:'networkidle'});
      continue;
    }
    const links=await page.$$('a,button');
    let moved=false;
    for (const h of links){
      const txt=((await h.innerText().catch(()=>''))||'').trim();
      if (/(Nächste|Weiter|›|»)/i.test(txt)){
        const href=await h.getAttribute('href');
        if (href){
          const absolute=new URL(href, page.url()).toString();
          if (urls.has(absolute)) { moved=false; break; }
          urls.add(absolute);
          await page.goto(absolute,{waitUntil:'networkidle'});
          moved=true;
        } else {
          await h.click().catch(()=>{});
          await page.waitForLoadState('networkidle').catch(()=>{});
          const u=page.url();
          if (!urls.has(u)) { urls.add(u); moved=true; }
        }
        break;
      }
    }
    if (!moved) break;
  }
  return Array.from(urls);
}

async function extractPage(page){
  return await page.evaluate(()=>{
    const out=[];
    const nodes=document.querySelectorAll('[data-test*="comment"], [id^="comment"], article, li, .comment, .c-comment');
    const depthOf=el=>{
      let x=0,e=el;
      while(e&&e!==document.body){
        const ml=parseInt(getComputedStyle(e).marginLeft)||0;
        const pl=parseInt(getComputedStyle(e).paddingLeft)||0;
        x+=Math.max(ml,pl); e=e.parentElement;
      }
      return Math.round(x/24);
    };
    for (const el of nodes){
      const body=el.querySelector('[data-test*="body"], [class*="body"], [class*="content"], .md, .markdown, p')||el;
      const text=(body.innerText||body.textContent||'').trim();
      if(!text) continue;
      const authorEl=el.querySelector('a[href*="/profil"], [data-test*="author"], [class*="author"], [rel="author"]');
      const timeEl=el.querySelector('time');
      const scoreEl=el.querySelector('[data-test*="vote"], [class*="vote"], [aria-label*="Gefällt"]');
      out.push({
        id: el.id || el.getAttribute('data-id') || null,
        author: authorEl ? (authorEl.innerText||authorEl.textContent||'').trim() : null,
        datetime: timeEl ? (timeEl.getAttribute('datetime')||timeEl.getAttribute('title')||timeEl.innerText||'').trim() : null,
        depth: depthOf(el),
        score: scoreEl ? (scoreEl.getAttribute('aria-label')||scoreEl.innerText||'').trim() : null,
        text
      });
    }
    return out;
  });
}

async function processUrl(url, outPrefix, ntfyUrl){
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
    viewport:{width:1366,height:900}
  });
  const page=await ctx.newPage();
  await page.goto(url,{waitUntil:'networkidle'});

  const pages=await findAllPages(page);
  const all=[];
  for (let i=0;i<pages.length;i++){
    const purl=pages[i];
    await page.goto(purl,{waitUntil:'networkidle'});

    // Consent weg (falls erscheint)
    try {
      const c = await page.$('button:has-text("Akzeptieren"), button:has-text("Einverstanden"), button:has-text("Zustimmen")');
      if (c) await c.click().catch(()=>{});
    } catch {}

    const clicks=await expandAllReplies(page,25);
    const items=await extractPage(page);
    items.forEach((x,idx)=>{ x.source_url=purl; x.source_idx=idx; });
    all.push(...items);
    await sleep(600);
    console.log(`Seite ${i+1}/${pages.length}: clicks=${clicks}, items=${items.length}`);
  }

  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const base=outPrefix || `mydealz_${stamp}`;

  // JSONL
  const jsonl=all.map(o=>JSON.stringify(o)).join('\n');
  fs.writeFileSync(`${base}.jsonl`, jsonl, 'utf8');

  // Markdown (für Copy & Paste)
  const md=['# Mydealz Kommentare (expandiert)\n'];
  for (const c of all){
    const indent='  '.repeat(Math.max(0, Math.min(6, c.depth||0)));
    md.push(`${indent}- **Autor:** ${c.author||'—'}  \n${indent}  **Zeit:** ${c.datetime||'—'}  \n${indent}  **Score:** ${c.score||'—'}  \n${indent}  **Text:** ${String(c.text).replace(/\s+/g,' ').trim()}`);
  }
  fs.writeFileSync(`${base}.md`, md.join('\n'), 'utf8');

  // ntfy (optional)
  if (ntfyUrl){
    try {
      const summary = `mydealz dump ✓  URL: ${url}\nItems: ${all.length}\nFiles: ${base}.jsonl, ${base}.md`;
      await fetch(ntfyUrl, { method:'POST', body: summary, headers: { 'Title': 'Mydealz Export', 'Tags': 'inbox,floppy_disk' }});
    } catch(e){ console.error('ntfy error:', e.message); }
  }

  await browser.close();
  return { count: all.length, base };
}

(async ()=>{
  const url = arg('url');
  if (!url) { console.error('Usage: node scrape-mydealz.js --url "<URL>" [--out prefix] [--ntfy https://ntfy.sh/topic]'); process.exit(1); }
  const out = arg('out', null);
  const ntfy = arg('ntfy', process.env.NTFY_URL || null);
  const res = await processUrl(url, out, ntfy);
  console.log(`Done. Items=${res.count}`);
})();
