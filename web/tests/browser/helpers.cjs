const { chromium } = require('playwright');
const assert = require('assert');

async function openPage(browser, url, errors, { width = 1400, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::|Failed to load resource|ERR_|502|404/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('dialog', async (d) => { await d.accept(d.defaultValue() || ''); });
  await page.route('**/tiles/**', (route) => route.abort());
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
});

module.exports = { chromium, assert, openPage, helpers };
