// Offline-Schale: Service Worker cached die App-Dateien; ohne Netz lädt die Seite aus dem Cache mit der Arbeitskopie.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { context, page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  await page.evaluate(() => {
    const sp = window.stadtplaner;
    sp.store.commit('Offline-Test', (d) => {
      d.name = 'Offline-Entwurf';
      d.features.push({ id: 'r_off', type: 'road', layerId: d.layers[0].id, name: 'Offlinestrasse', kind: 'main', status: 'new', oneway: false, maxspeed: null, width: null, section: null, osmId: null, nodes: [[47.05, 8.3], [47.05, 8.31]], segments: [{ level: 'ground', maxspeed: null, access: null }], profile: null, parcels: null, note: '', phase: null });
    });
  });
  await h.settle(600); // Autosave der Arbeitskopie
  // Service Worker installiert die Schale
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 50; i++) {
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith('shell-'));
      if (shell) {
        const cache = await caches.open(shell);
        const entries = (await cache.keys()).map((r) => new URL(r.url).pathname);
        if (entries.includes('/') && entries.includes('/static/js/app.js')) return { shell, entries: entries.length, scope: reg.scope };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  assert.ok(info && info.entries >= 10, `Schale gecacht: ${JSON.stringify(info)}`);
  const manifest = await page.evaluate(() => fetch('/api/shell').then((r) => r.json()));
  assert.ok(info.shell === `shell-${manifest.version}`, `Cache-Name trägt die Version: ${info.shell} / ${manifest.version}`);
  assert.ok(manifest.files.includes('/static/css/app.css') && manifest.files.includes('/static/js/routing.worker.js'));
  console.log('✓ Schale gecacht');

  // Ohne Netz: Seite lädt aus dem Cache, Arbeitskopie ist da, Routing-Worker läuft trotzdem
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.smap-canvas', { timeout: 15000 });
  await h.settle(500);
  const doc = await h.doc();
  assert.equal(doc.name, 'Offline-Entwurf');
  assert.ok(doc.features.some((f) => f.id === 'r_off'), 'Arbeitskopie offline geladen');
  assert.ok(await page.evaluate(() => navigator.serviceWorker.controller !== null), 'Seite wird vom Service Worker kontrolliert');
  await context.setOffline(false);
  console.log('✓ Offline-Start');

  await browser.close();
  const real = errors.filter((e) => !/Failed to fetch|NetworkError|net::|TypeError: Failed/.test(e));
  if (real.length) { console.log('FEHLER:', real); process.exit(1); }
  console.log('BROWSER-TEST offline OK');
})().catch((e) => { console.error('BROWSER-TEST offline FAILED:', e); process.exit(1); });
