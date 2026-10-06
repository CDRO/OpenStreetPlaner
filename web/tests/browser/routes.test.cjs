// Routen: Marker ziehen, Zwischenpunkte, weitere Routen, Tunnel nur an den Enden, Netz um Trassen automatisch.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  // Rechteck-Netz: unten (47.05) und oben (47.06) je eine Strasse von 8.30 bis 8.32, links und rechts verbunden
  const roadsCalls = [];
  await page.route(/\/api\/roads\?/, (route) => {
    roadsCalls.push(new URL(route.request().url()).searchParams.get('bbox'));
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.05, 8.30], [47.05, 8.31], [47.05, 8.32]] },
      { id: 2, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.05, 8.32], [47.06, 8.32]] },
      { id: 3, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.05, 8.30], [47.06, 8.30], [47.06, 8.32]] },
    ]) });
  });
  await page.evaluate(() => window.stadtplaner.map.setView([47.055, 8.31], 15));
  await h.settle(300);
  const box = await h.mapBox();
  const px = async (ll) => { const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll); return { x: box.x + p.x, y: box.y + p.y }; };

  // Route A (unten links) -> B (oben rechts)
  await page.keyboard.press('t');
  const A = await px([47.05, 8.30]);
  const B = await px([47.06, 8.32]);
  await page.mouse.click(A.x, A.y);
  await h.settle(100);
  await page.mouse.click(B.x, B.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.current && !r.current.error; }, null, { polling: 100 });
  const direct = await page.evaluate(() => window.stadtplaner.routes().current.dist);
  assert.ok(direct > 2000 && direct < 3000, `L-Route ${direct} m`);
  console.log('✓ Route gesetzt');

  // Zwischenpunkt per Knopf: nächster Klick fügt ihn ein, die Route geht über die Ecke oben links
  await page.click('.tabs button[data-tab="route"]');
  await page.click('#route-via');
  assert.ok((await page.textContent('#status-hint')).includes('Zwischenpunkt'), 'Hinweis zum Zwischenpunkt');
  const V = await px([47.06, 8.30]);
  await page.mouse.click(V.x, V.y);
  await page.waitForFunction(() => { const q = window.stadtplaner.store.doc.route; return q && q.via && q.via.length === 1; }, null, { polling: 100 });
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.current && r.current.legs === 2; }, null, { polling: 100 });
  const viaRoute = await page.evaluate(() => window.stadtplaner.routes().current);
  assert.ok(viaRoute.path.some((p) => Math.abs(p[0] - 47.06) < 1e-4 && Math.abs(p[1] - 8.30) < 1e-4), 'Pfad führt über den Zwischenpunkt');
  assert.ok((await page.textContent('#route-panel')).includes('1 Zwischenpunkt'));
  // Klick auf einen Marker beginnt keine neue Route
  await page.mouse.click(V.x, V.y);
  await h.settle(200);
  assert.equal(await page.evaluate(() => window.stadtplaner.store.doc.route.via.length), 1, 'Marker-Klick lässt die Route stehen');
  console.log('✓ Zwischenpunkt');

  // Ziel ziehen: neue Position, Rückgängig stellt sie zurück
  const Bp = await px([47.06, 8.32]);
  await page.mouse.move(Bp.x, Bp.y);
  await page.mouse.down();
  await page.mouse.move(Bp.x - 60, Bp.y + 40, { steps: 8 });
  await page.mouse.up();
  await h.settle(300);
  const moved = await page.evaluate(() => window.stadtplaner.store.doc.route.to);
  assert.ok(moved[1] < 8.32 - 0.0005 && moved[0] < 47.06 - 0.0002, `Ziel verschoben: ${moved}`);
  await page.keyboard.press('Control+z');
  await h.settle(200);
  assert.deepEqual(await page.evaluate(() => window.stadtplaner.store.doc.route.to), [47.06, 8.32], 'Rückgängig');
  // Rechtsklick auf den Zwischenpunkt: entfernen
  const Vp = await px([47.06, 8.30]);
  await page.mouse.click(Vp.x, Vp.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  await page.click('#context-menu button:has-text("Zwischenpunkt entfernen")');
  await h.settle(200);
  assert.equal(await page.evaluate(() => window.stadtplaner.store.doc.route.via.length), 0);
  console.log('✓ Marker ziehen und Kontextmenü');

  // Weitere Route mit eigenem Zwischenpunkt
  await page.click('#pair-add');
  await page.mouse.click(A.x, A.y);
  await h.settle(100);
  await page.mouse.click(B.x, B.y);
  await page.waitForFunction(() => window.stadtplaner.store.doc.routePairs.length === 1 && window.stadtplaner.store.doc.routePairs[0].to, null, { polling: 100 });
  await page.click('.pair-via');
  await page.mouse.click(V.x, V.y);
  await page.waitForFunction(() => window.stadtplaner.store.doc.routePairs[0].via.length === 1, null, { polling: 100 });
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.pairResults(); return r.length === 1 && r[0].current && r[0].current.legs === 2; }, null, { polling: 100 });
  assert.ok((await page.textContent('.route-table.pairs')).includes('1 Zwischenpunkt'));
  console.log('✓ Weitere Route');

  // Tunnel: eine Trasse quer unter der unteren Strasse hindurch ist von dort nicht erreichbar
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Tunnel', (d) => {
      const layerId = d.layers[0].id;
      d.route = { from: [47.05, 8.30], to: [47.045, 8.315], via: [], vehicle: 'car' };
      d.routePairs = [];
      d.features.push({ id: 't1', type: 'road', layerId, kind: 'main', status: 'new', name: 'Tunnel', nodes: [[47.055, 8.305], [47.05, 8.31], [47.045, 8.315]], segments: [{ level: 'tunnel', maxspeed: null }, { level: 'tunnel', maxspeed: null }], oneway: false, maxspeed: null });
    });
  });
  // auf das Ergebnis zur neuen Anfrage warten (Fehler oder Pfad, der am neuen Ziel endet)
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && (r.proposed.error || (r.proposed.path && Math.abs(r.proposed.path[r.proposed.path.length - 1][0] - 47.045) < 1e-6)); }, null, { polling: 100 });
  const tunnel = await page.evaluate(() => window.stadtplaner.routes().proposed);
  assert.ok(tunnel.error, 'kein Einstieg in den Tunnel von der Strasse darüber');
  await page.evaluate(() => window.stadtplaner.store.commit('ebenerdig', (d) => { d.features[d.features.length - 1].segments.forEach((s) => { s.level = 'ground'; }); }));
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && !r.proposed.error && Math.abs(r.proposed.path[r.proposed.path.length - 1][0] - 47.045) < 1e-6; }, null, { polling: 100 });
  console.log('✓ Tunnel nur an den Enden');

  // Netz um gezeichnete Trassen: eine Strasse weit abseits der Route löst das Nachladen ihrer Zelle aus
  const before = roadsCalls.length;
  await page.evaluate(() => window.stadtplaner.store.commit('abseits', (d) => {
    d.features.push({ id: 'far', type: 'road', layerId: d.layers[0].id, kind: 'main', status: 'new', name: 'Abseits', nodes: [[47.12, 8.40], [47.121, 8.405]], segments: [{ level: 'ground', maxspeed: null }], oneway: false, maxspeed: null });
  }));
  await page.waitForFunction((n) => window.stadtplaner.osm.pending === null && document.body && n >= 0, before, { polling: 100 });
  await h.settle(500);
  assert.ok(roadsCalls.slice(before).some((bbox) => { const [s, w, n, e] = bbox.split(',').map(Number); return s <= 47.12 && n >= 47.121 && w <= 8.40 && e >= 8.405; }), `Zelle der abseitigen Trasse geladen: ${roadsCalls.slice(before).join(' | ')}`);
  console.log('✓ Netz um Trassen automatisch');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('Browser-Tests routes OK');
})().catch((e) => { console.error('BROWSER-TEST routes FAILED:', e); process.exit(1); });
