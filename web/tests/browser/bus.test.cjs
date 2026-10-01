// Buslinien: Linie anlegen, Haltestellen per Klick setzen und anhängen, Liniennummern, Fahrzeit über die
// Busschleuse (Zugang nur Bus), Haltestelle verschieben, Reihenfolge, Flächen-Freigabe, Zugang je Strasse/Abschnitt.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  // OSM-Netz: Ost-West- und Nord-Süd-Strasse mit Tempo 20, Kreuz bei (47.05, 8.305)
  await page.route(/\/api\/roads\?/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 1, tags: { highway: 'residential', maxspeed: '20' }, geometry: [[47.05, 8.29], [47.05, 8.305], [47.05, 8.32]] },
      { id: 2, tags: { highway: 'residential', maxspeed: '20' }, geometry: [[47.06, 8.305], [47.05, 8.305], [47.04, 8.305]] },
    ]),
  }));
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Entwurf', (d) => {
      const layerId = d.layers[0].id;
      // Busschleuse: Diagonale von (47.05,8.29) nach (47.06,8.305), nur für Busse
      d.features.push({ id: 'r_bus', type: 'road', layerId, name: 'Busschleuse', kind: 'main', status: 'new', oneway: false, maxspeed: 50, access: 'bus', width: null, section: null, osmId: null, nodes: [[47.05, 8.29], [47.06, 8.305]], segments: [{ level: 'ground', maxspeed: null, access: null }], profile: null, parcels: null, note: '' });
    });
    sp.map.setView([47.05, 8.3], 15);
  });
  await page.click('.tabs button[data-tab="route"]');
  await page.waitForSelector('#bus-add');
  const box = await h.mapBox();
  const at = async (ll) => {
    const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll);
    return { x: box.x + p.x, y: box.y + p.y };
  };
  const busResults = () => page.evaluate(() => window.stadtplaner.actions.busResults());

  // --- Linie anlegen, Nummer setzen, Haltestellen per Klick -----------------------------
  await page.click('#bus-add');
  await h.settle(200);
  let doc = await h.doc();
  assert.equal(doc.busLines.length, 1);
  assert.equal(doc.busLines[0].name, '1');
  let panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(panel.includes('Haltestellen anklicken oder neue setzen'), panel);
  await page.fill('.bus-name', '12');
  await page.press('.bus-name', 'Enter');
  await h.settle(200);
  assert.equal((await h.doc()).busLines[0].name, '12');
  assert.ok(await page.evaluate(() => window.stadtplaner.tools.routeTarget && !!window.stadtplaner.tools.routeTarget.busLine), 'Erfassung bleibt nach Umbenennen aktiv');
  const a = await at([47.05, 8.29]);
  const b = await at([47.06, 8.305]);
  await page.mouse.click(a.x, a.y);
  await h.settle(200);
  doc = await h.doc();
  const stops = doc.features.filter((f) => f.type === 'junction' && f.kind === 'busstop');
  assert.equal(stops.length, 1, 'erste Haltestelle gesetzt');
  assert.deepEqual(stops[0].lines, ['12'], 'Liniennummer an der Haltestelle');
  assert.deepEqual(doc.busLines[0].stops, [stops[0].id]);
  await page.mouse.click(b.x, b.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.busResults(); return r.length === 1 && r[0].current && r[0].current.path && r[0].proposed && r[0].proposed.path; }, null, { timeout: 10000 });
  doc = await h.doc();
  assert.equal(doc.busLines[0].stops.length, 2);
  assert.equal(doc.features.filter((f) => f.kind === 'busstop').length, 2);
  let res = (await busResults())[0];
  assert.ok(res.proposed.time < res.current.time && res.proposed.dist < res.current.dist * 0.8, `Bus nutzt die Busschleuse: ${JSON.stringify({ c: res.current.time, n: res.proposed.time })}`);
  panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(panel.includes('Fahrzeit') && panel.includes('inkl. Halte') && panel.includes('−'), panel);
  // Bestehende Haltestelle erneut anklicken: hängt sie an (nicht die letzte)
  await page.mouse.click(a.x, a.y);
  await h.settle(300);
  doc = await h.doc();
  assert.equal(doc.busLines[0].stops.length, 3, 'bestehende Haltestelle angehängt');
  assert.equal(doc.features.filter((f) => f.kind === 'busstop').length, 2, 'keine neue Haltestelle');
  await page.mouse.click(a.x, a.y);
  await h.settle(300);
  assert.equal((await h.doc()).busLines[0].stops.length, 3, 'letzte Haltestelle nicht doppelt');
  await page.keyboard.press('Escape');
  await h.settle(200);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.routeTarget), null, 'Esc beendet die Erfassung');
  console.log('✓ Buslinie und Haltestellen');

  // --- Auto bleibt auf dem Umweg: Routenpaar über dieselben Punkte -------------------------
  await page.click('#pair-add');
  await h.settle(200);
  await page.mouse.click(a.x, a.y);
  await h.settle(150);
  await page.mouse.click(b.x, b.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.pairResults(); return r.length === 1 && r[0].current && r[0].current.path && r[0].proposed && r[0].proposed.path; }, null, { timeout: 10000 });
  const pair = await page.evaluate(() => window.stadtplaner.actions.pairResults()[0]);
  assert.ok(Math.abs(pair.proposed.dist - pair.current.dist) < 1, `Auto darf nicht durch die Busschleuse: ${pair.proposed.dist} vs ${pair.current.dist}`);
  console.log('✓ Busschleuse sperrt Autos');

  // --- Haltestelle: Liniennummern bearbeiten, am Griff verschieben ------------------------
  await page.click('.tabs button[data-tab="draw"]');
  await page.keyboard.press('v');
  doc = await h.doc();
  const first = doc.features.find((f) => f.kind === 'busstop');
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id }), first.id);
  await page.waitForSelector('#prop-lines');
  assert.equal(await page.inputValue('#prop-lines'), '12');
  await page.fill('#prop-lines', '12, 45, 12');
  await page.press('#prop-lines', 'Enter');
  await h.settle(200);
  assert.deepEqual((await h.doc()).features.find((f) => f.id === first.id).lines, ['12', '45', '12'].filter((v, i, arr) => arr.indexOf(v) === i), 'Liniennummern ohne Doppelte');
  const from = await at(first.at);
  const target = await at([47.05, 8.295]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 15, from.y + 5, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();
  await h.settle(400);
  doc = await h.doc();
  const moved = doc.features.find((f) => f.id === first.id);
  assert.ok(Math.abs(moved.at[1] - 8.295) < 0.0006 && Math.abs(moved.at[0] - 47.05) < 0.0003, `Haltestelle verschoben: ${moved.at}`);
  assert.equal(doc.busLines[0].stops[0], first.id, 'Linie behält die Haltestelle');
  await page.waitForFunction((t0) => { const r = window.stadtplaner.actions.busResults(); return r[0] && r[0].proposed && r[0].proposed.path && Math.abs(r[0].proposed.dist - t0) > 50; }, res.proposed.dist, { timeout: 10000 });
  console.log('✓ Haltestelle verschieben und Liniennummern');

  // --- Reihenfolge und Entfernen, Haltezeit ------------------------------------------------
  await page.click('.tabs button[data-tab="route"]');
  await page.waitForSelector('.stop-up');
  await page.click('.stop-up[data-i="1"]');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.busLines[0].stops[0], doc.features.filter((f) => f.kind === 'busstop')[1].id, 'nach vorne verschoben');
  await page.click('.stop-del[data-i="2"]');
  await h.settle(200);
  assert.equal((await h.doc()).busLines[0].stops.length, 2);
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.busResults(); return r[0] && r[0].stops === 2 && r[0].proposed && r[0].proposed.legs && r[0].proposed.legs.length === 1; }, null, { timeout: 10000 });
  res = (await busResults())[0];
  const t2 = res.proposed.time;
  await page.fill('.bus-dwell', '60');
  await page.press('.bus-dwell', 'Enter');
  await h.settle(300);
  assert.equal((await h.doc()).busLines[0].dwell, 60);
  // Zwei Halte = kein Zwischenhalt: Haltezeit ändert nichts; dritter Halt bringt 60 s
  res = (await busResults())[0];
  assert.ok(Math.abs(res.proposed.time - t2) < 1e-6, 'ohne Zwischenhalt keine Haltezeit');
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Zwischenhalt', (d) => {
      const stop = { id: 'j_mid', type: 'junction', layerId: d.layers[0].id, name: 'Mitte', kind: 'busstop', at: [47.05, 8.305], turns: null, lines: ['12'], note: '' };
      d.features.push(stop);
      d.busLines[0].stops.splice(1, 0, stop.id);
    });
  });
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.busResults(); return r[0] && r[0].stops === 3 && r[0].proposed && r[0].proposed.legs && r[0].proposed.legs.length === 2; }, null, { timeout: 10000 });
  res = (await busResults())[0];
  assert.ok(Math.abs(res.proposed.time - (res.proposed.legs[0].time + res.proposed.legs[1].time + 60)) < 1e-6, 'Haltezeit je Zwischenhalt');
  panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(panel.includes('2. Mitte'), panel);
  console.log('✓ Reihenfolge, Entfernen, Haltezeit');

  // --- Zugang je Strasse und Abschnitt, Flächen-Freigabe ------------------------------------
  await page.click('.tabs button[data-tab="draw"]');
  await page.evaluate(() => window.stadtplaner.tools.setSelection({ featureId: 'r_bus', segIndex: 0 }));
  await page.waitForSelector('#prop-access');
  assert.equal(await page.inputValue('#prop-access'), 'bus');
  assert.ok((await page.textContent('#properties')).includes('Busschleuse'));
  await page.selectOption('#prop-access', 'all');
  await h.settle(200);
  assert.equal((await h.doc()).features.find((f) => f.id === 'r_bus').access, 'all');
  await page.waitForSelector('#seg-access');
  await page.selectOption('#seg-access', 'bus');
  await h.settle(200);
  assert.equal((await h.doc()).features.find((f) => f.id === 'r_bus').segments[0].access, 'bus');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.pairResults(); return r[0] && r[0].proposed && r[0].proposed.path; }, null, { timeout: 10000 });
  const pair2 = await page.evaluate(() => window.stadtplaner.actions.pairResults()[0]);
  assert.ok(Math.abs(pair2.proposed.dist - pair2.current.dist) < 1, 'Abschnitts-Zugang sperrt Autos weiterhin');
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Fussgängerzone', (d) => {
      d.features.push({ id: 'z_fz', type: 'zone', layerId: d.layers[0].id, name: '', kind: 'pedestrian', nodes: [[47.049, 8.3], [47.049, 8.31], [47.051, 8.31], [47.051, 8.3]], busAllowed: false, note: '' });
    });
  });
  await page.evaluate(() => window.stadtplaner.tools.setSelection({ featureId: 'z_fz' }));
  await page.waitForSelector('#prop-bus-allowed');
  assert.ok(!(await page.isChecked('#prop-bus-allowed')));
  await page.check('#prop-bus-allowed');
  await h.settle(200);
  assert.equal((await h.doc()).features.find((f) => f.id === 'z_fz').busAllowed, true);
  await page.selectOption('#prop-zkind', 'parking');
  await h.settle(200);
  assert.equal(await page.locator('#prop-bus-allowed').count(), 0, 'Freigabe nur bei gesperrten/langsamen Flächen');
  console.log('✓ Zugang und Flächen-Freigabe');

  // --- Linie löschen, Grenze ---------------------------------------------------------------
  await page.click('.tabs button[data-tab="route"]');
  await page.waitForSelector('.bus-del');
  await page.click('.bus-del');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.busLines.length, 0);
  assert.equal(doc.features.filter((f) => f.kind === 'busstop').length, 3, 'Haltestellen bleiben als Punkte');
  await page.waitForFunction(() => window.stadtplaner.actions.busResults().length === 0, null, { timeout: 5000 });
  console.log('✓ Linie löschen');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST bus OK');
})().catch((e) => { console.error('BROWSER-TEST bus FAILED:', e); process.exit(1); });
