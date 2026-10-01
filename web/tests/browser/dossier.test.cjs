// Parzellen je Strasse (geo.admin nachgebildet) und betroffene Gebäude (Overpass nachgebildet).
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  // Dienste nachbilden: Parzellen und Gebäude kommen direkt aus dem Test
  await page.route('**/api/parcels', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ parcels: [
      { id: 'P1', egrid: 'CH111', number: '101', canton: 'BE', label: 'Liegenschaft', polygons: [[[[47.0495, 8.3], [47.0495, 8.303], [47.0505, 8.303], [47.0505, 8.3]]]] },
      { id: 'P2', egrid: 'CH222', number: '202', canton: 'BE', label: 'Liegenschaft', polygons: [[[[47.0495, 8.303], [47.0495, 8.31], [47.0505, 8.31], [47.0505, 8.303]]]] },
      { id: 'P3', egrid: 'CH333', number: '303', canton: 'BE', label: 'Liegenschaft', polygons: [[[[47.06, 8.3], [47.06, 8.31], [47.07, 8.31], [47.07, 8.3]]]] },
    ] }),
  }));
  await page.route(/\/api\/buildings\?/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 1, tags: { building: 'house' }, geometry: [[47.0502, 8.302], [47.0502, 8.3021], [47.0503, 8.3021], [47.0503, 8.302], [47.0502, 8.302]] },
      { id: 2, tags: { building: 'house' }, geometry: [[47.0502, 8.306], [47.0502, 8.3061], [47.0503, 8.3061], [47.0503, 8.306], [47.0502, 8.306]] },
      { id: 3, tags: { building: 'house' }, geometry: [[47.056, 8.305], [47.056, 8.3051], [47.0561, 8.3051], [47.0561, 8.305], [47.056, 8.305]] },
    ]),
  }));
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Testnetz', (d) => {
      const layerId = d.layers[0].id;
      d.features.push({ id: 'r_test', type: 'road', layerId, name: 'Umfahrung', kind: 'main', status: 'new', oneway: false, maxspeed: 50, width: null, section: null, osmId: null, nodes: [[47.05, 8.3], [47.05, 8.31]], segments: [{ level: 'ground', maxspeed: null }], profile: null, parcels: null, note: '' });
    });
    sp.map.setView([47.05, 8.305], 16);
  });
  await h.settle(300);

  // --- Parzellen ------------------------------------------------------------------------
  await page.evaluate(() => window.stadtplaner.tools.setSelection({ featureId: 'r_test' }));
  await page.waitForSelector('#parcels-load', { state: 'attached' });
  await page.click('#properties details summary:has-text("Betroffene Parzellen")');
  await page.click('#parcels-load');
  await page.waitForSelector('.parcel-list');
  const doc = await h.doc();
  const pc = doc.features[0].parcels;
  assert.equal(pc.items.length, 2, 'P3 wird nicht berührt');
  assert.equal(pc.items[0].number, '202', 'längste zuerst');
  assert.ok(pc.items[0].length > 500 && pc.items[1].length > 200, JSON.stringify(pc.items));
  const text = await page.textContent('#properties');
  assert.ok(text.includes('Nr. 202 (BE)') && text.includes('CH111') && text.includes('2 Parzellen'));
  // Hervorhebung: Parzellenfläche (orange) neben der Strasse
  const pixel = await page.evaluate(() => {
    const sp = window.stadtplaner;
    const p = sp.map.project([47.0503, 8.301]);
    const canvas = document.querySelector('.smap-canvas');
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.ok(pixel[0] > pixel[2] + 10, `Parzelle orange eingefärbt: rgb(${pixel})`);
  // Geometrie ändern -> veraltet
  await page.evaluate(() => window.stadtplaner.store.commit('move', (d) => { d.features[0].nodes[1] = [47.05, 8.312]; }));
  await h.settle(200);
  assert.ok((await page.textContent('#properties')).includes('veraltet'));
  await page.click('#properties details summary:has-text("Betroffene Parzellen")');
  await page.click('#parcels-clear');
  await h.settle(200);
  assert.equal((await h.doc()).features[0].parcels, null);
  console.log('✓ Parzellen');

  // --- Gebäude ------------------------------------------------------------------------------
  await page.evaluate(() => window.stadtplaner.store.commit('route', (d) => { d.route = { from: [47.05, 8.3], to: [47.05, 8.312] }; }));
  await page.click('.tabs button[data-tab="analysis"]');
  await page.waitForSelector('#exp-load');
  await page.click('#exp-load');
  await page.waitForFunction(() => window.stadtplaner.buildings.ways.size === 3);
  await page.waitForSelector('#exp-show');
  const panel = await page.textContent('#analysis-panel');
  assert.ok(panel.includes('3 Gebäude geladen'));
  assert.ok(/Entlang neuer Strassen\s*2/.test(panel.replace(/\s+/g, ' ')), panel);
  await page.selectOption('#exp-radius', '25');
  await h.settle(300);
  assert.ok(/Entlang neuer Strassen\s*2/.test((await page.textContent('#analysis-panel')).replace(/\s+/g, ' ')), '22 m Abstand liegt noch innerhalb von 25 m');
  await page.check('#exp-show');
  await h.settle(300);
  const bpix = await page.evaluate(() => {
    const sp = window.stadtplaner;
    const p = sp.map.project([47.05025, 8.30205]);
    const canvas = document.querySelector('.smap-canvas');
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.ok(bpix[0] > bpix[1] + 40, `betroffenes Gebäude rot: rgb(${bpix})`);
  console.log('✓ Betroffene Gebäude');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST dossier OK');
})().catch((e) => { console.error('BROWSER-TEST dossier FAILED:', e); process.exit(1); });
