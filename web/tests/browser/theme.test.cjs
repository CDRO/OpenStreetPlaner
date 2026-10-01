// Darstellung: Dunkelmodus wie das System, erzwungen hell oder dunkel; Kacheln folgen; Einstellung bleibt.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dark = (rgb) => { const m = /(\d+), (\d+), (\d+)/.exec(rgb); return m && Number(m[1]) < 60 && Number(m[2]) < 60 && Number(m[3]) < 60; };
  assert.ok(!dark(await bodyBg()), `Standard hell: ${await bodyBg()}`);
  assert.equal(await page.evaluate(() => window.stadtplaner.map.darkTiles), false);
  // Wie das System: Systemeinstellung dunkel -> dunkel
  await page.emulateMedia({ colorScheme: 'dark' });
  await h.settle(200);
  assert.ok(dark(await bodyBg()), `System dunkel: ${await bodyBg()}`);
  assert.equal(await page.evaluate(() => window.stadtplaner.map.darkTiles), true, 'Kacheln folgen dem System');
  // Ausdrücklich hell trotz dunklem System
  await page.waitForSelector('#set-theme');
  await page.selectOption('#set-theme', 'light');
  await h.settle(200);
  assert.ok(!dark(await bodyBg()), 'hell erzwungen');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => window.stadtplaner.map.darkTiles), false);
  // Ausdrücklich dunkel trotz hellem System
  await page.emulateMedia({ colorScheme: 'light' });
  await page.selectOption('#set-theme', 'dark');
  await h.settle(200);
  assert.ok(dark(await bodyBg()), 'dunkel erzwungen');
  assert.equal(await page.evaluate(() => window.stadtplaner.map.darkTiles), true);
  const sidebarBg = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).backgroundColor);
  assert.ok(dark(sidebarBg), `Seitenleiste dunkel: ${sidebarBg}`);
  const inputBg = await page.evaluate(() => getComputedStyle(document.getElementById('draft-name')).backgroundColor);
  assert.ok(dark(inputBg), `Eingabefelder dunkel: ${inputBg}`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.settings')).theme);
  assert.equal(saved, 'dark', 'Einstellung gespeichert');
  // Neu laden: Einstellung bleibt
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.smap-canvas');
  await h.settle(300);
  assert.ok(dark(await bodyBg()), 'nach Neuladen dunkel');
  await page.selectOption('#set-theme', 'system');
  await h.settle(200);
  assert.ok(!dark(await bodyBg()), 'zurück zum (hellen) System');
  // Zuversicht-Punkte tragen ein Zeichen
  const glyph = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'conf-dot conf-medium';
    document.body.appendChild(el);
    const c = getComputedStyle(el, '::after').content;
    el.remove();
    return c;
  });
  assert.ok(glyph.includes('!'), `Zeichen im Punkt: ${glyph}`);
  console.log('✓ Darstellung');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST theme OK');
})().catch((e) => { console.error('BROWSER-TEST theme FAILED:', e); process.exit(1); });
