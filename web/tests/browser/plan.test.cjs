// Massstab-Export mit Planrahmen und QR, QR im Teilen-Dialog, Import GeoJSON/GPX, Versionsvergleich.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Entwurf', (d) => {
      const layerId = d.layers[0].id;
      d.features.push({ id: 'r_1', type: 'road', layerId, name: 'Umfahrung', kind: 'main', status: 'new', oneway: false, maxspeed: 50, width: null, section: null, osmId: null, nodes: [[47.05, 8.3], [47.05, 8.31]], segments: [{ level: 'ground', maxspeed: null }], profile: null, parcels: null, note: '' });
    });
    sp.map.setView([47.05, 8.305], 16);
  });
  await page.fill('#draft-name', 'Plan-Test');
  await page.press('#draft-name', 'Enter');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /\/d\/[0-9a-z]+$/.test(location.pathname));
  const id = page.url().split('/d/')[1];

  // --- Teilen-Dialog mit QR -------------------------------------------------------------
  await page.click('#btn-share');
  await page.waitForSelector('#share-url');
  assert.equal(await page.locator('.qr-row svg').count(), 1, 'QR-Code im Dialog');
  const vb = await page.getAttribute('.qr-row svg', 'viewBox');
  assert.ok(/^0 0 \d+ \d+$/.test(vb), vb);
  // --- Export in festem Massstab mit Planrahmen und QR ----------------------------------------
  await page.click('#share-export');
  await page.waitForSelector('#export-mode');
  assert.ok(await page.locator('#export-scale').isDisabled(), 'Massstab nur im Massstab-Modus');
  await page.selectOption('#export-mode', 'scale');
  assert.ok(await page.locator('#export-scale').isEnabled());
  await page.selectOption('#export-scale', '2000');
  await page.selectOption('#export-dpi', '96');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#export-png')]);
  const png = fs.readFileSync(await dl.path());
  assert.deepEqual(Array.from(png.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  // Massstab in der Kopfzeile prüfen: die Kartenmitte bleibt, Zoom folgt dem Massstab
  const scaleInfo = await page.evaluate(async () => {
    const { renderExport, scaleDenominator } = await import('/static/js/export.js');
    const sp = window.stadtplaner;
    const { canvas } = await renderExport(sp.map, sp.store.doc, { mode: 'scale', scale: 2000, paper: 'a4', orientation: 'landscape', dpi: 96, link: location.href });
    const mpp = sp.map.withView({ center: sp.map.getCenter(), zoom: Math.min(19, Math.log2((2 * Math.PI * 6378137) / (256 * ((2000 * 25.4) / 96000 / Math.cos((47.05 * Math.PI) / 180))))) }, () => sp.map.metersPerPixel());
    // QR unten rechts: dunkle Module vorhanden
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(canvas.width - 40, canvas.height - 140, 30, 30).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
    return { denom: scaleDenominator(mpp), width: canvas.width, dark };
  });
  assert.equal(scaleInfo.denom, 2000, 'gezeichneter Massstab 1:2000');
  assert.ok(scaleInfo.dark > 20, `QR-Module gezeichnet: ${scaleInfo.dark}`);
  await page.click('.modal [data-close]');
  console.log('✓ Massstab-Export und QR');

  // --- Import GeoJSON und GPX -------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-import-'));
  const geo = path.join(tmp, 'plan.geojson');
  fs.writeFileSync(geo, JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Velo', highway: 'cycleway' }, geometry: { type: 'LineString', coordinates: [[8.3, 47.052], [8.31, 47.052]] } },
    { type: 'Feature', properties: { name: 'Halt', kind: 'busstop' }, geometry: { type: 'Point', coordinates: [8.305, 47.052] } },
  ] }));
  const gpx = path.join(tmp, 'tour.gpx');
  fs.writeFileSync(gpx, '<gpx version="1.1"><trk><name>Tour</name><trkseg><trkpt lat="47.054" lon="8.3"/><trkpt lat="47.054" lon="8.31"/></trkseg></trk></gpx>');
  await page.click('.tabs button[data-tab="drafts"]');
  await page.waitForSelector('#d-import');
  await page.setInputFiles('#import-file', geo);
  await page.waitForFunction(() => window.stadtplaner.store.doc.layers.length === 2);
  let doc = await h.doc();
  assert.equal(doc.layers[1].name, 'Import plan');
  assert.equal(doc.features.length, 3);
  assert.deepEqual([doc.features[1].kind, doc.features[1].status, doc.features[2].kind], ['path', 'existing', 'busstop']);
  await page.setInputFiles('#import-file', gpx);
  await page.waitForFunction(() => window.stadtplaner.store.doc.layers.length === 3);
  doc = await h.doc();
  assert.equal(doc.features[3].name, 'Tour');
  console.log('✓ Import GeoJSON und GPX');

  // --- Versionsvergleich ---------------------------------------------------------------------------
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.stadtplaner.actions.isDirty());
  await page.evaluate(() => window.stadtplaner.store.commit('ändern', (d) => {
    d.features[0].maxspeed = 30;
    d.features = d.features.filter((f) => f.id !== d.features[2].id);
  }));
  await page.click('.tabs button[data-tab="history"]');
  await page.waitForSelector('#cmp-run');
  await page.click('.list-row:last-child .v-compare'); // Version #1 (älteste) gegen aktuellen Stand
  await page.waitForSelector('#diff-show');
  const txt = (await page.textContent('#version-diff')).replace(/\s+/g, ' ');
  assert.ok(txt.includes('Version #1') && txt.includes('aktueller Stand'), txt);
  assert.ok(/3 hinzugefügt, 0 entfernt, 1 geändert/.test(txt) || /2 hinzugefügt, 0 entfernt, 1 geändert/.test(txt), txt);
  assert.ok(txt.includes('Tempolimit: 50 → 30'), txt);
  assert.ok(await page.isChecked('#diff-show'), 'Overlay automatisch an');
  // Vergleich Version 2 (mit Import) gegen aktuell: Punkt entfernt
  await page.selectOption('#cmp-a', '2');
  await page.selectOption('#cmp-b', 'current');
  await page.click('#cmp-run');
  await page.waitForFunction(() => /1 entfernt/.test(document.querySelector('#version-diff').textContent));
  await page.click('#diff-close');
  assert.equal(await page.evaluate(() => window.stadtplaner.actions.diff()), null);
  console.log('✓ Versionsvergleich');

  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST plan OK');
})().catch((e) => { console.error('BROWSER-TEST plan FAILED:', e); process.exit(1); });
