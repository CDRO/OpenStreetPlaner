// Routenpaare (Setzen per Klick, Tabelle, Summe) und Isochronen (Ursprung, Modi, Statistik, Zeichnung).
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  // OSM-Netz nachbilden: Ost-West-Strasse und Nord-Süd-Strasse mit Kreuz bei (47.05, 8.305)
  await page.route(/\/api\/roads\?/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.05, 8.29], [47.05, 8.305], [47.05, 8.32]] },
      { id: 2, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.06, 8.305], [47.05, 8.305], [47.04, 8.305]] },
    ]),
  }));
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Entwurf', (d) => {
      const layerId = d.layers[0].id;
      // Abkürzung: Diagonale von (47.05,8.29) nach (47.06,8.305)
      d.features.push({ id: 'r_diag', type: 'road', layerId, name: 'Diagonale', kind: 'main', status: 'new', oneway: false, maxspeed: 80, width: null, section: null, osmId: null, nodes: [[47.05, 8.29], [47.06, 8.305]], segments: [{ level: 'ground', maxspeed: null }], profile: null, parcels: null, note: '' });
    });
    sp.map.setView([47.05, 8.305], 15);
  });
  await page.click('.tabs button[data-tab="route"]');
  await page.waitForSelector('#pair-add');
  const box = await h.mapBox();
  const at = async (ll) => {
    const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll);
    return { x: box.x + p.x, y: box.y + p.y };
  };

  // --- Routenpaar per Klick setzen -----------------------------------------------------
  await page.click('#pair-add');
  await h.settle(200);
  let doc = await h.doc();
  assert.equal(doc.routePairs.length, 1);
  assert.ok((await page.textContent('#route-panel')).includes('Start und Ziel auf der Karte anklicken'));
  const a = await at([47.05, 8.29]);
  const b = await at([47.06, 8.305]);
  await page.mouse.click(a.x, a.y);
  await h.settle(150);
  await page.mouse.click(b.x, b.y);
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.pairResults(); return r.length === 1 && r[0].current && r[0].current.path && r[0].proposed && r[0].proposed.path; }, null, { timeout: 10000 });
  doc = await h.doc();
  assert.deepEqual(doc.routePairs[0].from, [47.05, 8.29]);
  assert.ok(doc.route === null, 'Hauptroute bleibt leer');
  const res = await page.evaluate(() => window.stadtplaner.actions.pairResults()[0]);
  assert.ok(res.proposed.time < res.current.time, 'Diagonale ist schneller');
  const panel = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(/Summe über 1 Paar/.test(panel) && panel.includes('−'), panel);
  // Route neu ist gestrichelt: entlang der Diagonale wechseln grüne Striche und weisse Lücken (Halo)
  const samples = await page.evaluate(() => {
    const sp = window.stadtplaner;
    const canvas = document.querySelector('.smap-canvas');
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const ctx = canvas.getContext('2d');
    const out = [];
    for (let i = 0; i <= 40; i++) {
      const f = 0.1 + 0.8 * (i / 40);
      const p = sp.map.project([47.05 + 0.01 * f, 8.29 + 0.015 * f]);
      const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
      out.push([d[0], d[1], d[2]]);
    }
    return out;
  });
  const greens = samples.filter(([r, g, b]) => g > r + 40 && g > b + 40).length;
  const gaps = samples.length - greens; // Lücken zeigen den weissen Halo über der roten Strasse (rosa)
  assert.ok(greens >= 6 && gaps >= 3, `Striche und Lücken: grün ${greens}, Lücken ${gaps}`);
  await page.fill('.pair-name', 'Schule');
  await page.press('.pair-name', 'Enter');
  await h.settle(200);
  assert.equal((await h.doc()).routePairs[0].name, 'Schule');
  // Zuversicht: OSM-Ways mit maxspeed, Entwurf mit Tempo 80, aber Tempolimit-Modell -> mittel mit Gründen
  await page.waitForSelector('#route-panel details.conf');
  const conf = page.locator('#route-panel details.conf').first();
  assert.ok((await conf.innerText()).includes('Zuversicht mittel'), await conf.innerText());
  assert.ok(await conf.locator('.conf-dot').count() === 1 && (await conf.getAttribute('class')).includes('conf-medium'));
  await conf.locator('summary').click();
  const reasons = (await conf.locator('.conf-reasons').innerText()).replace(/\s+/g, ' ');
  assert.ok(reasons.includes('Tempolimit-Modell') && reasons.includes('Ampeln und Vortritt') && !reasons.includes('geschätztem Tempo'), reasons);
  assert.equal(await page.locator('#route-panel .pairs .conf-dot.conf-medium').count(), 1, 'Punkt je Paar');
  // Geometriemodell ohne Höhenprofil: Steigung unbekannt -> bleibt mittel, anderer Grund
  await page.check('#route-model');
  await page.waitForFunction(() => { const r = window.stadtplaner.actions.pairResults(); return r.length === 1 && r[0].proposed && r[0].proposed.quality && r[0].proposed.quality.model === 'geometry'; }, null, { timeout: 10000 });
  await h.settle(200);
  const conf2 = (await page.locator('#route-panel details.conf').first().innerText()).replace(/\s+/g, ' ');
  assert.ok(conf2.includes('Zuversicht mittel'), conf2);
  await page.locator('#route-panel details.conf').first().locator('summary').click();
  const reasons2 = (await page.locator('#route-panel details.conf').first().locator('.conf-reasons').innerText()).replace(/\s+/g, ' ');
  assert.ok(reasons2.includes('kein Höhenprofil') && !reasons2.includes('Tempolimit-Modell'), reasons2);
  await page.uncheck('#route-model');
  await h.settle(300);
  console.log('✓ Routenpaare');

  // --- Isochrone ----------------------------------------------------------------------
  await page.click('#iso-set');
  await h.settle(150);
  const o = await at([47.05, 8.29]);
  await page.mouse.click(o.x, o.y);
  await page.waitForFunction(() => { const i = window.stadtplaner.actions.isochrone(); return i && i.pieces && i.pieces.length > 0; }, null, { timeout: 10000 });
  doc = await h.doc();
  assert.deepEqual(doc.isochrone, { from: [47.05, 8.29], minutes: [5, 10, 15], mode: 'proposed' });
  await page.waitForSelector('#iso-mode');
  await page.selectOption('#iso-minutes', '2,5,10');
  await h.settle(300);
  assert.deepEqual((await h.doc()).isochrone.minutes, [2, 5, 10]);
  let txt = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(/2 min\s*[\d.]+ km/.test(txt), txt);
  await page.selectOption('#iso-mode', 'diff');
  await h.settle(400);
  txt = (await page.textContent('#route-panel')).replace(/\s+/g, ' ');
  assert.ok(txt.includes('Neu erreichbar'), txt);
  const stats = await page.evaluate(() => window.stadtplaner.actions.isochrone().stats);
  assert.ok(stats.gainedKm > 1 && stats.lostKm === 0, JSON.stringify(stats));
  // Zeichnung: grün auf der Diagonalen (nur neu erreichbar)
  const mid = await page.evaluate(() => window.stadtplaner.map.project([47.055, 8.2975]));
  const px = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, mid);
  assert.ok(px[1] > px[0] + 30 && px[1] > px[2] + 30, `grün: rgb(${px})`);
  assert.ok((await page.locator('#route-panel details.conf').last().innerText()).includes('Zuversicht'), 'Zuversicht auch bei der Erreichbarkeit');
  await page.click('#iso-clear');
  await h.settle(200);
  assert.equal((await h.doc()).isochrone, null);
  console.log('✓ Isochronen');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST reach OK');
})().catch((e) => { console.error('BROWSER-TEST reach FAILED:', e); process.exit(1); });
