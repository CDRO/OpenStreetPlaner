// Zeichnen, Einrasten, Abschnitte, Ebenen, Speichern, Teilen, Nur-Ansicht, Reload.
const { chromium, assert, openPage, helpers } = require('./helpers.cjs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const { page } = await openPage(browser, BASE, errors);
  const h = helpers(page);
  const box = await h.mapBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Strasse 1: drei Punkte, Enter
  await page.keyboard.press('s');
  await h.settle(100);
  assert.ok((await page.locator('.tool.active').textContent()).includes('Strasse'));
  const p1 = at(0.2, 0.5), p2 = at(0.5, 0.5), p3 = at(0.8, 0.5);
  for (const p of [p1, p2, p3]) { await page.mouse.click(p.x, p.y); await h.settle(80); }
  await page.keyboard.press('Enter');
  await h.settle();
  let doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.equal(doc.features[0].nodes.length, 3);
  assert.equal(doc.features[0].segments.length, 2);
  console.log('✓ Strasse gezeichnet');

  // Strasse 2 rastet auf Abschnitt 0 -> Teilung; Doppelklick beendet
  const q1 = at(0.35, 0.5 + 0.004), q2 = at(0.35, 0.2);
  await page.mouse.click(q1.x, q1.y); await h.settle(80);
  await page.mouse.dblclick(q2.x, q2.y);
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features.length, 2, 'zwei Strassen');
  assert.equal(doc.features[0].nodes.length, 4, 'Abschnitt geteilt');
  assert.equal(doc.features[1].nodes.length, 2, 'Doppelklick ohne Doppelpunkt');
  assert.deepEqual(doc.features[1].nodes[0], doc.features[0].nodes[1]);
  console.log('✓ Einrasten auf Abschnitt teilt ihn, Doppelklick beendet');

  // Shift: kein Einrasten
  await page.keyboard.down('Shift');
  const s1 = at(0.65, 0.5 + 0.004), s2 = at(0.65, 0.8);
  await page.mouse.click(s1.x, s1.y); await h.settle(80);
  await page.mouse.click(s2.x, s2.y); await h.settle(80);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features.length, 3);
  assert.equal(doc.features[0].nodes.length, 4, 'mit Shift keine Teilung');
  console.log('✓ Shift setzt Einrasten aus');

  // Auswahl per Klick auf die Linie, Brücke/Tunnel
  await page.keyboard.press('v');
  await page.mouse.move(p2.x + 60, p2.y);
  await h.settle(100);
  assert.equal(await page.locator('#tooltip').isVisible(), true, 'Tooltip beim Überfahren');
  await page.mouse.click(p2.x + 60, p2.y);
  await h.settle();
  assert.ok(await page.locator('#prop-kind').count(), 'Strasse ausgewählt');
  await page.check('input[name="seg-level"][value="bridge"]');
  await h.settle();
  doc = await h.doc();
  assert.ok(doc.features[0].segments.some((s) => s.level === 'bridge'));
  await page.check('input[name="seg-level"][value="tunnel"]');
  await page.click('#seg-apply-all');
  await h.settle();
  doc = await h.doc();
  assert.ok(doc.features[0].segments.every((s) => s.level === 'tunnel'));
  console.log('✓ Brücke/Tunnel pro Abschnitt');

  // Kreisel + Kreuzung (rastet auf Endpunkt)
  await page.keyboard.press('r');
  const c = at(0.5, 0.75);
  await page.mouse.click(c.x, c.y); await h.settle(80);
  await page.mouse.move(c.x + 30, c.y); await h.settle(80);
  await page.mouse.click(c.x + 30, c.y);
  await h.settle();
  await page.keyboard.press('k');
  await page.mouse.click(p3.x, p3.y + 2);
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.features.filter((f) => f.type === 'roundabout').length, 1);
  const j = doc.features.find((f) => f.type === 'junction');
  assert.deepEqual(j.at, doc.features[0].nodes[3], 'Kreuzung rastet auf Strassenendpunkt');
  console.log('✓ Kreisel + Kreuzung');

  // Undo/Redo
  await page.keyboard.press('Control+z');
  await h.settle();
  assert.equal((await h.doc()).features.filter((f) => f.type === 'junction').length, 0);
  await page.keyboard.press('Control+y');
  await h.settle();
  assert.equal((await h.doc()).features.filter((f) => f.type === 'junction').length, 1);
  console.log('✓ Undo/Redo');

  // Ebenen: neue Ebene, erste ausblenden -> Elemente nicht mehr auswählbar
  await page.click('.tabs button[data-tab="layers"]');
  await page.click('#btn-add-layer');
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.layers.length, 2);
  await page.locator('.layer-row').first().locator('.layer-visible').uncheck();
  await h.settle();
  doc = await h.doc();
  assert.equal(doc.layers[0].visible, false);
  await page.keyboard.press('v');
  await page.mouse.click(p2.x + 60, p2.y);
  await h.settle();
  assert.equal(await page.locator('#prop-kind').count(), 0, 'Elemente ausgeblendeter Ebene nicht wählbar');
  await page.locator('.layer-row').first().locator('.layer-visible').check();
  await h.settle();
  console.log('✓ Ebenen');

  // Speichern auf dem Server: URL wird /d/<id>, Token gemerkt, Version vorhanden
  await page.fill('#draft-name', 'Hauptstrasse neu');
  await page.press('#draft-name', 'Enter');
  await h.settle();
  await page.keyboard.press('Control+s');
  await page.waitForURL(/\/d\/[0-9a-z]{12}$/);
  await h.settle();
  const id = new URL(page.url()).pathname.split('/')[2];
  const index = await page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.drafts')));
  assert.equal(index.length, 1);
  assert.equal(index[0].id, id);
  assert.ok(index[0].token, 'Token lokal gemerkt');
  await page.click('.tabs button[data-tab="drafts"]');
  assert.equal(await page.locator('#draft-current .badge.ok').count(), 1, 'als gespeichert markiert');
  await page.click('.tabs button[data-tab="history"]');
  await page.waitForSelector('#version-list .list-row');
  assert.equal(await page.locator('#version-list .list-row').count(), 1);
  // zweite Version + Wiederherstellen der ersten
  await page.keyboard.press('k');
  await page.mouse.click(at(0.3, 0.8).x, at(0.3, 0.8).y);
  await h.settle();
  await page.keyboard.press('Control+s');
  await h.settle(800);
  await page.click('.tabs button[data-tab="history"]');
  await page.waitForFunction(() => document.querySelectorAll('#version-list .list-row').length === 2);
  const junctionsBefore = (await h.doc()).features.filter((f) => f.type === 'junction').length;
  await page.locator('#version-list .list-row').last().locator('.v-restore').click();
  await h.settle(800);
  assert.equal((await h.doc()).features.filter((f) => f.type === 'junction').length, junctionsBefore - 1, 'Version 1 wiederhergestellt');
  console.log('✓ Speichern + Versionen');

  // Teilen: Ansichts- und Bearbeitungslink
  await page.click('#btn-share');
  await page.waitForSelector('#share-url');
  const viewUrl = await page.inputValue('#share-url');
  const editUrl = await page.inputValue('#share-edit-url');
  assert.ok(viewUrl.endsWith(`/d/${id}`));
  assert.ok(editUrl.includes(`/d/${id}#edit=`));
  await page.keyboard.press('Escape');

  // Ansichtslink in frischem Browser-Kontext: nur Ansicht, eigene Kopie anlegen
  const viewer = await openPage(browser, viewUrl, errors);
  const vh = helpers(viewer.page);
  assert.equal(await viewer.page.locator('#banner').isVisible(), true, 'Nur-Ansicht-Banner');
  assert.equal(await viewer.page.locator('.tool[data-tool="road"]').isDisabled(), true, 'Zeichnen gesperrt');
  assert.equal((await vh.doc()).name, 'Hauptstrasse neu');
  await viewer.page.click('#banner-action');
  await viewer.page.waitForURL((u) => /\/d\/[0-9a-z]{12}$/.test(u.pathname) && !u.pathname.endsWith(id));
  await vh.settle();
  assert.equal(await viewer.page.locator('#banner').isVisible(), false);
  assert.equal(await viewer.page.locator('.tool[data-tool="road"]').isDisabled(), false, 'Kopie ist bearbeitbar');
  assert.ok((await vh.doc()).name.includes('Kopie'));
  await viewer.context.close();

  // Bearbeitungslink in frischem Kontext: direkt bearbeitbar
  const editor = await openPage(browser, editUrl, errors);
  await editor.page.waitForURL((u) => u.pathname.endsWith(id) && !u.hash);
  assert.equal(await editor.page.locator('#banner').isVisible(), false);
  assert.equal(await editor.page.locator('.tool[data-tool="road"]').isDisabled(), false);
  const editorIndex = await editor.page.evaluate(() => JSON.parse(localStorage.getItem('stadtplaner.drafts')));
  assert.ok(editorIndex[0].token, 'Token aus dem Bearbeitungslink übernommen');
  await editor.context.close();
  console.log('✓ Teilen: Ansicht, Kopie, Bearbeitungslink');

  // Kommentare: Empfänger (nur Ansicht) kommentiert, Besitzer sieht, erledigt und löscht
  const commenter = await openPage(browser, viewUrl, errors);
  const ch = helpers(commenter.page);
  await commenter.page.click('.tabs button[data-tab="comments"]');
  await commenter.page.click('#comment-add');
  assert.ok((await commenter.page.locator('.tool.active').textContent()).includes('Kommentar'), 'Kommentar-Werkzeug auch ohne Bearbeitungsrecht');
  const cbox = await ch.mapBox();
  await commenter.page.mouse.click(cbox.x + cbox.width * 0.5, cbox.y + cbox.height * 0.5);
  await commenter.page.waitForSelector('#comment-text');
  await commenter.page.fill('#comment-author', 'Anna');
  await commenter.page.fill('#comment-text', 'Hier fehlt ein Fussgängerstreifen.');
  await commenter.page.click('#comment-send');
  await commenter.page.waitForSelector('.comment-row');
  assert.equal(await commenter.page.locator('.comment-row').count(), 1);
  assert.ok((await commenter.page.textContent('.comment-row')).includes('Anna'));
  assert.equal(await commenter.page.locator('.comment-row .c-resolve').count(), 1, 'Verfasser darf erledigen');
  await commenter.page.click('.comment-row .c-resolve');
  await commenter.page.waitForSelector('.comment-row.resolved');
  await commenter.context.close();
  await page.click('.tabs button[data-tab="comments"]');
  await page.click('#comment-refresh');
  await page.waitForSelector('.comment-row.resolved');
  const own = await page.evaluate(() => window.stadtplaner.comments());
  assert.equal(own.length, 1);
  assert.equal(own[0].resolved, true);
  await page.click('.comment-row .c-focus');
  await h.settle(800);
  assert.ok((await page.locator('.comment-row.active').count()) === 1, 'Kommentar fokussiert');
  await page.click('.comment-row .c-delete');
  await page.waitForFunction(() => window.stadtplaner.comments().length === 0);
  console.log('✓ Kommentare');

  // Reload behält Entwurf und Bindung
  await page.reload({ waitUntil: 'load' });
  await h.settle(800);
  assert.ok(page.url().endsWith(`/d/${id}`));
  assert.equal((await h.doc()).name, 'Hauptstrasse neu');
  console.log('✓ Reload');

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST basics OK');
})().catch((e) => { console.error('BROWSER-TEST basics FAILED:', e); process.exit(1); });
