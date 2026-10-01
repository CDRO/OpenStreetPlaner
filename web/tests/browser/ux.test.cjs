// Aktionsleiste beim Zeichnen, Live-Aktualisierung per SSE, Speicherkonflikt,
// Präsentationsmodus, Bericht-Export und Bottom-Sheet auf schmalen Bildschirmen.
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

  // --- Aktionsleiste: Fertig / Letzter Punkt / Abbrechen ---------------------------
  assert.ok(await page.locator('#draw-actions').isHidden(), 'Leiste ohne Zeichnung versteckt');
  await page.keyboard.press('s');
  await page.mouse.click(at(0.2, 0.4).x, at(0.2, 0.4).y);
  await h.settle(100);
  await page.waitForSelector('#draw-actions:not([hidden])');
  assert.ok(await page.locator('#da-finish').isDisabled(), 'ein Punkt reicht nicht');
  await page.mouse.click(at(0.5, 0.4).x, at(0.5, 0.4).y);
  await h.settle(100);
  assert.ok(await page.locator('#da-finish').isEnabled(), 'zwei Punkte: fertig möglich');
  await page.mouse.click(at(0.8, 0.4).x, at(0.8, 0.4).y);
  await h.settle(100);
  await page.click('#da-undo-point');
  await h.settle(100);
  await page.click('#da-finish');
  await h.settle(300);
  let doc = await h.doc();
  assert.equal(doc.features.length, 1);
  assert.equal(doc.features[0].nodes.length, 2, 'letzter Punkt wurde entfernt');
  assert.ok(await page.locator('#draw-actions').isHidden(), 'Leiste nach Abschluss versteckt');
  await page.mouse.click(at(0.3, 0.7).x, at(0.3, 0.7).y);
  await h.settle(100);
  await page.click('#da-cancel');
  await h.settle(100);
  assert.equal((await h.doc()).features.length, 1, 'Abbrechen verwirft die Zeichnung');
  assert.ok(await page.locator('#draw-actions').isHidden());
  console.log('✓ Aktionsleiste beim Zeichnen');

  // --- Speichern, zweiter Editor über Bearbeitungslink ---------------------------
  await page.fill('#draft-name', 'Live-Test');
  await page.press('#draft-name', 'Enter');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /\/d\/[0-9a-z]+$/.test(location.pathname));
  const id = page.url().split('/d/')[1];
  const token = await page.evaluate((x) => window.stadtplaner.local.tokenFor(x), id);
  assert.ok(token, 'Bearbeitungs-Token gespeichert');
  const editUrl = `${BASE}d/${id}#edit=${token}`;

  const other = await openPage(browser, editUrl, errors);
  const oh = helpers(other.page);
  await other.page.waitForFunction(() => window.stadtplaner.actions.canEdit());
  await other.page.fill('#draft-name', 'Von anderer Person');
  await other.page.press('#draft-name', 'Enter');
  await other.page.keyboard.press('Control+s');
  await other.page.waitForFunction(() => !window.stadtplaner.actions.isDirty());

  // Erste Seite ist nicht schmutzig: Live-Ereignis übernimmt den neuen Stand automatisch
  await page.waitForFunction(() => window.stadtplaner.store.doc.name === 'Von anderer Person', null, { timeout: 8000 });
  assert.equal(await page.inputValue('#draft-name'), 'Von anderer Person');
  assert.ok(!(await page.evaluate(() => window.stadtplaner.actions.isDirty())), 'übernommener Stand gilt als gespeichert');
  console.log('✓ Live-Aktualisierung per SSE');

  // --- Konflikt: beide ändern, erste Seite ist schmutzig, andere speichert zuerst ---
  await page.keyboard.press('s');
  await page.mouse.click(at(0.2, 0.8).x, at(0.2, 0.8).y);
  await page.mouse.click(at(0.6, 0.8).x, at(0.6, 0.8).y);
  await page.keyboard.press('Enter');
  await h.settle(200);
  assert.equal((await h.doc()).features.length, 2);
  await other.page.keyboard.press('s');
  const obox = await oh.mapBox();
  await other.page.mouse.click(obox.x + obox.width * 0.7, obox.y + obox.height * 0.2);
  await other.page.mouse.click(obox.x + obox.width * 0.9, obox.y + obox.height * 0.2);
  await other.page.keyboard.press('Enter');
  await other.page.keyboard.press('Control+s');
  await other.page.waitForFunction(() => !window.stadtplaner.actions.isDirty());
  await page.waitForSelector('#banner:not([hidden])', { timeout: 8000 });
  assert.ok((await page.textContent('#banner')).includes('inzwischen gespeichert'));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('#conflict-overwrite');
  await page.click('#conflict-overwrite');
  await page.waitForFunction(() => !window.stadtplaner.actions.isDirty(), null, { timeout: 8000 });
  assert.ok(await page.locator('#banner').isHidden() || !(await page.textContent('#banner')).includes('inzwischen'), 'Hinweis nach dem Speichern weg');
  // Die andere Seite war sauber und übernimmt die überschreibende Fassung (2 Strassen, nicht 3)
  await other.page.waitForFunction(() => window.stadtplaner.store.doc.features.length === 2, null, { timeout: 8000 });
  const versions = await page.evaluate(() => window.stadtplaner.actions.listVersions());
  assert.ok(versions.length >= 3, `Versionen: ${versions.length}`);
  console.log('✓ Speicherkonflikt erkannt und aufgelöst');

  // Zweiter Konflikt: Serverstand übernehmen
  await other.page.fill('#draft-name', 'Zweite Änderung');
  await other.page.press('#draft-name', 'Enter');
  await page.keyboard.press('s');
  await page.mouse.click(at(0.2, 0.9).x, at(0.2, 0.9).y);
  await page.mouse.click(at(0.6, 0.9).x, at(0.6, 0.9).y);
  await page.keyboard.press('Enter');
  await other.page.keyboard.press('Control+s');
  await other.page.waitForFunction(() => !window.stadtplaner.actions.isDirty());
  await page.waitForSelector('#banner:not([hidden])', { timeout: 8000 });
  await page.keyboard.press('Control+s');
  await page.waitForSelector('#conflict-reload');
  await page.click('#conflict-reload');
  await page.waitForFunction(() => window.stadtplaner.store.doc.name === 'Zweite Änderung');
  assert.equal((await h.doc()).features.length, 2, 'Serverstand übernommen');
  assert.ok(!(await page.evaluate(() => window.stadtplaner.actions.isDirty())));
  assert.ok(await page.evaluate(() => window.stadtplaner.store.canUndo()), 'eigene Fassung per Rückgängig erreichbar');
  await other.context.close();
  console.log('✓ Serverstand übernehmen');

  // --- Präsentationsmodus -------------------------------------------------------------
  await page.click('#btn-share');
  await page.waitForSelector('#share-present-url');
  const presentUrl = await page.inputValue('#share-present-url');
  assert.ok(presentUrl.endsWith(`/d/${id}?present=1`));
  await page.click('.modal [data-close]');
  const present = await openPage(browser, presentUrl, errors);
  await present.page.waitForSelector('#present-panel:not([hidden])');
  assert.ok(await present.page.evaluate(() => document.body.classList.contains('present')));
  assert.ok((await present.page.textContent('#present-panel')).includes('Zweite Änderung'));
  assert.ok((await present.page.textContent('#present-panel')).includes('2 Strassen'));
  assert.ok(await present.page.locator('#sidebar').isHidden(), 'Seitenleiste ausgeblendet');
  assert.ok(!(await present.page.evaluate(() => window.stadtplaner.actions.canEdit())), 'nur Ansicht');
  await present.page.keyboard.press('s');
  const pbox = await present.page.locator('#map').boundingBox();
  await present.page.mouse.click(pbox.x + pbox.width * 0.5, pbox.y + pbox.height * 0.5);
  await present.page.mouse.click(pbox.x + pbox.width * 0.6, pbox.y + pbox.height * 0.5);
  await present.page.keyboard.press('Enter');
  await present.page.waitForTimeout(300);
  assert.equal((await helpers(present.page).doc()).features.length, 2, 'Zeichnen im Präsentationsmodus wirkungslos');
  await present.page.click('#present-edit');
  await present.page.waitForFunction((x) => location.pathname === `/d/${x}` && !location.search, id);
  await present.context.close();
  console.log('✓ Präsentationsmodus');

  // --- Bericht-Export (PDF mit Textseiten) -----------------------------------------
  await page.click('#btn-share');
  await page.waitForSelector('#share-export');
  await page.click('#share-export');
  await page.waitForSelector('#export-report');
  await page.check('#export-report');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-pdf')]);
  assert.equal(download.suggestedFilename(), 'Zweite_Aenderung-bericht.pdf', 'Umlaute transliteriert, sonst nennt Chromium die Datei „download“');
  const pdfPath = await download.path();
  const pdf = fs.readFileSync(pdfPath).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  const count = Number(/\/Count (\d+)/.exec(pdf)[1]);
  assert.ok(count >= 2, `Seiten: ${count}`);
  assert.ok(pdf.includes('/DCTDecode') && pdf.includes('Massnahmen'), 'Kartenseite und Textseite');
  assert.ok(await page.isChecked('#export-confidence'), 'Zuversicht standardmässig im Bericht');
  assert.ok(/Zuversicht (hoch|mittel|tief) \\\(/.test(pdf), 'Zuversicht der Kostenschätzung im Bericht (Strassen ohne Breite -> tief, Standardwerte -> Band)');
  // Abschalten: Einstellung bleibt, Bericht ohne Zuversicht
  await page.uncheck('#export-confidence');
  await h.settle(100);
  assert.equal(await page.evaluate(() => window.stadtplaner.settings.reportConfidence), false);
  const [download2] = await Promise.all([page.waitForEvent('download'), page.click('#export-pdf')]);
  const pdf2 = fs.readFileSync(await download2.path()).toString('latin1');
  assert.ok(pdf2.includes('Massnahmen') && !pdf2.includes('Zuversicht'), 'ohne Zuversicht');
  await page.check('#export-confidence');
  await h.settle(100);
  // DXF für die CAD-Übergabe: R12, Ebene je Entwurfsebene, Koordinaten in LV95
  const [dxfDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-dxf')]);
  assert.equal(dxfDl.suggestedFilename(), 'Zweite_Aenderung.dxf');
  const dxf = fs.readFileSync(await dxfDl.path()).toString('utf8');
  assert.ok(dxf.startsWith('0\nSECTION') && dxf.includes('AC1009') && dxf.includes('\n0\nPOLYLINE\n') && /10\n26\d{5}\.\d{2}\n/.test(dxf), 'DXF mit Polylinien in LV95');
  await page.click('.modal [data-close]');
  console.log('✓ Bericht-Export');

  // --- Bottom-Sheet auf schmalen Bildschirmen ---------------------------------------
  const mobile = await openPage(browser, `${BASE}d/${id}`, errors, { width: 420, height: 800 });
  assert.ok(await mobile.page.evaluate(() => document.body.classList.contains('sidebar-hidden')), 'Sheet startet eingeklappt');
  const tabs = await mobile.page.locator('.tabs').boundingBox();
  assert.ok(tabs.y > 800 - 100 && tabs.y + tabs.height <= 800, `Tabs als Griff am unteren Rand über der Statuszeile (y=${tabs.y})`);
  await mobile.page.click('.tabs button[data-tab="layers"]');
  await mobile.page.waitForTimeout(300);
  assert.ok(!(await mobile.page.evaluate(() => document.body.classList.contains('sidebar-hidden'))), 'Tipp auf Tab klappt das Sheet auf');
  assert.ok(await mobile.page.locator('#tab-layers').isVisible());
  await mobile.context.close();
  console.log('✓ Bottom-Sheet');

  await browser.close();
  if (errors.length) { console.log('FEHLER:', errors); process.exit(1); }
  console.log('BROWSER-TEST ux OK');
})().catch((e) => { console.error('BROWSER-TEST ux FAILED:', e); process.exit(1); });
