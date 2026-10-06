const { chromium } = require('playwright');
const assert = require('assert');

async function openPage(browser, url, errors, { width = 1400, height = 900, intro = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  if (!intro) await context.addInitScript(() => { try { localStorage.setItem('stadtplaner.intro', '1'); } catch { /* ohne Speicher */ } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::|Failed to load resource|ERR_|502|404/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('dialog', async (d) => { await d.accept(d.defaultValue() || ''); });
  await page.route(/\/tiles\/(\w[\w-]*\/)?\d+\/\d+\/\d+/, (route) => route.abort()); // Kacheln, nicht /api/tiles/sources
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('.smap-canvas');
  await page.waitForTimeout(300);
  return { context, page };
}

const helpers = (page) => ({
  working: () => page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.working') || 'null')),
  doc: () => page.evaluate(() => JSON.parse(JSON.stringify(window.stadtplaner.store.doc))),
  project: (ll) => page.evaluate((x) => window.stadtplaner.map.project(x), ll),
  mapBox: () => page.locator('#map').boundingBox(),
  settle: (ms = 500) => page.waitForTimeout(ms),
  // Einstellungen (Karte, Einrasten, Sprache, Darstellung) liegen im Panel hinter dem Zahnrad
  openSettings: async () => { if (await page.locator('#panel-settings').isHidden()) { await page.click('#btn-settings'); await page.waitForTimeout(100); } },
  closeSettings: async () => { if (!(await page.locator('#panel-settings').isHidden())) { await page.click('#panel-settings [data-close-panel]'); await page.waitForTimeout(100); } },
});

module.exports = { chromium, assert, openPage, helpers };
