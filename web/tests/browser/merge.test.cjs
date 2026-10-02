// OSM übernehmen (Hervorhebung, keine Doppel, Rückbau per Shift und Kontextmenü),
// Flächen vereinigen und Strassen verbinden über Mehrfachauswahl und Kontextmenü.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  await page.route(/\/api\/roads\?/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 4242, tags: { highway: 'residential', name: 'Dorfstrasse', maxspeed: '50' }, geometry: [[47.05, 8.3], [47.05, 8.303], [47.05, 8.306]] },
      { id: 4243, tags: { highway: 'service', name: 'Hofweg' }, geometry: [[47.048, 8.3], [47.048, 8.306]] },
    ]),
  }));
  await page.evaluate(() => window.stadtplaner.map.setView([47.049, 8.303], 17));
  await page.waitForFunction(() => window.stadtplaner.osm.ways.size === 2, null, { timeout: 15000 });
  const box = await h.mapBox();
  const at = async (ll) => {
    const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll);
    return { x: box.x + p.x, y: box.y + p.y };
  };
  const status = async () => (await page.textContent('#status-hint')).replace(/\s+/g, ' ');

  // --- OSM übernehmen: Hervorhebung, Auswahl, keine Doppel, Rückbau -------------------
  await page.keyboard.press('o');
  await page.waitForSelector('#adopt-status');
  const dorf = await at([47.05, 8.3015]);
  await page.mouse.move(dorf.x, dorf.y);
  await h.settle(150);
  assert.ok(await page.evaluate(() => window.stadtplaner.tools.osmHover && window.stadtplaner.tools.osmHover.way.id === 4242), 'OSM-Strasse unter dem Zeiger');
  assert.ok((await status()).includes('Dorfstrasse'), await status());
  await page.mouse.click(dorf.x, dorf.y);
  await h.settle(200);
  let doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.equal(doc.features[0].osmId, 4242);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.selection && window.stadtplaner.tools.selection.featureId), doc.features[0].id, 'übernommene Strasse ist ausgewählt');
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.tool), 'adopt', 'Werkzeug bleibt aktiv');
  // Nochmals klicken: keine zweite Kopie
  await page.mouse.click(dorf.x, dorf.y);
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 1, 'kein Doppel');
  // Shift+Klick auf den Hofweg: Rückbau
  const hof = await at([47.048, 8.303]);
  await page.keyboard.down('Shift');
  await page.mouse.click(hof.x, hof.y);
  await page.keyboard.up('Shift');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 2);
  assert.equal(doc.features[1].status, 'remove');
  assert.equal(doc.features[1].osmId, 4243);
  // Option „Rückbau“ wirkt auch auf schon übernommene Strassen (Dorfstrasse)
  await page.selectOption('#adopt-status', 'remove');
  await page.mouse.click(dorf.x, dorf.y);
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 2);
  assert.equal(doc.features[0].status, 'remove', 'bestehende Kopie als Rückbau markiert');
  console.log('✓ OSM übernehmen und entfernen');

  // --- Kontextmenü auf OSM-Strasse im Auswahl-Werkzeug ---------------------------------
  await page.evaluate(() => window.stadtplaner.store.commit('leeren', (d) => { d.features = []; }));
  await page.keyboard.press('v');
  await page.check('#set-show-osm');
  await h.settle(200);
  await page.mouse.click(hof.x, hof.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  const menu = (await page.textContent('#context-menu')).replace(/\s+/g, ' ');
  assert.ok(menu.includes('Hofweg') && menu.includes('OSM-Strasse übernehmen') && menu.includes('Rückbau'), menu);
  await page.click('#context-menu button:has-text("als Rückbau")');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.equal(doc.features[0].status, 'remove');
  console.log('✓ Kontextmenü OSM-Strasse');

  // --- Flächen vereinigen ------------------------------------------------------------
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Flächen', (d) => {
      const layerId = d.layers[0].id;
      d.features = [];
      const zone = (id, name, nodes) => ({ id, type: 'zone', layerId, name, kind: 'tempo30', nodes, busAllowed: false, note: '' });
      d.features.push(
        zone('z_a', 'West', [[47.046, 8.300], [47.046, 8.302], [47.047, 8.302], [47.047, 8.300]]),
        zone('z_b', 'Ost', [[47.046, 8.302], [47.046, 8.304], [47.047, 8.304], [47.047, 8.302]]),
        zone('z_c', 'Fern', [[47.0455, 8.306], [47.0455, 8.307], [47.0458, 8.307], [47.0458, 8.306]]),
      );
    });
    sp.tools.setTool('select');
  });
  await page.evaluate(() => {
    const tools = window.stadtplaner.tools;
    tools.setSelection({ featureId: 'z_a', segIndex: null });
    tools.toggleSelected({ featureId: 'z_b', segIndex: null });
  });
  await h.settle(200);
  await page.waitForSelector('#multi-merge');
  assert.equal((await page.textContent('#multi-merge')).trim(), 'Flächen vereinigen');
  await page.click('#multi-merge');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 2, 'zwei Flächen wurden eine');
  const merged = doc.features.find((f) => f.id === 'z_a');
  assert.ok(merged && merged.name === 'West' && merged.nodes.length === 4, JSON.stringify(merged && merged.nodes));
  assert.ok(!doc.features.some((f) => f.id === 'z_b'));
  // Getrennte Fläche: Meldung, nichts ändert sich
  await page.evaluate(() => {
    const tools = window.stadtplaner.tools;
    tools.setSelection({ featureId: 'z_a', segIndex: null });
    tools.toggleSelected({ featureId: 'z_c', segIndex: null });
  });
  await h.settle(200);
  await page.click('#multi-merge');
  await h.settle(300);
  doc = await h.doc();
  assert.equal(doc.features.length, 2);
  assert.ok((await page.textContent('#toasts')).includes('berühren'), 'Hinweis bei getrennten Flächen');
  await page.keyboard.press('Control+z');
  await h.settle(200);
  assert.equal((await h.doc()).features.length, 3, 'Vereinigen ist rückgängig machbar');
  console.log('✓ Flächen vereinigen');

  // --- Strassen verbinden (Kontextmenü) ---------------------------------------------
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Strassen', (d) => {
      const layerId = d.layers[0].id;
      d.features = [];
      const road = (id, name, nodes, oneway = false) => ({ id, type: 'road', layerId, name, kind: 'main', status: 'new', oneway, maxspeed: null, width: null, section: null, osmId: null, nodes, segments: nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null, access: null })), profile: null, parcels: null, note: '' });
      d.features.push(
        road('r_1', 'Erste', [[47.046, 8.300], [47.046, 8.302]]),
        road('r_2', 'Zweite', [[47.046, 8.304], [47.046, 8.30203]]), // Ende 2 m neben dem Ende von r_1, gegenläufig
      );
    });
    const tools = sp.tools;
    tools.setSelection({ featureId: 'r_1', segIndex: null });
    tools.toggleSelected({ featureId: 'r_2', segIndex: null });
  });
  await h.settle(200);
  const mid = await at([47.046, 8.301]);
  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  assert.ok((await page.textContent('#context-menu')).includes('Strassen verbinden'));
  await page.click('#context-menu button:has-text("Strassen verbinden")');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.equal(doc.features[0].id, 'r_1');
  assert.equal(doc.features[0].nodes.length, 4, 'Lücke als Abschnitt, Richtung angepasst');
  assert.deepEqual(doc.features[0].nodes[3], [47.046, 8.304]);
  assert.equal(doc.features[0].segments.length, 3);
  console.log('✓ Strassen verbinden');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('merge.test.cjs OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
