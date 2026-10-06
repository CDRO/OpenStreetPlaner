// Sprachwechsel: Oberfläche, Eigenschaften, Status, Bericht; Erkennung aus dem Browser.
const fs = require('fs');
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  assert.equal(await page.textContent('.tabs button[data-tab="draw"]'), 'Zeichnen');
  await h.openSettings();
  await page.selectOption('#set-language', 'fr');
  await h.settle(300);
  assert.equal(await page.textContent('.tabs button[data-tab="draw"]'), 'Dessiner');
  assert.equal(await page.textContent('.tabs button[data-tab="analysis"]'), 'Analyse');
  assert.equal(await page.getAttribute('#search-input', 'placeholder'), 'Rechercher un lieu ou une adresse…');
  assert.equal(await page.textContent('#btn-share'), 'Partager');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'fr');
  assert.ok((await page.textContent('#tool-buttons')).includes('Sélectionner'));
  assert.ok((await page.textContent('#status-hint')).includes('Cliquer'));
  // Eigenschaften einer Strasse auf Französisch, Typen übersetzt
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('x', (d) => {
      d.features.push({ id: 'r_fr', type: 'road', layerId: d.layers[0].id, name: '', kind: 'main', status: 'new', oneway: false, maxspeed: 50, width: null, section: null, osmId: null, nodes: [[47.05, 8.3], [47.05, 8.31]], segments: [{ level: 'ground', maxspeed: null }], profile: null, parcels: null, note: '' });
    });
    sp.tools.setSelection({ featureId: 'r_fr' });
  });
  await h.settle(200);
  const props = await page.textContent('#properties');
  assert.ok(props.includes('Route principale') && props.includes('Type de route') && props.includes('Profil en travers'), props.slice(0, 200));
  assert.ok((await page.textContent('#prop-kind')).includes('Autoroute'));
  // Verlauf zeigt übersetzte Rückgängig-Beschriftungen
  await page.evaluate(() => window.stadtplaner.store.commit('Strasse zeichnen', (d) => { d.features[0].maxspeed = 30; }));
  await page.click('.tabs button[data-tab="history"]');
  await h.settle(200);
  assert.ok((await page.textContent('#history-undo')).includes('Dessiner une route'));
  // Bericht auf Französisch
  const blocks = await page.evaluate(async () => {
    const { reportBlocks } = await import('/static/js/export.js');
    return reportBlocks(window.stadtplaner.store.doc, {}).map((b) => b.text);
  });
  assert.ok(blocks.includes('Mesures') && blocks.some((b) => b.includes('Route principale')), blocks.join(' | '));
  // Italienisch und zurück (die Sprachwahl liegt im Einstellungen-Panel)
  await h.openSettings();
  await page.selectOption('#set-language', 'it');
  await h.settle(200);
  assert.equal(await page.textContent('.tabs button[data-tab="comments"]'), 'Commenti');
  await page.selectOption('#set-language', 'de');
  await h.settle(200);
  assert.equal(await page.textContent('.tabs button[data-tab="comments"]'), 'Kommentare');
  // Einstellung bleibt nach Neuladen; Browser-Sprache wird beim ersten Start erkannt
  await h.openSettings();
  await page.selectOption('#set-language', 'fr');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.smap-canvas');
  await h.settle(300);
  assert.equal(await page.textContent('.tabs button[data-tab="draw"]'), 'Dessiner');
  const ctxIt = await browser.newContext({ locale: 'it-CH' });
  const pIt = await ctxIt.newPage();
  await pIt.route(/\/tiles\/(\w[\w-]*\/)?\d+\/\d+\/\d+/, (r) => r.abort());
  await pIt.goto(BASE, { waitUntil: 'load' });
  await pIt.waitForSelector('.smap-canvas');
  assert.equal(await pIt.textContent('.tabs button[data-tab="draw"]'), 'Disegna', 'Browser-Sprache erkannt');
  await ctxIt.close();
  console.log('✓ Sprachwechsel');
  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST lang OK');
})().catch((e) => { console.error('BROWSER-TEST lang FAILED:', e); process.exit(1); });
