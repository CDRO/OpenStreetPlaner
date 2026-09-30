// Suche, OSM-Strassen (gemockt über die API-Routen), Einrasten an OSM,
// OSM übernehmen, Griffe (ziehen, einfügen, löschen), Exporte, Entf.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';
const C = [47.05, 8.3];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  let roadsCalls = 0;
  await page.route('**/api/roads**', async (route) => {
    roadsCalls++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { id: 4242, tags: { highway: 'primary', name: 'Dorfstrasse', oneway: 'yes', maxspeed: '50' }, geometry: [[C[0] - 0.002, C[1] - 0.004], [C[0], C[1]], [C[0] + 0.002, C[1] + 0.004]] },
      { id: 4243, tags: { highway: 'residential', bridge: 'yes', maxspeed: '30 mph' }, geometry: [[C[0] - 0.0015, C[1] - 0.004], [C[0] - 0.0015, C[1] + 0.004]] },
      // Umweg für den Routen-Rechner: von U1 nach U3 nur über die Ecke U2
      { id: 5001, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[C[0] + 0.004, C[1] - 0.006], [C[0] + 0.004, C[1] - 0.003]] },
      { id: 5002, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[C[0] + 0.004, C[1] - 0.003], [C[0] + 0.007, C[1] - 0.003]] },
    ]) });
  });
  await page.route('**/api/search**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { label: 'Testdorf, Schweiz', lat: 47.2, lng: 8.5, type: 'village', bbox: [47.19, 47.21, 8.49, 8.51] },
    ]) });
  });

  // Suche
  await page.fill('#search-input', 'Testdorf');
  await page.press('#search-input', 'Enter');
  await page.waitForSelector('#search-results button');
  await page.click('#search-results button');
  await h.settle(800);
  const center = await page.evaluate(() => window.stadtplaner.map.getCenter());
  assert.ok(Math.abs(center[0] - 47.2) < 0.01 && Math.abs(center[1] - 8.5) < 0.01, 'Karte springt zum Suchergebnis');
  assert.equal(await page.locator('#pin').isVisible(), true, 'Markierung gesetzt');
  await page.fill('#search-input', '47.1, 8.4');
  await page.press('#search-input', 'Enter');
  await page.waitForSelector('#search-results button');
  assert.ok((await page.locator('#search-results button').textContent()).includes('Koordinate'));
  await page.keyboard.press('Escape');
  console.log('✓ Suche');

  // OSM laden bei Zoom 17
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.3], 17));
  await h.settle(800);
  assert.equal(roadsCalls, 1, 'Strassen genau einmal abgefragt');
  assert.ok((await page.textContent('#status-osm')).includes('4 OSM-Strassen'));
  await page.evaluate(() => window.stadtplaner.map.panBy(20, 20));
  await h.settle(600);
  assert.equal(roadsCalls, 1, 'kleiner Versatz lädt nicht neu');
  await page.check('#set-show-osm');
  await h.settle(300);
  console.log('✓ OSM-Strassen laden');

  // Strasse mit Einrasten auf OSM-Knoten beginnen
  const box = await h.mapBox();
  const pt = await h.project([47.05, 8.3]);
  await page.keyboard.press('s');
  await page.mouse.click(box.x + pt.x + 5, box.y + pt.y - 4);
  await h.settle(80);
  await page.mouse.click(box.x + pt.x + 200, box.y + pt.y - 150);
  await page.keyboard.press('Enter');
  await h.settle();
  let doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.deepEqual(doc.features[0].nodes[0], [47.05, 8.3], 'Startpunkt auf OSM-Knoten eingerastet');
  console.log('✓ Einrasten an OSM-Strasse');

  // OSM übernehmen
  await page.keyboard.press('o');
  const mid = await h.project([47.051, 8.302]);
  await page.mouse.click(box.x + mid.x + 3, box.y + mid.y);
  await h.settle();
  doc = await h.doc();
  const adopted = doc.features[1];
  assert.equal(adopted.name, 'Dorfstrasse');
  assert.equal(adopted.status, 'existing');
  assert.equal(adopted.kind, 'main');
  assert.equal(adopted.oneway, true);
  assert.equal(adopted.maxspeed, 50, 'Tempolimit aus OSM übernommen');
  assert.equal(adopted.osmId, 4242, 'OSM-Way gemerkt');
  const bmid = await h.project([47.0485, 8.3]);
  await page.mouse.click(box.x + bmid.x, box.y + bmid.y + 2);
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features[2].segments[0].level, 'bridge', 'bridge=yes wird als Brücke übernommen');
  assert.equal(doc.features[2].maxspeed, 48, '30 mph -> 48 km/h');
  console.log('✓ OSM übernehmen');

  // Tempolimit in den Eigenschaften setzen
  await page.keyboard.press('v');
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id, segIndex: 0 }), doc.features[0].id);
  await h.settle(300);
  assert.ok((await page.locator('#prop-maxspeed').getAttribute('placeholder')).includes('Standard 50'));
  await page.click('.speed[data-speed="30"]');
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features[0].maxspeed, 30);
  await page.fill('#prop-maxspeed', '63');
  await page.press('#prop-maxspeed', 'Tab');
  await h.settle();
  assert.equal((await h.doc()).features[0].maxspeed, 65, 'auf 5er-Schritte gerundet');
  await page.click('.speed[data-speed=""]');
  await h.settle();
  assert.equal((await h.doc()).features[0].maxspeed, null, 'Standard = kein Limit gesetzt');
  console.log('✓ Tempolimit');

  // Routen-Rechner: heute über die Ecke, neu über eine gezeichnete Abkürzung
  const U1 = [C[0] + 0.004, C[1] - 0.006];
  const U3 = [C[0] + 0.007, C[1] - 0.003];
  await page.evaluate(() => window.stadtplaner.map.setView([47.0555, 8.2955], 16.5));
  await h.settle(500);
  await page.click('.tabs button[data-tab="route"]');
  await h.settle(200);
  assert.ok((await page.locator('.tool.active').textContent()).includes('Route'), 'Route-Tab aktiviert Werkzeug');
  const pa = await h.project(U1);
  const pb = await h.project(U3);
  await page.mouse.click(box.x + pa.x, box.y + pa.y);
  await h.settle(200);
  await page.mouse.click(box.x + pb.x, box.y + pb.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.current && !r.current.error; });
  let routes = await page.evaluate(() => window.stadtplaner.routes());
  assert.ok(Math.abs(routes.current.dist - routes.proposed.dist) < 1, 'ohne Änderung gleiche Distanz');
  assert.ok(routes.current.dist > 550 && routes.current.dist < 620, `Umweg ${routes.current.dist}`);
  assert.ok((await page.textContent('#route-panel')).includes('Fahrzeit'));
  // Abkürzung zeichnen (Shift: nicht einrasten ausser an den Endpunkten, die exakt getroffen werden)
  await page.keyboard.press('s');
  await page.mouse.click(box.x + pa.x, box.y + pa.y);
  await h.settle(80);
  await page.mouse.click(box.x + pb.x, box.y + pb.y);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && !r.proposed.error && r.proposed.dist < r.current.dist * 0.9; });
  routes = await page.evaluate(() => window.stadtplaner.routes());
  assert.ok(routes.proposed.time < routes.current.time, 'neu schneller');
  const panel = await page.textContent('#route-panel');
  assert.ok(panel.includes('−'), 'Differenz negativ angezeigt');
  // A <-> B tauschen und Route löschen
  await page.click('.tabs button[data-tab="route"]');
  await page.click('#route-swap');
  await h.settle(400);
  doc = await h.doc();
  assert.deepEqual(doc.route.from, U3.map((v) => Math.round(v * 1e6) / 1e6));
  await page.click('#route-clear');
  await h.settle(300);
  assert.equal((await h.doc()).route, null);
  console.log('✓ Routen-Rechner');

  // PNG- und PDF-Export
  await page.click('.tabs button[data-tab="drafts"]');
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#d-png')]);
  assert.ok(png.suggestedFilename().endsWith('.png'));
  const pngBytes = require('fs').readFileSync(await png.path());
  assert.deepEqual(Array.from(pngBytes.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'PNG-Signatur');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#d-pdf')]);
  assert.ok(pdf.suggestedFilename().endsWith('.pdf'));
  const pdfBytes = require('fs').readFileSync(await pdf.path());
  assert.equal(pdfBytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdfBytes.toString('latin1').includes('/DCTDecode'));
  assert.ok(pdfBytes.length > 20000, `PDF enthält ein Bild (${pdfBytes.length} Bytes)`);
  console.log('✓ PNG/PDF-Export');
  await page.keyboard.press('v');
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.3], 17));
  await h.settle(500);

  // Griffe: Endpunkt ziehen (rastet auf OSM-Knoten), Zwischenpunkt einfügen, Punkt löschen
  await page.keyboard.press('v');
  const r0 = doc.features[0];
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id, segIndex: 0 }), r0.id);
  await h.settle(300);
  assert.ok(await page.locator('#prop-kind').count(), 'Strasse ausgewählt');
  const endPt = await h.project(r0.nodes[1]);
  const target = await h.project([47.052, 8.304]);
  await page.mouse.move(box.x + endPt.x, box.y + endPt.y);
  await page.mouse.down();
  await page.mouse.move(box.x + endPt.x - 30, box.y + endPt.y + 10, { steps: 4 });
  await page.mouse.move(box.x + target.x + 4, box.y + target.y - 3, { steps: 6 });
  await page.mouse.up();
  await h.settle();
  doc = await h.doc();
  assert.deepEqual(doc.features[0].nodes[1], [47.052, 8.304], 'Griff rastet beim Ziehen auf OSM-Knoten');
  const a = doc.features[0].nodes[0], b = doc.features[0].nodes[1];
  const midPt = await h.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  await page.mouse.click(box.x + midPt.x, box.y + midPt.y);
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features[0].nodes.length, 3, 'Zwischenpunkt eingefügt');
  await page.mouse.click(box.x + midPt.x, box.y + midPt.y, { button: 'right' });
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features[0].nodes.length, 2, 'Punkt per Rechtsklick gelöscht');
  console.log('✓ Griffe: ziehen, einfügen, löschen');

  // Kreisel-Radius via Eigenschaften
  await page.keyboard.press('r');
  await page.mouse.click(box.x + 300, box.y + 600); await h.settle(80);
  await page.mouse.move(box.x + 340, box.y + 600); await h.settle(80);
  await page.mouse.click(box.x + 340, box.y + 600);
  await h.settle();
  await page.keyboard.press('v');
  await page.mouse.click(box.x + 340, box.y + 600);
  await h.settle();
  assert.ok(await page.locator('#prop-radius').count(), 'Kreisel ausgewählt');
  await page.fill('#prop-radius', '22');
  await page.press('#prop-radius', 'Tab');
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features.find((f) => f.type === 'roundabout').radius, 22);
  console.log('✓ Kreisel-Radius');

  // Exporte
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.stadtplaner.actions.exportGeoJson())]);
  assert.ok(dl.suggestedFilename().endsWith('.geojson'));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.stadtplaner.actions.exportJson())]);
  assert.ok(dl2.suggestedFilename().endsWith('.stadtplaner.json'));
  console.log('✓ Exporte');

  await page.keyboard.press('Delete');
  await h.settle();
  assert.equal((await h.doc()).features.filter((f) => f.type === 'roundabout').length, 0, 'Entf löscht Kreisel');
  console.log('✓ Entf');

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST osm-editing OK');
})().catch((e) => { console.error('BROWSER-TEST osm-editing FAILED:', e); process.exit(1); });
