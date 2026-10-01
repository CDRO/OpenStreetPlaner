// Analyse-Tab: Kostenschätzung mit anpassbaren Einheitskosten, Normen-Check mit Sprung zum Element.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Testnetz', (d) => {
      const layerId = d.layers[0].id;
      const road = (nodes, extra = {}) => ({ id: `r_${Math.random().toString(36).slice(2, 8)}`, type: 'road', layerId, name: '', kind: 'main', status: 'new', oneway: false, maxspeed: 50, width: null, section: null, osmId: null, nodes, segments: nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null })), profile: null, note: '', ...extra });
      d.features.push(road([[47.05, 8.3], [47.05, 8.31]], { name: 'Umfahrung' })); // ~ 758 m
      d.features.push(road([[47.052, 8.3], [47.052, 8.3002], [47.0522, 8.3002]], { name: 'Ecke' })); // enge Kurve
      d.features.push({ id: 'k_small', type: 'roundabout', layerId, name: '', center: [47.05, 8.31], radius: 8, note: '' });
    });
    sp.map.setView([47.05, 8.305], 16);
  });
  await h.settle(300);
  await page.click('.tabs button[data-tab="analysis"]');
  await page.waitForSelector('#analysis-panel .route-table');
  const text = await page.textContent('#analysis-panel');
  assert.ok(text.includes('Kostenschätzung') && text.includes('Total (sichtbare Ebenen)'));
  assert.ok(text.includes('Kurvenradius'), 'enge Kurve gemeldet');
  assert.ok(text.includes('Kreisel') && text.includes('zu klein'), 'kleiner Kreisel gemeldet');
  const total1 = await page.textContent('#analysis-panel tr.total .num');
  assert.ok(/Mio\. CHF/.test(total1), total1);
  // Einheitskosten ändern: Kreisel 1.5 Mio -> 3.5 Mio erhöht das Total um 2 Mio
  await page.click('#analysis-panel details:has(#cost-reset) > summary');
  await page.fill('.cost-input[data-key="roundabout"]', '3500000');
  await page.press('.cost-input[data-key="roundabout"]', 'Enter');
  await h.settle(300);
  let doc = await h.doc();
  assert.equal(doc.costs.roundabout, 3500000);
  const total2 = await page.textContent('#analysis-panel tr.total .num');
  const num = (t) => Number(/([\d.]+) Mio/.exec(t)[1]);
  assert.ok(Math.abs(num(total2) - num(total1) - 2) < 0.15, `${total1} -> ${total2}`);
  assert.ok((await page.textContent('#analysis-panel')).includes('1 geändert'));
  await page.click('#cost-reset');
  await h.settle(300);
  assert.deepEqual((await h.doc()).costs, {});
  // Normen-Check: Klick wählt das Element aus und zoomt hin
  await page.click('.check-list li.warn .check-row');
  await h.settle(500);
  const sel = await page.evaluate(() => window.stadtplaner.tools.selection && window.stadtplaner.tools.selection.featureId);
  assert.ok(sel, 'Element ausgewählt');
  await page.waitForFunction(() => window.stadtplaner.map.getZoom() >= 16.9, null, { timeout: 5000 });
  // Ausgeblendete Ebene: Total 0, keine Hinweise
  await page.evaluate(() => window.stadtplaner.store.commit('aus', (d) => { d.layers[0].visible = false; }));
  await h.settle(300);
  await page.click('.tabs button[data-tab="analysis"]');
  await h.settle(200);
  assert.ok((await page.textContent('#analysis-panel tr.total .num')).startsWith('0 CHF'));
  assert.ok((await page.textContent('#analysis-panel')).includes('Keine Auffälligkeiten'));
  console.log('✓ Analyse: Kosten und Normen-Check');

  // --- Variantenvergleich: zweite Ebene, Vergleich auf Knopfdruck -------------------------
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Variante B', (d) => {
      d.layers.push({ id: 'l_b', name: 'Variante B', color: '#2a9d3f', visible: true });
      d.features.push({ id: 'r_b', type: 'road', layerId: 'l_b', name: 'Kurz', kind: 'secondary', status: 'new', oneway: false, maxspeed: null, width: null, section: null, osmId: null, nodes: [[47.051, 8.3], [47.051, 8.301]], segments: [{ level: 'ground', maxspeed: null, access: null }], profile: null, parcels: null, note: '', phase: null });
    });
  });
  await h.settle(300);
  assert.equal(await page.locator('#analysis-panel .variants').count(), 0, 'erst auf Knopfdruck');
  await page.click('#variants-run');
  await page.waitForSelector('#analysis-panel table.variants');
  const vrows = await page.locator('#analysis-panel table.variants tbody tr').count();
  assert.equal(vrows, 2);
  const vtext = (await page.textContent('#analysis-panel table.variants')).replace(/\s+/g, ' ');
  assert.ok(vtext.includes('Variante B') && /Ebene 1.*Mio\. CHF/.test(vtext), vtext);
  console.log('✓ Variantenvergleich');

  // --- Parkplatzbilanz: Parkfläche neu, OSM-Parkplatz entfällt ------------------------------
  await page.route(/\/api\/parking\?/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: 700, tags: { amenity: 'parking', capacity: '30', name: 'Dorfplatz' }, geometry: [[47.0499, 8.3049], [47.0499, 8.3051], [47.0501, 8.3051], [47.0501, 8.3049], [47.0499, 8.3049]] },
  ]) }));
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Parkfläche', (d) => {
      d.layers[0].visible = true; // Ebene 1 wurde oben für das Kosten-Total ausgeblendet
      d.features.push({ id: 'z_p', type: 'zone', layerId: d.layers[0].id, name: 'Neuer Parkplatz', kind: 'parking', nodes: [[47.053, 8.3], [47.053, 8.30066], [47.05345, 8.30066], [47.05345, 8.3]], busAllowed: false, note: '', phase: null });
    });
  });
  await h.settle(300);
  let ptext = (await page.textContent('#analysis-panel')).replace(/\s+/g, ' ');
  assert.ok(/Parkplatzbilanz.*Neu\s*\+(9[5-9]|100)/.test(ptext), ptext.slice(ptext.indexOf('Bilanz') - 120, ptext.indexOf('Bilanz') + 20));
  await page.click('#parking-load');
  await page.waitForFunction(() => (document.querySelector('#parking-status') || {}).textContent.includes('1 OSM-Parkplätze geladen'), null, { timeout: 10000 });
  ptext = (await page.textContent('#analysis-panel')).replace(/\s+/g, ' ');
  assert.ok(/Entfallen\s*−30/.test(ptext) && ptext.includes('Dorfplatz'), 'Umfahrung berührt den OSM-Parkplatz mit capacity 30');
  console.log('✓ Parkplatzbilanz');

  // --- Etappierung: Etappe anlegen, Element zuordnen, Ansicht „bis Etappe“ -------------------
  await page.click('.tabs button[data-tab="layers"]');
  await page.click('#phase-add');
  await h.settle(200);
  await page.click('#phase-add');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.phases.length, 2);
  await page.fill('.phase-row:nth-of-type(2) .phase-year', '2030');
  await page.press('.phase-row:nth-of-type(2) .phase-year', 'Enter');
  await h.settle(200);
  doc = await h.doc();
  assert.equal(doc.phases[1].year, 2030);
  const e2 = doc.phases[1].id;
  await page.evaluate((id) => window.stadtplaner.actions.setFeaturesPhase(['r_b', 'z_p'], id), e2);
  await h.settle(200);
  doc = await h.doc();
  assert.ok(doc.features.find((f) => f.id === 'r_b').phase === e2 && doc.features.find((f) => f.id === 'z_p').phase === e2);
  await page.selectOption('#phase-view', doc.phases[0].id);
  await h.settle(300);
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.phaseView()), doc.phases[0].id);
  // Analyse: Etappen-Tabelle kumuliert; Parkfläche zählt im Zustand nach Etappe 1 noch nicht in der Ansicht, Bilanz bleibt Gesamtsicht
  await page.click('.tabs button[data-tab="analysis"]');
  await h.settle(300);
  const etext = (await page.textContent('#analysis-panel')).replace(/\s+/g, ' ');
  assert.ok(/Etappierung.*Etappe 1.*0 \(\+0\).*Etappe 2 \(2030\).*2 \(\+2\)/.test(etext), etext.slice(etext.indexOf('Etappierung'), etext.indexOf('Etappierung') + 240));
  // Eigenschaften zeigen die Etappe, Routen-Tab den Hinweis
  await page.click('.tabs button[data-tab="draw"]');
  await page.evaluate(() => window.stadtplaner.tools.setSelection({ featureId: 'r_b', segIndex: 0 }));
  await page.waitForSelector('#prop-phase');
  assert.equal(await page.inputValue('#prop-phase'), e2);
  await page.click('.tabs button[data-tab="route"]');
  await h.settle(200);
  assert.ok((await page.textContent('#route-panel')).includes('Ansicht bis Etappe'));
  await page.evaluate(() => window.stadtplaner.actions.setPhaseView(null));
  console.log('✓ Etappierung');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST analysis OK');
})().catch((e) => { console.error('BROWSER-TEST analysis FAILED:', e); process.exit(1); });
