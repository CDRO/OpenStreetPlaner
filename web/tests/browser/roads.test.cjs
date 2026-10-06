// Autobahn/Autostrasse mit getrennten Fahrbahnen, Querschnitt-Editor mit Bändern,
// Anschluss und Abbiegeregeln an Kreuzungen, Wirkung im Routen-Rechner.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.3], 17));
  await h.settle(300);
  const box = await h.mapBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // --- Autobahn zeichnen: Typ im Dropdown, Standardtempo 120, Mittelstreifen ------------
  await page.selectOption('#default-kind', 'motorway');
  await page.keyboard.press('s');
  for (const p of [at(0.1, 0.5), at(0.5, 0.5), at(0.9, 0.5)]) { await page.mouse.click(p.x, p.y); await h.settle(80); }
  await page.keyboard.press('Enter');
  await h.settle(300);
  let doc = await h.doc();
  assert.equal(doc.features[0].kind, 'motorway');
  const info = await page.evaluate((id) => {
    const road = window.stadtplaner.store.doc.features.find((f) => f.id === id);
    const canvas = document.querySelector('.smap-canvas');
    return { canvas: !!canvas, w: canvas.width, h: canvas.height, road: !!road };
  }, doc.features[0].id);
  assert.ok(info.canvas && info.road);
  // Mittelstreifen sichtbar: in der Mitte der Fahrbahn liegt die Mittelstreifen-Farbe (grünlich-grau), nicht die Ebenenfarbe
  const mid = at(0.5, 0.5);
  const pixel = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const r = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / r.width;
    const d = ctx.getImageData(Math.round((x - r.left) * dpr), Math.round((y - r.top) * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, mid);
  assert.ok(pixel[1] >= pixel[0] && pixel[1] >= pixel[2], `Mittelstreifen (grünlich) in der Achse: rgb(${pixel})`);
  await page.keyboard.press('v');
  await page.mouse.click(at(0.3, 0.5).x, at(0.3, 0.5).y);
  await page.waitForSelector('#prop-kind');
  assert.equal(await page.inputValue('#prop-kind'), 'motorway');
  assert.ok((await page.textContent('.speed.std')).includes('120'), 'Standardtempo 120');
  assert.ok((await page.textContent('#properties')).includes('keine Fussgänger und Velos'));
  console.log('✓ Autobahn');

  // --- Querschnitt: festlegen, ändern, Bänder ab Zoom 17 ---------------------------------
  await page.selectOption('#prop-kind', 'main');
  await h.settle(200);
  await page.click('#properties details summary:has-text("Querschnitt")');
  await page.click('#sec-create');
  await page.waitForSelector('#sec-remove');
  doc = await h.doc();
  assert.deepEqual([doc.features[0].section.lanes, doc.features[0].section.laneWidth], [2, 3.5]);
  assert.ok(await page.locator('#prop-width').isDisabled(), 'Breite folgt dem Querschnitt');
  assert.equal(await page.inputValue('#prop-width'), '7');
  await page.check('.sec-flag[data-key="walkLeft"]');
  await h.settle(150);
  await page.check('.sec-flag[data-key="walkRight"]');
  await h.settle(150);
  await page.fill('.sec-num[data-key="bikeWidth"]', '1.75');
  await page.press('.sec-num[data-key="bikeWidth"]', 'Enter');
  await h.settle(150);
  await page.check('.sec-flag[data-key="bikeRight"]');
  await h.settle(150);
  await page.fill('.sec-num[data-key="lanes"]', '3');
  await page.press('.sec-num[data-key="lanes"]', 'Enter');
  await h.settle(200);
  doc = await h.doc();
  const sec = doc.features[0].section;
  assert.deepEqual([sec.lanes, sec.walkLeft, sec.walkRight, sec.bikeRight, sec.bikeWidth], [3, true, true, true, 1.75]);
  assert.equal(await page.inputValue('#prop-width'), String(3 * 3.5 + 2 * 2 + 1.75));
  assert.ok((await page.textContent('#properties')).includes('Trottoir beidseitig'));
  // Band-Farbe am Rand: Trottoir (hellgrau) links der Achse bei Zoom 18
  await page.evaluate(() => window.stadtplaner.map.setView(window.stadtplaner.store.doc.features[0].nodes[1], 18));
  await h.settle(400);
  const box2 = await h.mapBox();
  const centre = { x: box2.x + box2.width / 2, y: box2.y + box2.height / 2 };
  const widthPx = await page.evaluate(() => (3 * 3.5 + 4 + 1.75) / window.stadtplaner.map.metersPerPixel());
  const edge = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const d = canvas.getContext('2d').getImageData(Math.round((x - r.left) * dpr), Math.round((y - r.top) * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, { x: centre.x, y: centre.y - widthPx / 2 + 2 });
  assert.ok(Math.abs(edge[0] - edge[1]) < 12 && Math.abs(edge[1] - edge[2]) < 12 && edge[0] > 150, `Trottoir-Band grau am oberen Rand: rgb(${edge})`);
  await page.click('#sec-remove');
  await h.settle(200);
  assert.equal((await h.doc()).features[0].section, null);
  assert.ok(await page.locator('#prop-width').isEnabled());
  console.log('✓ Querschnitt');

  // --- Kreuzung: Abbiegeregeln und Anschluss ----------------------------------------------
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.3], 17));
  await h.settle(300);
  await page.keyboard.press('k');
  await page.mouse.click(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await h.settle(300);
  doc = await h.doc();
  const junction = doc.features.find((f) => f.type === 'junction');
  assert.ok(junction && junction.turns === null, 'Standard ohne eigene Regeln');
  await page.keyboard.press('v');
  await page.evaluate((id) => window.stadtplaner.tools.setSelection({ featureId: id }), junction.id);
  await page.waitForSelector('.turn[data-turn="left"]');
  assert.ok(await page.isChecked('.turn[data-turn="left"]') && !(await page.isChecked('.turn[data-turn="uturn"]')));
  await page.uncheck('.turn[data-turn="left"]');
  await h.settle(200);
  doc = await h.doc();
  assert.deepEqual(doc.features.find((f) => f.type === 'junction').turns, { left: false, right: true, straight: true, uturn: false });
  await page.waitForSelector('#turns-reset');
  await page.selectOption('#prop-jkind', 'interchange');
  await h.settle(200);
  assert.ok((await page.textContent('#properties')).includes('Kreuzungsfrei'));
  await page.click('#turns-reset');
  await h.settle(200);
  assert.equal((await h.doc()).features.find((f) => f.type === 'junction').turns, null);
  await page.selectOption('#prop-jkind', 'crossing');
  await h.settle(200);
  assert.equal(await page.locator('.turn').count(), 0, 'Fussgängerstreifen ohne Abbiegeregeln');
  console.log('✓ Abbiegeregeln');

  // --- Routen-Rechner: Linksabbiegeverbot zwingt zum Umweg -----------------------------------
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    const doc = sp.store.doc;
    const layerId = doc.layers[0].id;
    sp.store.commit('Testnetz', (d) => {
      d.features = [];
      const road = (nodes) => ({ id: `r_${Math.random().toString(36).slice(2, 8)}`, type: 'road', layerId, name: '', kind: 'main', status: 'new', oneway: false, maxspeed: 50, width: null, section: null, osmId: null, nodes, segments: nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null })), profile: null, note: '' });
      d.features.push(road([[47.05, 8.3], [47.05, 8.305], [47.05, 8.31]]));
      d.features.push(road([[47.054, 8.305], [47.05, 8.305], [47.046, 8.305]]));
      d.features.push(road([[47.05, 8.31], [47.054, 8.31], [47.054, 8.305]]));
      d.route = { from: [47.05, 8.3], to: [47.054, 8.305] };
    });
  });
  await page.waitForFunction(() => { const r = window.stadtplaner.routes(); return r && r.proposed && r.proposed.path; });
  const before = await page.evaluate(() => window.stadtplaner.routes().proposed.dist);
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Verbot', (d) => {
      d.features.push({ id: 'j_ban', type: 'junction', layerId: d.layers[0].id, name: '', kind: 'plain', at: [47.05, 8.305], turns: { left: false, right: true, straight: true, uturn: false }, note: '' });
    });
  });
  await page.waitForFunction((b) => { const r = window.stadtplaner.routes(); return r && r.proposed && r.proposed.path && r.proposed.dist > b * 1.5; }, before);
  console.log('✓ Abbiegeverbot im Routen-Rechner');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST roads OK');
})().catch((e) => { console.error('BROWSER-TEST roads FAILED:', e); process.exit(1); });
