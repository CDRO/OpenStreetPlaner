// Lebenszyklus: Ablaufhinweis, E-Mail-Erinnerung, Sicherung herunterladen und wieder einspielen.
const fs = require('fs');
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  const box = await h.mapBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Ungespeichert: keine Sicherung vom Server, kein Ablaufhinweis
  await page.click('.tabs button[data-tab="drafts"]');
  assert.equal(await page.locator('#d-backup').count(), 0, 'Sicherung erst nach dem Speichern');
  assert.equal((await page.locator('#draft-lifecycle').innerHTML()).trim(), '', 'kein Ablauf ohne Entwurf');

  // Strasse zeichnen und speichern
  await page.keyboard.press('s');
  for (const p of [at(0.2, 0.5), at(0.6, 0.5)]) { await page.mouse.click(p.x, p.y); await h.settle(80); }
  await page.keyboard.press('Enter');
  await h.settle();
  await page.fill('#draft-name', 'Sicherung Test');
  await page.press('#draft-name', 'Enter');
  await page.keyboard.press('Control+s');
  await page.waitForURL(/\/d\/[0-9a-z]{12}$/);
  await h.settle();
  const id = new URL(page.url()).pathname.split('/')[2];
  await page.click('.tabs button[data-tab="drafts"]');
  await page.waitForSelector('#lifecycle-expiry');
  const expiry = await page.locator('#lifecycle-expiry').textContent();
  assert.ok(expiry.includes('365 Tage'), `Aufbewahrung genannt: ${expiry}`);
  assert.ok(/gelöscht/.test(expiry), 'Ablaufdatum genannt');
  console.log('✓ Ablaufhinweis nach dem Speichern');

  // E-Mail hinterlegen (der Testserver hat SMTP konfiguriert, verschickt aber nichts)
  await page.waitForSelector('#reminder-email');
  await page.fill('#reminder-email', 'kein-mail');
  await page.click('#reminder-save');
  await page.waitForSelector('.toast.error');
  assert.equal(await page.locator('#reminder-state').count(), 0, 'ungültige Adresse nicht übernommen');
  await page.fill('#reminder-email', 'Anna@Example.ch');
  await page.press('#reminder-email', 'Enter');
  await page.waitForSelector('#reminder-state');
  assert.ok((await page.locator('#reminder-state').textContent()).includes('anna@example.ch'));
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.drafts'))[0].token);
  const reminder = await (await fetch(`${BASE}api/drafts/${id}/reminder`, { headers: { 'X-Edit-Token': token } })).json();
  assert.equal(reminder.email, 'anna@example.ch');
  assert.equal(reminder.retentionDays, 365);
  assert.equal(reminder.mailEnabled, true);
  assert.equal((await (await fetch(`${BASE}api/drafts/${id}`)).json()).email, undefined, 'Adresse nicht öffentlich');
  console.log('✓ E-Mail-Erinnerung hinterlegt');

  // Sicherung herunterladen: Datei mit Format, Versionen und Kommentaren
  await fetch(`${BASE}api/drafts/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 47, lng: 8, author: 'Anna', text: 'Hinweis' }) });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#d-backup')]);
  assert.ok(download.suggestedFilename().endsWith('.stadtplaner-backup.json'), download.suggestedFilename());
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.format, 'stadtplaner-backup');
  assert.equal(backup.id, id);
  assert.equal(backup.doc.features.length, 1);
  assert.equal(backup.versions.length, 1);
  assert.equal(backup.comments.length, 1);
  console.log('✓ Sicherung heruntergeladen');

  // Sicherung importieren: neuer Entwurf mit eigenem Token, Versionen und Kommentaren
  await page.setInputFiles('#import-file', { name: 'sicherung.stadtplaner-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForURL((u) => /\/d\/[0-9a-z]{12}$/.test(u.pathname) && !u.pathname.endsWith(id));
  await h.settle();
  const nid = new URL(page.url()).pathname.split('/')[2];
  const doc = await h.doc();
  assert.equal(doc.name, 'Sicherung Test');
  assert.equal(doc.features.length, 1);
  await page.click('.tabs button[data-tab="drafts"]');
  await page.waitForSelector('#d-save');
  assert.equal(await page.locator('#draft-current .badge.ok').count(), 1, 'eingespielter Entwurf gehört uns und ist gespeichert');
  const index = await page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.drafts')));
  assert.equal(index.length, 2);
  assert.ok(index.find((d) => d.id === nid && d.token), 'Token des neuen Entwurfs gemerkt');
  await page.click('.tabs button[data-tab="history"]');
  await page.waitForSelector('#version-list .list-row');
  assert.equal(await page.locator('#version-list .list-row').count(), 2, 'alte Version plus Einspielen');
  const comments = await (await fetch(`${BASE}api/drafts/${nid}/comments`)).json();
  assert.equal(comments.length, 1);
  assert.equal((await (await fetch(`${BASE}api/drafts/${nid}/reminder`, { headers: { 'X-Edit-Token': index.find((d) => d.id === nid).token } })).json()).email, '', 'Adresse wird nicht mitkopiert');
  console.log('✓ Sicherung als neuer Entwurf eingespielt');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('Browser-Tests lifecycle OK');
})().catch((e) => { console.error('BROWSER-TEST lifecycle FAILED:', e); process.exit(1); });
