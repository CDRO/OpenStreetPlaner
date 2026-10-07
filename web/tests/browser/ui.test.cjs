// Oberfläche v3: Einstieg, Reiter mit Symbolen, Einstellungen- und Hilfe-Panel, Export-Menü,
// Kartenleiste, Mobil (Suche, Menü, Bottom-Sheet).
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // --- Einstieg beim ersten Besuch -----------------------------------------------------
  const first = await openPage(browser, BASE, errors, { intro: true });
  await first.page.waitForSelector('#intro:not([hidden])');
  assert.equal(await first.page.locator('#intro .intro-steps li').count(), 3, 'drei Schritte');
  await first.page.click('#intro-go');
  assert.ok(await first.page.locator('#intro').isHidden(), 'weggeklickt');
  assert.equal(await first.page.evaluate(() => localStorage.getItem('stadtplaner.intro')), '1', 'gemerkt');
  await first.page.reload({ waitUntil: 'load' });
  await first.page.waitForSelector('.smap-canvas');
  await first.page.waitForTimeout(300);
  assert.ok(await first.page.locator('#intro').isHidden(), 'nach Neuladen nicht mehr');
  await first.page.click('#btn-help');
  await first.page.click('#help-intro');
  await first.page.waitForSelector('#intro:not([hidden])');
  await first.page.click('#intro-help');
  assert.ok(await first.page.locator('#intro').isHidden());
  assert.ok(!(await first.page.locator('#panel-help').isHidden()), 'Hilfe aus dem Einstieg geöffnet');
  await first.context.close();
  console.log('✓ Einstieg');

  // --- Desktop: Reiter, Panels, Export-Menü, Kartenleiste -------------------------------------
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  assert.ok(await page.locator('#intro').isHidden(), 'Tests starten ohne Einstieg');
  assert.equal(await page.locator('.tabs button svg').count(), 7, 'jeder Reiter hat ein Symbol');
  assert.ok(await page.locator('.tabs button[data-tab="draw"] .tab-label').isVisible(), 'aktiver Reiter zeigt sein Label');
  assert.ok(await page.locator('.tabs button[data-tab="layers"] .tab-label').isHidden(), 'inaktive Reiter nur Symbol');
  assert.equal(await page.locator('#tool-buttons .tool svg').count(), 9, 'Werkzeuge mit Symbol');
  assert.equal(await page.locator('#tab-draw #map-settings').count(), 0, 'Karten-Einstellungen nicht mehr im Zeichnen-Reiter');

  // Einstellungen-Panel: öffnen, Esc schliesst, Klick daneben schliesst
  await page.click('#btn-settings');
  await page.waitForSelector('#panel-settings:not([hidden])');
  assert.ok(await page.locator('#set-basemap').isVisible());
  assert.ok(await page.locator('#set-theme').isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#panel-settings').isHidden(), 'Esc schliesst');
  await page.keyboard.press('?');
  await page.waitForSelector('#panel-help:not([hidden])');
  assert.ok((await page.locator('#help-keys .shortcuts tr').count()) >= 18, 'Tastenkürzel-Tabelle');
  await page.mouse.click(700, 500);
  await h.settle(150);
  assert.ok(await page.locator('#panel-help').isHidden(), 'Klick daneben schliesst');
  console.log('✓ Einstellungen und Hilfe');

  // Erklärungen hinter Info-Knöpfen
  await page.click('.tabs button[data-tab="route"]');
  const info = page.locator('#route-panel .info-toggle').first();
  const help = page.locator('#route-panel .help-text').first();
  assert.ok(await help.isHidden(), 'Erklärung zu Beginn zu');
  await info.click();
  assert.ok(await help.isVisible(), 'Erklärung aufgeklappt');
  await info.click();
  assert.ok(await help.isHidden());
  console.log('✓ Info-Knöpfe');

  // Export-Menü im Entwürfe-Reiter
  await page.click('.tabs button[data-tab="drafts"]');
  await page.click('#d-export');
  await page.waitForSelector('#context-menu:not([hidden])');
  assert.ok(await page.locator('#d-export-json').isVisible());
  assert.ok(await page.locator('#d-backup').isDisabled(), 'Sicherung erst nach dem Speichern');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#d-export-json')]);
  assert.ok(dl.suggestedFilename().endsWith('.stadtplaner.json'));
  assert.ok(await page.locator('#context-menu').isHidden(), 'Menü nach Auswahl zu');
  console.log('✓ Export-Menü');

  // Kartenleiste: Grundkarte, Legende, Vollbild-Knopf
  await page.click('#btn-basemap');
  await page.waitForSelector('#panel-basemap:not([hidden])');
  assert.ok((await page.locator('#basemap-body input[name="bm-base"]').count()) >= 1);
  await page.click('#btn-legend');
  await page.waitForSelector('#panel-legend:not([hidden])');
  assert.ok(await page.locator('#panel-basemap').isHidden(), 'nur ein Panel offen');
  assert.ok((await page.locator('#legend-body .legend li').count()) >= 8);
  assert.ok(await page.locator('#btn-fullscreen').isVisible());
  await page.keyboard.press('Escape');
  // Dunkelmodus: Zoom-Knöpfe lesbar (Text hebt sich vom Hintergrund ab)
  await page.emulateMedia({ colorScheme: 'dark' });
  await h.settle(200);
  const zoom = await page.evaluate(() => { const b = document.querySelector('.smap-zoom button'); const cs = getComputedStyle(b); return { color: cs.color, bg: cs.backgroundColor }; });
  assert.notEqual(zoom.color, zoom.bg, `Zoom im Dunkelmodus: ${JSON.stringify(zoom)}`);
  await page.emulateMedia({ colorScheme: 'light' });
  console.log('✓ Kartenleiste');

  // Werkzeugraster bleibt beim Scrollen oben
  await page.click('.tabs button[data-tab="draw"]');
  const box = await h.mapBox();
  await page.keyboard.press('s');
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.keyboard.press('Enter');
  await h.settle(200);
  await page.keyboard.press('v');
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await h.settle(300);
  await page.evaluate(() => { document.querySelector('#tab-draw').scrollTop = 600; });
  await h.settle(200);
  const toolsTop = await page.locator('#tool-buttons').boundingBox();
  const tabTop = await page.locator('#tab-draw').boundingBox();
  assert.ok(Math.abs(toolsTop.y - tabTop.y) < 2, `Werkzeuge oben (${toolsTop.y} vs ${tabTop.y})`);
  await page.locator('#tool-buttons .tool[data-tool="road"]').click();
  assert.ok((await page.locator('.tool.active').textContent()).includes('Strasse'));
  console.log('✓ Werkzeuge bleiben sichtbar');

  // --- Mobil: Suche hinter der Lupe, Menü, Bottom-Sheet ------------------------------------------
  const mobile = await openPage(browser, BASE, errors, { width: 390, height: 844 });
  const mp = mobile.page;
  assert.ok(await mp.locator('#btn-search').isVisible(), 'Lupe');
  assert.ok(await mp.locator('#btn-more').isVisible(), 'Mehr-Menü');
  assert.ok(await mp.locator('#btn-undo').isHidden(), 'Rückgängig im Menü');
  const topbar = await mp.locator('.topbar').boundingBox();
  const share = await mp.locator('#btn-share').boundingBox();
  assert.ok(share.x + share.width <= topbar.x + topbar.width + 1, 'Teilen passt in die Kopfzeile');
  await mp.click('#btn-search');
  assert.ok(await mp.locator('#search-input').isVisible(), 'Suchzeile offen');
  await mp.click('#search-close');
  assert.ok(await mp.locator('#search-input').isHidden());
  await mp.click('#btn-more');
  await mp.waitForSelector('#context-menu:not([hidden])');
  assert.ok((await mp.textContent('#context-menu')).includes('Einstellungen'));
  await mp.keyboard.press('Escape');
  // Sheet: eingeklappt -> Tipp auf Griff -> halb -> Tipp -> voll
  assert.ok(await mp.evaluate(() => document.body.classList.contains('sidebar-hidden')), 'startet eingeklappt');
  await mp.click('#sheet-handle');
  await mp.waitForTimeout(300);
  assert.ok(!(await mp.evaluate(() => document.body.classList.contains('sidebar-hidden'))), 'halb offen');
  await mp.click('#sheet-handle');
  await mp.waitForTimeout(300);
  assert.ok(await mp.evaluate(() => document.body.classList.contains('sheet-full')), 'voll');
  const sheet = await mp.locator('#sidebar').boundingBox();
  assert.ok(sheet.height > 844 * 0.8, `Sheet voll: ${sheet.height}`);
  await mp.click('#sheet-handle');
  await mp.waitForTimeout(300);
  assert.ok(!(await mp.evaluate(() => document.body.classList.contains('sheet-full'))), 'wieder halb');
  // Werkzeuge als kompakte Symbolreihe, Eigenschaften eines gewählten Elements direkt darunter
  assert.ok((await mp.locator('#tool-buttons').boundingBox()).height < 100, 'Werkzeugleiste kompakt');
  assert.ok(await mp.locator('#tool-buttons .tool.active .tool-label').isVisible(), 'aktives Werkzeug mit Namen');
  assert.ok(await mp.locator('#tool-buttons .tool[data-tool="road"] .tool-label').isHidden(), 'übrige nur Symbol');
  await mp.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Demo', (d) => {
      const nodes = [[47.05, 8.3], [47.0505, 8.304]];
      d.features.push({ id: 'r_m', type: 'road', layerId: d.layers[0].id, name: 'Teststrasse', kind: 'main', status: 'new', oneway: false, maxspeed: null, width: null, section: null, osmId: null, nodes, segments: [{ level: 'ground', maxspeed: null }], profile: null, note: '' });
    });
    sp.tools.setSelection({ featureId: 'r_m', segIndex: null });
  });
  await mp.waitForTimeout(200);
  const propsBox = await mp.locator('#properties').boundingBox();
  const defaultsBox = await mp.locator('#tab-draw .defaults').boundingBox();
  assert.ok(propsBox.y < defaultsBox.y, 'Eigenschaften vor den Vorgaben');
  // Reiterleiste nach oben ziehen -> ganz oben; Tipp auf einen Reiter wechselt nur den Reiter
  const dragTabs = async (dy) => {
    const tb = await mp.locator('#sidebar .tabs').boundingBox();
    await mp.mouse.move(tb.x + 300, tb.y + 20);
    await mp.mouse.down();
    for (let i = 1; i <= 8; i++) { await mp.mouse.move(tb.x + 300, tb.y + 20 + (dy * i) / 8); await mp.waitForTimeout(15); }
    await mp.mouse.up();
    await mp.waitForTimeout(350);
  };
  await dragTabs(-250);
  assert.ok(await mp.evaluate(() => document.body.classList.contains('sheet-full')), 'an der Reiterleiste nach oben gezogen');
  assert.equal(await mp.evaluate(() => document.querySelector('.tabs button.active').dataset.tab), 'draw', 'Zug wechselt den Reiter nicht');
  await mp.click('.tabs button[data-tab="layers"]');
  await mp.waitForTimeout(200);
  assert.equal(await mp.evaluate(() => document.querySelector('.tabs button.active').dataset.tab), 'layers', 'Tipp wechselt den Reiter');
  assert.ok(await mp.evaluate(() => document.body.classList.contains('sheet-full')), 'Tipp lässt die Höhe');
  await dragTabs(200);
  assert.ok(!(await mp.evaluate(() => document.body.classList.contains('sheet-full'))), 'nach unten gezogen: halb');
  assert.ok(!(await mp.evaluate(() => document.body.classList.contains('sidebar-hidden'))));
  await dragTabs(300);
  assert.ok(await mp.evaluate(() => document.body.classList.contains('sidebar-hidden')), 'weiter nach unten: eingeklappt');
  await mp.click('.tabs button[data-tab="draw"]');
  await mp.waitForTimeout(300);
  assert.ok(!(await mp.evaluate(() => document.body.classList.contains('sidebar-hidden'))), 'Tipp auf Reiter klappt auf');
  assert.equal(await mp.evaluate(() => document.querySelector('.tabs button.active').dataset.tab), 'draw');
  await mobile.context.close();
  console.log('✓ Mobil');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('Browser-Tests ui OK');
})().catch((e) => { console.error('BROWSER-TEST ui FAILED:', e); process.exit(1); });
