// Fahrt-Animation („Abfahren“: Hauptroute je Verkehrsmittel, Buslinie heute/neu), Gruppen
// (auswählen, zusammen verschieben, Kontextmenü, auflösen) und Fortschrittsanzeige in der Statusleiste.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  // OSM-Netz: Ost-West-Strasse (Tempo 50) und Nord-Süd-Strasse, Kreuz bei (47.05, 8.305)
  await page.route(/\/api\/roads\?/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.05, 8.29], [47.05, 8.305], [47.05, 8.32]] },
      { id: 2, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.06, 8.305], [47.05, 8.305], [47.04, 8.305]] },
    ]),
  }));
  // Gebäude antworten verzögert, damit die Fortschrittsanzeige sichtbar wird
  await page.route(/\/api\/buildings\?/, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 9, tags: { building: 'yes' }, geometry: [[47.0501, 8.3001], [47.0501, 8.3002], [47.0502, 8.3002], [47.0502, 8.3001], [47.0501, 8.3001]] }]) });
  });
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Entwurf', (d) => {
      const layerId = d.layers[0].id;
      const road = (id, name, nodes) => ({ id, type: 'road', layerId, name, kind: 'main', status: 'new', oneway: false, maxspeed: null, width: null, section: null, osmId: null, nodes, segments: nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null, access: null })), profile: null, parcels: null, note: '' });
      d.features.push(
        road('r_nord', 'Nordstrasse', [[47.056, 8.296], [47.056, 8.300]]),
        road('r_sued', 'Südstrasse', [[47.044, 8.296], [47.044, 8.300]]),
        { id: 'j_a', type: 'junction', layerId, name: 'Halt A', kind: 'busstop', at: [47.05, 8.292], turns: null, lines: ['5'], osmId: null, note: '' },
        { id: 'j_b', type: 'junction', layerId, name: 'Halt B', kind: 'busstop', at: [47.05, 8.318], turns: null, lines: ['5'], osmId: null, note: '' },
      );
      d.route = { from: [47.05, 8.29], to: [47.05, 8.32], vehicle: 'car' };
      d.busLines = [{ id: 'b1', name: '5', color: '#e53935', stops: ['j_a', 'j_b'], dwell: 20, osmId: null, schedule: null }];
    });
    sp.map.setView([47.05, 8.305], 15);
  });
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.current && r.current.path && r.current.times; }, null, { timeout: 15000 });
  await page.waitForFunction(() => !window.stadtplaner.osm.pending, null, { timeout: 15000 });
  await page.click('.tabs button[data-tab="route"]');
  await page.waitForSelector('#race-box .race-start');

  // --- Rennen auf der Hauptroute -------------------------------------------------------
  const panelText = async (sel) => (await page.textContent(sel)).replace(/\s+/g, ' ');
  assert.ok((await panelText('#race-box')).includes('Abfahren'));
  await page.click('#race-box .race-start');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.race(); return r && r.status === 'running'; }, null, { timeout: 15000 });
  let race = await page.evaluate(() => { const r = window.stadtplaner.actions.race(); return { status: r.status, speed: r.speed, mode: r.mode, duration: r.duration, runners: r.runners.map((x) => x.id) }; });
  assert.equal(race.runners.length, 8, `vier Verkehrsmittel × heute/neu: ${race.runners.join(', ')}`);
  assert.ok(race.runners.includes('foot:proposed') && race.runners.includes('car:current'));
  assert.ok(race.duration > 1000 && race.duration < 4000, `zu Fuss 2.3 km bei 4.8 km/h ≈ 1700 s: ${race.duration}`);
  assert.equal(race.speed, 30, 'Zeitraffer so, dass das Rennen rund eine Minute dauert');
  assert.equal(race.mode, 'both');
  let text = await panelText('#race-box');
  assert.ok(text.includes('🚗') && text.includes('🚶') && text.includes('Heute') && text.includes('Neu') && text.includes('Pause'), text);
  assert.equal(await page.getAttribute('#race-box .race-speed.active', 'data-speed'), '30');
  // Uhr läuft, Fahrzeuge bewegen sich
  await h.settle(700);
  const scene = await page.evaluate(() => { const s = window.stadtplaner.actions.raceScene(); const r = window.stadtplaner.actions.race(); return { t: r.t, car: s.runners.find((x) => x.id === 'car:current') }; });
  assert.ok(scene.t > 1 && scene.t < race.duration, `Modellzeit läuft im Zeitraffer: ${scene.t}`);
  assert.ok(scene.car.position[1] > 8.29 && scene.car.progress > 0 && !scene.car.finished, JSON.stringify(scene.car));
  assert.ok(scene.car.trail.length >= 2, 'Spur hinter dem Auto');
  // Zeitraffer wechseln, Pause, Zeitleiste
  await page.click('#race-box .race-speed[data-speed="100"]');
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race().speed), 100);
  await page.click('#race-box .race-toggle');
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race().status), 'paused');
  const tPaused = await page.evaluate(() => window.stadtplaner.actions.race().t);
  await h.settle(300);
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race().t), tPaused, 'Pause hält die Uhr an');
  await page.fill('#race-box .race-seek', '600');
  await page.dispatchEvent('#race-box .race-seek', 'input');
  await h.settle(100);
  let snap = await page.evaluate(() => { const s = window.stadtplaner.actions.raceScene(); return s.runners.map((r) => ({ id: r.id, finished: r.finished, rank: r.rank })); });
  assert.ok(snap.find((r) => r.id === 'car:current').finished && snap.find((r) => r.id === 'car:current').rank >= 1, 'Auto ist nach 10 min angekommen');
  assert.ok(!snap.find((r) => r.id === 'foot:current').finished, 'Fussgänger noch unterwegs');
  text = await panelText('#race-box');
  assert.ok(/10:00 \/ /.test(text), `Uhr zeigt die Modellzeit: ${text}`);
  // Zum Ende springen: alle angekommen, Ränge in der Tabelle
  await page.evaluate(() => window.stadtplaner.actions.raceSeek(window.stadtplaner.actions.race().duration));
  await page.click('#race-box .race-toggle');
  await page.waitForFunction(() => window.stadtplaner.actions.race().status === 'done', null, { timeout: 5000 });
  text = await panelText('#race-box');
  assert.ok(text.includes('1. ·') && text.includes('Nochmals'), text);
  // Nur neu: vier Teilnehmer
  await page.selectOption('#race-box .race-mode', 'proposed');
  await page.waitForFunction(() => window.stadtplaner.actions.race().runners.length === 4, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race().mode), 'proposed');
  // Entwurf ändern: Rennen gilt als veraltet, „Neu berechnen“ rechnet neu
  await page.evaluate(() => window.stadtplaner.store.commit('Ändern', (d) => { d.features[0].name = 'Nord neu'; }));
  await h.settle(200);
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race().stale), true);
  assert.ok((await panelText('#race-box')).includes('Neu berechnen'));
  await page.click('#race-box .race-restart');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.race(); return r && !r.stale && r.status === 'running'; }, null, { timeout: 15000 });
  await page.click('#race-box .race-stop');
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.race()), null);
  await page.waitForSelector('#race-box .race-start');
  console.log('✓ Rennen Hauptroute');

  // --- Buslinie abfahren ---------------------------------------------------------------
  await page.waitForFunction(() => window.stadtplaner.actions.busResults().length === 1 && window.stadtplaner.actions.busResults()[0].proposed && window.stadtplaner.actions.busResults()[0].proposed.times, null, { timeout: 15000 });
  await page.click('.bus-race[data-id="b1"]');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.race(); return r && r.kind === 'bus' && r.status === 'running'; }, null, { timeout: 5000 });
  race = await page.evaluate(() => { const r = window.stadtplaner.actions.race(); return { title: r.title, runners: r.runners.map((x) => x.id) }; });
  assert.deepEqual(race.runners, ['bus:current', 'bus:proposed']);
  assert.ok(race.title.includes('Linie 5'));
  text = await panelText('#race-box');
  assert.ok(text.includes('🚌') && text.includes('Linie 5') && !text.includes('Nur heute'), text);
  await page.click('#race-box .race-stop');
  console.log('✓ Rennen Buslinie');

  // --- Gruppen ---------------------------------------------------------------------------
  await page.click('.tabs button[data-tab="draw"]');
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await h.settle(100);
  const box = await h.mapBox();
  const at = async (ll) => {
    const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll);
    return { x: box.x + p.x, y: box.y + p.y };
  };
  const nord = await at([47.056, 8.298]);
  const sued = await at([47.044, 8.298]);
  await page.mouse.click(nord.x, nord.y);
  await h.settle(100);
  await page.keyboard.down('Shift');
  await page.mouse.click(sued.x, sued.y);
  await page.keyboard.up('Shift');
  await h.settle(150);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.multi.size), 2);
  await page.click('#multi-group');
  await h.settle(200);
  let doc = await h.doc();
  const gid = doc.features.find((f) => f.id === 'r_nord').group;
  assert.ok(gid && doc.features.find((f) => f.id === 'r_sued').group === gid, 'beide in derselben Gruppe');
  assert.equal(doc.features.find((f) => f.id === 'j_a').group, null);
  // Auswahl aufheben, dann ein Mitglied anklicken: ganze Gruppe ausgewählt, Eigenschaften des Elements sichtbar
  const empty = await at([47.06, 8.315]);
  await page.mouse.click(empty.x, empty.y);
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.multi.size), 0);
  await page.mouse.click(sued.x, sued.y);
  await h.settle(150);
  let sel = await page.evaluate(() => ({ multi: Array.from(window.stadtplaner.tools.multi), primary: window.stadtplaner.tools.selection.featureId }));
  assert.deepEqual(sel.multi.sort(), ['r_nord', 'r_sued']);
  assert.equal(sel.primary, 'r_sued');
  text = (await page.textContent('#properties')).replace(/\s+/g, ' ');
  assert.ok(text.includes('Südstrasse') && text.includes('Gruppe mit 2 Elementen') && text.includes('Gruppe auflösen'), text);
  assert.ok(await page.locator('#prop-ungroup').isVisible());
  // Ziehen auf dem Mitglied (abseits der Griffe) verschiebt beide
  const before = doc.features.find((f) => f.id === 'r_nord').nodes[0];
  const grab = await at([47.044, 8.297]);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 30, { steps: 6 });
  await page.mouse.up();
  await h.settle(200);
  doc = await h.doc();
  const after = doc.features.find((f) => f.id === 'r_nord').nodes[0];
  assert.ok(after[1] > before[1] + 0.0005 && after[0] < before[0], `Nordstrasse mitverschoben: ${before} -> ${after}`);
  assert.ok(doc.features.find((f) => f.id === 'r_sued').nodes[0][1] > 8.2965);
  // Elementliste zeigt die Gruppe
  await page.click('#elements-box summary');
  await h.settle(100);
  const rows = (await page.textContent('#element-list')).replace(/\s+/g, ' ');
  assert.ok((rows.match(/Gruppe/g) || []).length === 2, rows);
  // Kontextmenü: Gruppe auflösen
  const sued2 = await at(doc.features.find((f) => f.id === 'r_sued').nodes.map((n) => n).reduce((a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
  await page.mouse.click(sued2.x, sued2.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  const menu = (await page.textContent('#context-menu')).replace(/\s+/g, ' ');
  assert.ok(menu.includes('Gruppe auflösen') && !menu.includes('Gruppieren'), menu);
  await page.click('#context-menu button:has-text("Gruppe auflösen")');
  await h.settle(200);
  doc = await h.doc();
  assert.ok(doc.features.every((f) => !f.group));
  sel = await page.evaluate(() => ({ multi: window.stadtplaner.tools.multi.size, primary: window.stadtplaner.tools.selection && window.stadtplaner.tools.selection.featureId }));
  assert.equal(sel.multi, 0);
  assert.equal(sel.primary, 'r_sued');
  // Rückgängig stellt die Gruppe wieder her; Löschen eines Mitglieds löst die Zweiergruppe auf
  await page.keyboard.press('Control+z');
  await h.settle(200);
  doc = await h.doc();
  assert.ok(doc.features.find((f) => f.id === 'r_nord').group, 'Gruppe nach Rückgängig zurück');
  await page.evaluate(() => window.stadtplaner.store.commit('Löschen', (d) => { d.features = d.features.filter((f) => f.id !== 'r_nord'); }));
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('stadtplaner.working') || '{}'));
  assert.ok(saved, 'Arbeitskopie vorhanden');
  console.log('✓ Gruppen');

  // --- Fortschrittsanzeige -----------------------------------------------------------
  await page.click('.tabs button[data-tab="analysis"]');
  await page.waitForSelector('#exp-load');
  await page.click('#exp-load');
  await page.waitForSelector('#status-progress:not([hidden])', { timeout: 5000 });
  let prog = (await page.textContent('#status-progress')).replace(/\s+/g, ' ');
  assert.ok(/Gebäude laden… 0\/\d+/.test(prog), `Fortschritt mit Zellen: ${prog}`);
  assert.ok(!(await page.getAttribute('#status-progress', 'class')).includes('done'));
  await page.waitForFunction(() => /Gebäude geladen/.test(document.getElementById('status-progress').textContent), null, { timeout: 15000 });
  prog = (await page.textContent('#status-progress')).replace(/\s+/g, ' ');
  assert.ok(/1 Gebäude geladen\./.test(prog), prog);
  assert.ok((await page.getAttribute('#status-progress', 'class')).includes('done'));
  await page.waitForFunction(() => document.getElementById('status-progress').hidden, null, { timeout: 8000 });
  console.log('✓ Fortschrittsanzeige');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('race.test.cjs OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
