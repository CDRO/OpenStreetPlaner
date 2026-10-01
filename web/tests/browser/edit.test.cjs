// Bedienbarkeit: Messwerkzeug, Mehrfachauswahl (Shift-Klick, Rahmen, gemeinsam verschieben, löschen),
// Kontextmenü, Elementliste mit Filter, grössere Griffe bei Touch.
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
      d.layers.push({ id: 'l_b', name: 'Variante B', color: '#2a9d3f', visible: true });
      const road = (id, name, nodes) => ({ id, type: 'road', layerId, name, kind: 'main', status: 'new', oneway: false, maxspeed: null, width: null, section: null, osmId: null, nodes, segments: nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null, access: null })), profile: null, parcels: null, note: '' });
      d.features.push(
        road('r_nord', 'Nordstrasse', [[47.051, 8.296], [47.051, 8.304]]),
        road('r_sued', 'Südstrasse', [[47.049, 8.296], [47.049, 8.304]]),
        road('r_ost', 'Oststrasse', [[47.048, 8.308], [47.052, 8.308]]),
        { id: 'j_h', type: 'junction', layerId, name: 'Halt Mitte', kind: 'busstop', at: [47.05, 8.3], turns: null, lines: ['12'], osmId: null, note: '' },
      );
    });
    sp.map.setView([47.05, 8.302], 16);
  });
  await h.settle(300);
  const box = await h.mapBox();
  const at = async (ll) => {
    const p = await page.evaluate((x) => window.stadtplaner.map.project(x), ll);
    return { x: box.x + p.x, y: box.y + p.y };
  };
  const status = async () => (await page.textContent('#status-hint')).replace(/\s+/g, ' ');

  // --- Messen ---------------------------------------------------------------------------
  await page.keyboard.press('m');
  await h.settle(100);
  const m1 = await at([47.05, 8.298]);
  const m2 = await at([47.05, 8.308]);
  const m3 = await at([47.045, 8.308]);
  await page.mouse.click(m1.x, m1.y);
  await h.settle(100);
  await page.mouse.click(m2.x, m2.y);
  await h.settle(150);
  let st = await status();
  assert.ok(/Länge (75[0-9]|76[0-9]) m/.test(st), `0.01° Länge bei 47° ≈ 759 m: ${st}`);
  assert.ok(!st.includes('Fläche'), 'zwei Punkte: keine Fläche');
  await page.mouse.click(m3.x, m3.y);
  await h.settle(150);
  st = await status();
  assert.ok(/Länge 1\.3[0-9] km/.test(st) && /Fläche (20|21)\.[0-9]+ ha/.test(st), `Dreieck 759 m × 556 m / 2 ≈ 21 ha: ${st}`);
  await page.keyboard.press('Enter');
  await h.settle(100);
  st = await status();
  assert.ok(st.includes('Esc löscht die Messung'), st);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.measure.done), true);
  await page.keyboard.press('Escape');
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.measure), null);
  assert.equal((await h.doc()).features.length, 4, 'Messen ändert den Entwurf nicht');
  console.log('✓ Messen');

  // --- Mehrfachauswahl: Shift-Klick, Eigenschaften, Ebene wechseln ------------------------
  await page.keyboard.press('v');
  const nord = await at([47.051, 8.3]);
  const sued = await at([47.049, 8.3]);
  await page.mouse.click(nord.x, nord.y);
  await h.settle(150);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.selection.featureId), 'r_nord');
  await page.keyboard.down('Shift');
  await page.mouse.click(sued.x, sued.y);
  await page.keyboard.up('Shift');
  await h.settle(200);
  let ids = await page.evaluate(() => window.stadtplaner.tools.selectedIds());
  assert.deepEqual(ids.sort(), ['r_nord', 'r_sued']);
  let props = (await page.textContent('#properties')).replace(/\s+/g, ' ');
  assert.ok(props.includes('2 Elemente') && props.includes('2 Strassen'), props);
  await page.selectOption('#multi-layer', 'l_b');
  await h.settle(200);
  let doc = await h.doc();
  assert.ok(doc.features.filter((f) => f.layerId === 'l_b').map((f) => f.id).sort().join(',') === 'r_nord,r_sued', 'beide auf Variante B');
  await page.selectOption('#multi-status', 'remove');
  await h.settle(200);
  doc = await h.doc();
  assert.ok(doc.features.find((f) => f.id === 'r_nord').status === 'remove' && doc.features.find((f) => f.id === 'r_sued').status === 'remove');
  // Shift-Klick auf ein ausgewähltes Element entfernt es aus der Auswahl
  await page.keyboard.down('Shift');
  await page.mouse.click(sued.x, sued.y);
  await page.keyboard.up('Shift');
  await h.settle(150);
  ids = await page.evaluate(() => window.stadtplaner.tools.selectedIds());
  assert.deepEqual(ids, ['r_nord'], `Auswahl nach Shift-Klick: ${JSON.stringify(ids)} / ${JSON.stringify(await page.evaluate(() => [window.stadtplaner.tools.selection, [...window.stadtplaner.tools.multi]]))}`);
  console.log('✓ Mehrfachauswahl per Shift-Klick');

  // --- Rahmen ziehen mit Shift, gemeinsam verschieben, löschen ---------------------------
  await page.keyboard.press('Escape');
  await h.settle(100);
  const a = await at([47.0525, 8.294]);
  const b = await at([47.0475, 8.3055]);
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await h.settle(200);
  ids = await page.evaluate(() => window.stadtplaner.tools.selectedIds());
  assert.deepEqual(ids.sort(), ['j_h', 'r_nord', 'r_sued'], `Rahmen: ${ids}`);
  const before = (await h.doc()).features.find((f) => f.id === 'j_h').at;
  const grab = await at([47.051, 8.298]); // auf der Nordstrasse, abseits von Griffen
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 30, { steps: 6 });
  await page.mouse.move(grab.x + 80, grab.y + 60, { steps: 6 });
  await page.mouse.up();
  await h.settle(300);
  doc = await h.doc();
  const after = doc.features.find((f) => f.id === 'j_h').at;
  assert.ok(after[0] < before[0] && after[1] > before[1], `Punkt mitverschoben: ${before} -> ${after}`);
  const n0 = doc.features.find((f) => f.id === 'r_nord').nodes;
  const s0 = doc.features.find((f) => f.id === 'r_sued').nodes;
  assert.ok(Math.abs((n0[0][1] - 8.296) - (s0[0][1] - 8.296)) < 1e-5, 'beide Strassen um denselben Versatz');
  assert.deepEqual(doc.features.find((f) => f.id === 'r_ost').nodes[0], [47.048, 8.308], 'nicht ausgewählt bleibt');
  await page.keyboard.press('Delete');
  await h.settle(200);
  doc = await h.doc();
  assert.deepEqual(doc.features.map((f) => f.id), ['r_ost'], 'Auswahl gelöscht');
  await page.keyboard.press('Control+z');
  await h.settle(200);
  assert.equal((await h.doc()).features.length, 4, 'Rückgängig stellt alle wieder her');
  console.log('✓ Rahmen, Verschieben, Löschen');

  // --- Kontextmenü ------------------------------------------------------------------------
  await page.keyboard.press('Escape');
  const ost = await at([47.05, 8.308]);
  await page.mouse.click(ost.x, ost.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  let menu = (await page.textContent('#context-menu')).replace(/\s+/g, ' ');
  assert.ok(menu.includes('Oststrasse') && menu.includes('Ebene') && menu.includes('Rückbau') && menu.includes('Brücke') && menu.includes('Löschen'), menu);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.selection.featureId), 'r_ost', 'Rechtsklick wählt aus');
  await page.click('#context-menu button:has-text("Brücke")');
  await h.settle(200);
  assert.ok(await page.locator('#context-menu').isHidden());
  doc = await h.doc();
  assert.equal(doc.features.find((f) => f.id === 'r_ost').segments[0].level, 'bridge');
  await page.mouse.click(ost.x, ost.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  await page.click('#context-menu button:has-text("Variante B")');
  await h.settle(200);
  assert.equal((await h.doc()).features.find((f) => f.id === 'r_ost').layerId, 'l_b');
  await page.mouse.click(ost.x, ost.y, { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  await page.keyboard.press('Escape');
  await h.settle(100);
  assert.ok(await page.locator('#context-menu').isHidden(), 'Esc schliesst das Menü');
  console.log('✓ Kontextmenü');

  // --- Elementliste mit Filter -------------------------------------------------------------
  await page.click('#elements-box summary');
  await h.settle(100);
  assert.equal(await page.locator('#element-list li').count(), 4);
  await page.fill('#element-filter', 'süd');
  await h.settle(150);
  assert.equal(await page.locator('#element-list .el-row').count(), 1);
  assert.ok((await page.textContent('#elements-count')).includes('1/4'));
  await page.evaluate(() => window.stadtplaner.map.setView([47.1, 8.4], 15));
  await h.settle(200);
  await page.click('#element-list .el-row');
  await h.settle(500);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.selection.featureId), 'r_sued');
  const center = await page.evaluate(() => window.stadtplaner.map.getCenter());
  assert.ok(Math.abs(center[0] - 47.049) < 0.002 && Math.abs(center[1] - 8.3) < 0.004, `hingezoomt: ${center}`);
  await page.fill('#element-filter', 'Variante B');
  await h.settle(150);
  assert.equal(await page.locator('#element-list .el-row').count(), 3, 'Filter nach Ebene: Nord, Süd (per Auswahl) und Ost (per Menü) auf Variante B');
  await page.fill('#element-filter', '');
  console.log('✓ Elementliste');

  // --- Touch: grössere Griffe, Langdruck öffnet das Kontextmenü ---------------------------
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.stadtplaner.map.setView([47.05, 8.302], 16));
  await h.settle(300);
  const ostTouch = await at([47.05, 8.308]);
  const touchAt = await at([47.0525, 8.3]);
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true, button: 0 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true, button: 0 }));
  }, { x: touchAt.x - box.x, y: touchAt.y - box.y });
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.tools.handleTol()), 16, 'Finger: grössere Griff-Toleranz');
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 8, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true, button: 0 }));
  }, { x: ostTouch.x - box.x, y: ostTouch.y - box.y });
  await page.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
  assert.ok((await page.textContent('#context-menu')).includes('Oststrasse'), 'Langdruck öffnet das Kontextmenü');
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.smap-canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 8, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true, button: 0 }));
  }, { x: ostTouch.x - box.x, y: ostTouch.y - box.y });
  await page.keyboard.press('Escape');
  console.log('✓ Touch');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST edit OK');
})().catch((e) => { console.error('BROWSER-TEST edit FAILED:', e); process.exit(1); });
