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
  // ÖV aus OSM: bis zum letzten Abschnitt leer, damit das automatische Nachladen beim Setzen von Haltestellen nichts findet
  let transitReady = false;
  let transitCalls = 0;
  await page.route(/\/api\/transit\?/, (route) => {
    transitCalls++;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(transitReady ? {
        stops: [
          { id: 501, name: 'Dorfplatz', at: [47.05, 8.32], lines: ['12'] },
          { id: 502, name: 'Kirche', at: [47.04, 8.305], lines: ['12', '7'] },
          { id: 503, name: 'Schule', at: [47.05, 8.3125] },
        ],
        routes: [
          { id: 9001, ref: '12', name: 'Bus 12: Dorfplatz – Kirche', colour: '#00aa00', operator: 'Ortsbus', source: 'stop', stops: [{ id: 501, name: 'Dorfplatz', at: [47.05, 8.32] }, { id: 503, name: 'Schule', at: [47.05, 8.3125] }, { id: 502, name: 'Kirche', at: [47.04, 8.305] }] },
          { id: 9002, ref: '7', name: 'Bus 7', source: 'platform', stops: [{ id: 502, name: 'Kirche', at: [47.04, 8.305] }, { id: 501, name: 'Dorfplatz', at: [47.05, 8.32] }] },
        ],
      } : { stops: [], routes: [] }),
    });
  });
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
  // Zuversicht der Buslinie: Umweg mit Tempo 20 (maxspeed gesetzt), Schleuse mit Tempo 50, Tempolimit-Modell, Standard-Haltezeit
  // Solange das Netz um die Haltestellen nachlädt, steht „tief“ (Netz unvollständig); danach „mittel“
  await page.waitForFunction(() => { const d = document.querySelector('.bus-line details.conf'); return d && d.className.includes('conf-medium'); }, null, { timeout: 10000 });
  const busConf = page.locator('.bus-line details.conf').first();
  assert.ok((await busConf.innerText()).includes('Zuversicht mittel'), await busConf.innerText());
  await busConf.locator('summary').click();
  const busReasons = (await busConf.locator('.conf-reasons').innerText()).replace(/\s+/g, ' ');
  assert.ok(busReasons.includes('Haltezeit je Zwischenhalt als Standard (20 s)') && busReasons.includes('Tempolimit-Modell'), busReasons);
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
  // Fahrplan-Abgleich: Mock liefert 10 min bei 4 Fahrten; Modell heute (Umweg mit Tempo 20) liegt weit darüber -> Kalibrierung senkt die Haltezeit
  await page.route(/\/api\/timetable\?/, (route) => {
    const u = new URL(route.request().url());
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ from: { id: '1', name: 'Dorf, Post', distance: 30 }, to: { id: '2', name: 'Dorf, Nord', distance: 20 }, line: u.searchParams.get('line'), trips: 4, median: 600, min: 540, max: 660, journeys: [] }) });
  });
  await page.click('.bus-timetable');
  await page.waitForFunction(() => { const l = window.stadtplaner.store.doc.busLines[0]; return l && l.schedule && l.schedule.seconds === 600; }, null, { timeout: 10000 });
  doc = await h.doc();
  assert.equal(doc.busLines[0].schedule.trips, 4);
  assert.equal(doc.busLines[0].schedule.from, 'Dorf, Post');
  panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(panel.includes('Fahrplan 10:00 min') && panel.includes('4 Fahrten') && /Modell heute [+−-]?\d+ %/.test(panel), panel.slice(panel.indexOf('Fahrplan 10'), panel.indexOf('Fahrplan 10') + 120));
  const beforeDwell = doc.busLines[0].dwell;
  await page.click('.bus-calibrate');
  await h.settle(300);
  doc = await h.doc();
  assert.ok(doc.busLines[0].dwell !== beforeDwell && doc.busLines[0].dwell >= 0 && doc.busLines[0].dwell <= 300, `Haltezeit kalibriert: ${beforeDwell} -> ${doc.busLines[0].dwell}`);
  const busConf2 = (await page.locator('.bus-line details.conf').first().innerText()).replace(/\s+/g, ' ');
  assert.ok(busConf2.includes('Zuversicht'), busConf2);
  console.log('✓ Fahrplan-Abgleich');
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

  // --- Bestehende Haltestellen und Linien aus OSM ------------------------------------------
  assert.ok(transitCalls >= 1, 'beim Setzen von Haltestellen wurde die Ansicht automatisch nachgeladen');
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.31], 16));
  await h.settle(200);
  await page.waitForSelector('#transit-load');
  assert.ok((await page.textContent('#transit-status')).includes('Noch nichts geladen'));
  transitReady = true;
  const before = transitCalls;
  await page.click('#transit-load');
  await page.waitForFunction(() => document.querySelectorAll('.transit-adopt').length === 2, null, { timeout: 10000 });
  assert.ok(transitCalls > before, '„Für Ansicht laden“ holt die Zellen erneut');
  // Die zweite Zelle kann noch laden, wenn die Linien der ersten schon da sind
  await page.waitForFunction(() => (document.querySelector('#transit-status') || {}).textContent.includes('aus OSM geladen'), null, { timeout: 10000 });
  panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(panel.includes('3 Haltestellen und 2 Linien aus OSM geladen'), panel);
  assert.ok(panel.indexOf('Bus 7') < panel.indexOf('Bus 12'), '7 vor 12 (natürliche Sortierung)');
  // Zuversicht je OSM-Linie: Haltepositionen -> hoch, Plattformen -> mittel (Tooltip nennt den Grund)
  assert.equal(await page.locator('.transit-list .conf-dot.conf-high').count(), 1);
  assert.equal(await page.locator('.transit-list .conf-dot.conf-medium').count(), 1);
  assert.ok((await page.locator('.transit-list .conf-dot.conf-medium').getAttribute('title')).includes('Plattformen'));
  // OSM-Haltestelle wird gezeichnet (blauer Ring)
  const stopPx = await page.evaluate(() => window.stadtplaner.map.project([47.05, 8.3125]));
  const ring = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext('2d').getImageData(Math.round((x + 6) * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, stopPx);
  assert.ok(ring[2] > ring[0] + 40 && ring[2] > ring[1] + 40, `blau: rgb(${ring})`);

  // Linie 12 übernehmen: drei neue Haltestellen mit OSM-Kennung, Farbe und Nummer aus OSM
  await page.click('.transit-adopt[data-id="9001"]');
  await h.settle(300);
  doc = await h.doc();
  assert.equal(doc.busLines.length, 1);
  const adopted = doc.busLines[0];
  assert.ok(adopted.name === '12' && adopted.color === '#00aa00' && adopted.osmId === 9001 && adopted.stops.length === 3, JSON.stringify(adopted));
  const osmStops = doc.features.filter((f) => f.kind === 'busstop' && f.osmId);
  assert.equal(osmStops.length, 3);
  assert.deepEqual(osmStops.map((f) => f.name), ['Dorfplatz', 'Schule', 'Kirche']);
  assert.deepEqual(osmStops.map((f) => f.lines), [['12'], ['12'], ['12']]);
  panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(/Bus 12: Dorfplatz – Kirche.*übernommen/.test(panel), panel);
  assert.equal(await page.locator('.transit-adopt').count(), 1, 'nur Linie 7 noch übernehmbar');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.busResults(); return r.length === 1 && r[0].stops === 3 && r[0].proposed && r[0].proposed.path; }, null, { timeout: 10000 });

  // Linie 7 übernehmen: bekannte Haltestellen werden wiederverwendet, Nummer ergänzt
  await page.click('.transit-adopt[data-id="9002"]');
  await h.settle(300);
  doc = await h.doc();
  assert.equal(doc.busLines.length, 2);
  assert.equal(doc.features.filter((f) => f.kind === 'busstop' && f.osmId).length, 3, 'keine Doppelten');
  assert.deepEqual(doc.features.find((f) => f.osmId === 502).lines, ['12', '7']);
  assert.equal(await page.locator('.transit-adopt').count(), 0);

  // Beim Setzen von Haltestellen hängt ein Klick auf eine OSM-Haltestelle sie an (hier: bereits übernommene Haltestelle wiederverwenden)
  await page.click('#bus-add');
  await h.settle(200);
  const sch = await at([47.05, 8.3125]);
  await page.mouse.click(sch.x, sch.y);
  await h.settle(300);
  doc = await h.doc();
  const line3 = doc.busLines[2];
  assert.equal(line3.stops.length, 1);
  assert.equal(doc.features.find((f) => f.id === line3.stops[0]).osmId, 503, 'übernommene Haltestelle angehängt, nicht neu gesetzt');
  assert.equal(doc.features.filter((f) => f.kind === 'busstop').length, 6, 'keine neue Haltestelle');
  await page.keyboard.press('Escape');
  console.log('✓ ÖV aus OSM');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST bus OK');
})().catch((e) => { console.error('BROWSER-TEST bus FAILED:', e); process.exit(1); });
