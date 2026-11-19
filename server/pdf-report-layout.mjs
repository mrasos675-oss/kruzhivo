import { access, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { renderReport, reportDisclaimer } from '../shared/report-view.mjs';

const stylesheet = new URL('../public/report.css', import.meta.url);
const interPath = new URL('../public/fonts/InterTight.ttf', import.meta.url);
const monoPath = new URL('../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', import.meta.url);
const pagedPath = new URL('../node_modules/pagedjs/dist/paged.polyfill.min.js', import.meta.url);

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cssString = value => '"' + [...String(value)].map(char =>
  /^[\p{L}\p{N} .·—–№()_-]$/u.test(char) ? char : '\\' + char.codePointAt(0).toString(16) + ' ').join('') + '"';

let assetsPromise;
function assets() {
  assetsPromise ||= Promise.all([stylesheet, interPath, monoPath, pagedPath].map(file => readFile(file)));
  return assetsPromise;
}

async function launchBrowser() {
  const local = process.env.KRUZHIVO_CHROME_PATH || (process.platform === 'darwin' ? macChrome : '');
  if (local) {
    await access(local);
    return puppeteer.launch({ executablePath: local, headless: true, timeout: 12000 });
  }
  chromium.setGraphicsMode = false;
  return puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: 'shell', timeout: 12000 });
}

function printStyles(doc, version, run, css, inter, mono) {
  const name = [...doc.name];
  const title = name.length > 62 ? name.slice(0, 61).join('') + '…' : doc.name;
  const header = cssString(`КружИИво · ${title} · в. ${version.number} / №${run.number}`);
  return `${css}
    @font-face { font-family:'Report Inter'; src:url(data:font/ttf;base64,${inter.toString('base64')}) format('truetype'); font-weight:100 900; font-display:swap; }
    @font-face { font-family:'Report Mono'; src:url(data:font/woff2;base64,${mono.toString('base64')}) format('woff2'); font-display:swap; }
    @page {
      size:A4 portrait; margin:19mm;
      @top-left { content:${header}; font:9pt 'Report Inter'; color:#5b6572; }
      @top-right { content:"Страница " counter(page) " из " counter(pages); font:9pt 'Report Inter'; color:#5b6572; text-align:right; }
      @bottom-left { content:${cssString(reportDisclaimer)}; font:9pt 'Report Inter'; color:#5b6572; }
    }
    @page :first { @top-left { content:none; } }
    html,body { margin:0; padding:0; }
    .report-pdf > .review-report { width:172mm; }
    .report-pdf .report-ref::after { content:" (с. " target-counter(attr(href), page) ")"; color:#5b6572; white-space:nowrap; }
  `;
}

export async function layoutReportPdf(doc, version, run, profile, catalog) {
  const [css, inter, mono, paged] = await assets();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (/^(?:about:|data:)/.test(request.url()) ? request.continue() : request.abort()).catch(() => {});
    });
    await page.setViewport({ width: 900, height: 1100 });
    const html = renderReport(doc, version, run, profile, catalog, { print: true });
    await page.setContent(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>КружИИво · Аналитический отчёт</title><style>${printStyles(doc, version, run, css, inter, mono)}</style></head><body class="report-pdf">${html}</body></html>`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.PagedConfig = { auto: false };
      const fullPageHeight = (297 - 38) * 96 / 25.4;
      for (const card of document.querySelectorAll('.report-remark')) {
        if (card.getBoundingClientRect().height >= fullPageHeight - 8) card.dataset.continuedCard = '';
      }
    });
    await page.addScriptTag({ content: paged.toString('utf8') });
    await page.evaluate(async () => {
      await window.PagedPolyfill.preview();
      for (const sheet of document.querySelectorAll('.pagedjs_page')) {
        const continuation = sheet.querySelector('.report-remark[data-continued-card][data-split-from]');
        if (!continuation || continuation.querySelector('.report-remark-head')) continue;
        const margin = sheet.querySelector('.pagedjs_margin-top-left .pagedjs_margin-content');
        if (!margin) continue;
        const caption = document.createElement('div');
        caption.className = 'report-continuation';
        caption.textContent = continuation.dataset.continuation;
        margin.append(caption);
      }
    });
    return Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true, timeout: 15000 }));
  } finally {
    await browser.close();
  }
}
