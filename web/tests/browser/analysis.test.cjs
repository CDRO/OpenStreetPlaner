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
  const doc = await h.doc();
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

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST analysis OK');
})().catch((e) => { console.error('BROWSER-TEST analysis FAILED:', e); process.exit(1); });
