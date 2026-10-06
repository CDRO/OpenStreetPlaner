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
  await page.waitForFunction(() => !window.stadtplaner.osm.pending, null, { polling: 100 });
  const initialCalls = roadsCalls;
  assert.ok(initialCalls >= 1 && initialCalls <= 4, `Ansicht deckt 1–4 Zellen ab (${initialCalls})`);
  assert.ok((await page.textContent('#status-osm')).includes('4 OSM-Strassen'));
  await page.evaluate(() => window.stadtplaner.map.panBy(20, 20));
  await h.settle(600);
  assert.equal(roadsCalls, initialCalls, 'kleiner Versatz lädt nicht neu');
  await h.openSettings();
  await page.check('#set-show-osm');
  await h.closeSettings();
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
  assert.ok((await page.textContent('.speed.std')).includes('50'), 'Standard-Schild zeigt den Standardwert');
  assert.ok(await page.locator('.speed.std.active').count() === 1, 'ohne eigenen Wert ist das Standard-Schild markiert');
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

  // Zone: Tempo-30-Fläche über die Abkürzung legen -> neue Route wird langsamer
  await page.evaluate(() => window.stadtplaner.tools.setSelection(null));
  const beforeZone = await page.evaluate(() => window.stadtplaner.routes());
  await page.keyboard.press('t');
  await page.mouse.click(box.x + pa.x, box.y + pa.y);
  await h.settle(200);
  await page.mouse.click(box.x + pb.x, box.y + pb.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && !r.proposed.error; });
  const noZone = await page.evaluate(() => window.stadtplaner.routes());
  await page.keyboard.press('f');
  const zc = { x: box.x + (pa.x + pb.x) / 2, y: box.y + (pa.y + pb.y) / 2 };
  await page.keyboard.down('Shift');
  for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60]]) {
    await page.mouse.click(zc.x + dx, zc.y + dy);
    await h.settle(80);
  }
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) => { const r = window.stadtplaner.routes(); return r && r.proposed && !r.proposed.error && r.proposed.time > t; }, noZone.proposed.time);
  doc = await h.doc();
  const zone = doc.features.find((f) => f.type === 'zone');
  assert.ok(zone && zone.kind === 'tempo30' && zone.nodes.length === 4, 'Tempo-30-Zone gezeichnet');
  const withZone = await page.evaluate(() => window.stadtplaner.routes());
  assert.ok(withZone.proposed.time > noZone.proposed.time, `Zone verlangsamt: ${withZone.proposed.time} > ${noZone.proposed.time}`);
  assert.ok(Math.abs(withZone.current.time - noZone.current.time) < 1e-6, 'heute unverändert');
  // Zone auswählen (Klick ins Innere), Art ändern, Eckpunkt einfügen
  await page.keyboard.press('v');
  await page.mouse.click(zc.x + 20, zc.y + 25);
  await h.settle(300);
  assert.ok(await page.locator('#prop-zkind').count(), 'Zone per Klick ins Innere ausgewählt');
  await page.selectOption('#prop-zkind', 'parking');
  await h.settle(400);
  assert.equal((await h.doc()).features.find((f) => f.type === 'zone').kind, 'parking');
  const zmid = await h.project([(zone.nodes[0][0] + zone.nodes[1][0]) / 2, (zone.nodes[0][1] + zone.nodes[1][1]) / 2]);
  await page.mouse.click(box.x + zmid.x, box.y + zmid.y);
  await h.settle(400);
  assert.equal((await h.doc()).features.find((f) => f.type === 'zone').nodes.length, 5, 'Eckpunkt eingefügt');
  await page.keyboard.press('Delete');
  await h.settle(300);
  assert.equal((await h.doc()).features.filter((f) => f.type === 'zone').length, 0);
  await page.evaluate(() => window.stadtplaner.actions.clearRoute());
  await h.settle(200);
  void beforeZone;
  console.log('✓ Zonen');

  // Glätten, Vereinfachen, Höhenprofil (gemockt), Geschwindigkeitsmodell mit Band
  await page.route('**/api/profile', async (route) => {
    const body = JSON.parse(route.request().postData());
    const n = body.coords.length;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ points: [[0, 500], [200, 520], [400, 510]] }) });
    void n;
  });
  await page.keyboard.press('s');
  const gA = { x: box.x + 500, y: box.y + 200 };
  await page.keyboard.down('Shift');
  await page.mouse.click(gA.x, gA.y); await h.settle(60);
  await page.mouse.click(gA.x + 120, gA.y + 90); await h.settle(60);
  await page.mouse.click(gA.x + 240, gA.y + 20); await h.settle(60);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await h.settle();
  doc = await h.doc();
  const zig = doc.features[doc.features.length - 1];
  assert.equal(zig.nodes.length, 3);
  await page.keyboard.press('v');
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id, segIndex: 0 }), zig.id);
  await h.settle(300);
  await page.click('#prop-smooth');
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features.find((f) => f.id === zig.id).nodes.length, 3 + 2 * 4, 'Glätten fügt 4 Zwischenpunkte je Abschnitt ein');
  await page.click('#prop-simplify');
  await h.settle();
  doc = await h.doc();
  const afterSimplify = doc.features.find((f) => f.id === zig.id).nodes.length;
  assert.ok(afterSimplify < 11 && afterSimplify >= 3, `Vereinfachen reduziert (${afterSimplify})`);
  await page.click('#prop-profile-load');
  await page.waitForSelector('#prop-profile-chart');
  doc = await h.doc();
  const withProfile = doc.features.find((f) => f.id === zig.id);
  assert.equal(withProfile.profile.points.length, 3);
  assert.ok((await page.textContent('.profile-box')).includes('max. Steigung'));
  await page.click('#prop-profile-clear');
  await h.settle();
  assert.equal((await h.doc()).features.find((f) => f.id === zig.id).profile, null);
  // Geschwindigkeitsmodell: Route über die geglättete Strasse zeigt ein Band
  await page.keyboard.press('t');
  const zA = await h.project(withProfile.nodes[0]);
  const zB = await h.project(withProfile.nodes[withProfile.nodes.length - 1]);
  await page.mouse.click(box.x + zA.x, box.y + zA.y);
  await h.settle(200);
  await page.mouse.click(box.x + zB.x, box.y + zB.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && !r.proposed.error; });
  await page.click('.tabs button[data-tab="route"]');
  await page.check('#route-model');
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.model === 'geometry' && r.proposed && r.proposed.sd > 0; });
  assert.ok((await page.textContent('#route-panel')).includes('P15–P85'), 'Band im Panel');
  await page.uncheck('#route-model');
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.model === 'limit'; });
  await page.evaluate(() => window.stadtplaner.actions.clearRoute());
  await page.keyboard.press('v');
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id, segIndex: 0 }), zig.id);
  await h.settle(200);
  await page.keyboard.press('Delete');
  await h.settle(300);
  console.log('✓ Glätten, Profil, Geschwindigkeitsmodell');

  // Kartenquellen: Grundkarte wechseln und Parzellen-Overlay einschalten -> Kacheln der Quellen werden angefragt
  const tileHits = { swisstopo: 0, cadastre: 0, osm: 0 };
  await page.route(/\/tiles\/(\w[\w-]*\/)?\d+\/\d+\/\d+/, (route) => {
    const u = route.request().url();
    for (const k of Object.keys(tileHits)) if (u.includes(`/tiles/${k}/`)) tileHits[k]++;
    route.abort();
  });
  await h.openSettings();
  await page.waitForFunction(() => document.querySelectorAll('#set-basemap option').length >= 4);
  await page.selectOption('#set-basemap', 'swisstopo');
  await h.settle(500);
  assert.ok(tileHits.swisstopo > 0, `swisstopo-Kacheln angefragt (${tileHits.swisstopo})`);
  await page.check('.set-overlay[data-id="cadastre"]');
  await h.settle(500);
  assert.ok(tileHits.cadastre > 0, `Parzellen-Overlay angefragt (${tileHits.cadastre})`);
  assert.ok((await page.textContent('.smap-attribution')).includes('swisstopo'));
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.settings')));
  assert.equal(persisted.basemap, 'swisstopo');
  assert.deepEqual(persisted.overlays, ['cadastre']);
  await page.uncheck('.set-overlay[data-id="cadastre"]');
  await page.selectOption('#set-basemap', 'osm');
  await h.closeSettings();
  await h.settle(300);
  console.log('✓ Kartenquellen');

  // Kachelweises Laden: grosser Bereich -> mehrere Zellen, jede einmal
  const before = roadsCalls;
  await page.evaluate(() => window.stadtplaner.osm.ensureArea({ south: 47.03, west: 8.28, north: 47.08, east: 8.36 }));
  await page.waitForFunction(() => !window.stadtplaner.osm.pending, null, { polling: 100 });
  const cellsLoaded = roadsCalls - before;
  assert.ok(cellsLoaded >= 4 && cellsLoaded <= 16, `Zellen geladen: ${cellsLoaded}`);
  await page.evaluate(() => window.stadtplaner.osm.ensureArea({ south: 47.03, west: 8.28, north: 47.08, east: 8.36 }));
  await h.settle(300);
  assert.equal(roadsCalls - before, cellsLoaded, 'zweite Anfrage lädt nichts neu');
  console.log('✓ Kachelweises Netz-Laden');

  // Export-Dialog: PNG in 96 dpi (Ansicht) und PDF A3 300 dpi (ganzer Entwurf)
  await page.click('.tabs button[data-tab="drafts"]');
  await page.click('#d-export');
  await page.click('#d-export-map');
  await page.waitForSelector('#export-png');
  await page.selectOption('#export-dpi', '96');
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#export-png')]);
  assert.ok(png.suggestedFilename().endsWith('.png'));
  const pngBytes = require('fs').readFileSync(await png.path());
  assert.deepEqual(Array.from(pngBytes.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'PNG-Signatur');
  await page.selectOption('#export-mode', 'all');
  await page.selectOption('#export-paper', 'a3');
  await page.selectOption('#export-dpi', '300');
  const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#export-pdf')]);
  assert.ok(pdf.suggestedFilename().endsWith('.pdf'));
  const pdfBytes = require('fs').readFileSync(await pdf.path());
  assert.equal(pdfBytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  const pdfText = pdfBytes.toString('latin1');
  assert.ok(pdfText.includes('/MediaBox [0 0 1190.55 841.89]'), 'A3 quer');
  const width = Number(/\/Width (\d+)/.exec(pdfText)[1]);
  assert.ok(width > 4000, `300 dpi auf A3 ergibt breites Bild (${width} px)`);
  await page.keyboard.press('Escape');
  console.log('✓ Export in Druckqualität');
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
