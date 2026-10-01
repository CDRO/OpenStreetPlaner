import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfFromJpeg, exportSize, documentBounds, buildPdf, wrapText, pdfWinAnsi, textWidth, reportBlocks, mppForScale, zoomForScale, scaleDenominator } from '../js/export.js';
import { createDocument, createRoad, createRoundabout } from '../js/model.js';

const ascii = (bytes, from, len) => new TextDecoder('latin1').decode(bytes.subarray(from, from + len));

test('pdfFromJpeg erzeugt ein strukturell gültiges PDF mit korrekter xref-Tabelle', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = pdfFromJpeg(jpeg, 800, 600, { title: 'Hauptstrasse neu – Variante Ä' });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('/Filter /DCTDecode'));
  assert.ok(text.includes('/Width 800 /Height 600'));
  assert.ok(text.includes('/MediaBox [0 0 841.89 595.28]'), 'Querformat für breites Bild');
  assert.ok(text.includes(`/Length ${jpeg.length} >>`));
  assert.ok(text.includes('/Title <FEFF0048'), 'Titel als UTF-16BE');
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(ascii(pdf, startxref, 4), 'xref');
  const entries = /xref\n0 9\n0000000000 65535 f \n((?:\d{10} 00000 n \n){8})/.exec(text);
  assert.ok(entries, 'acht xref-Einträge (Katalog, Seiten, 2 Fonts, Info, Seite, Inhalt, Bild)');
  entries[1].trim().split('\n').forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.equal(ascii(pdf, off, `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `Objekt ${i + 1} am Offset ${off}`);
  });
  const streamStart = text.indexOf('stream\n', text.indexOf('/Subtype /Image')) + 'stream\n'.length;
  assert.deepEqual(Array.from(pdf.subarray(streamStart, streamStart + jpeg.length)), Array.from(jpeg), 'JPEG-Bytes unverändert eingebettet');
  const portrait = new TextDecoder('latin1').decode(pdfFromJpeg(jpeg, 600, 800));
  assert.ok(portrait.includes('/MediaBox [0 0 595.28 841.89]'), 'Hochformat für hohes Bild');
});

test('exportSize rechnet Papier und dpi in Pixel um, PDF übernimmt die Seitengrösse', () => {
  const a4 = exportSize({ paper: 'a4', orientation: 'landscape', dpi: 300 });
  assert.equal(a4.width, Math.round(((297 - 20) / 25.4) * 96));
  assert.equal(a4.height, Math.round(((210 - 20) / 25.4) * 96));
  assert.ok(Math.abs(a4.pixelRatio - 3.125) < 1e-9);
  const a3p = exportSize({ paper: 'a3', orientation: 'portrait', dpi: 150 });
  assert.ok(a3p.height > a3p.width);
  assert.equal(a3p.pageWmm, 297);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = new TextDecoder('latin1').decode(pdfFromJpeg(jpeg, 100, 50, { pageWmm: 420, pageHmm: 297 }));
  assert.ok(pdf.includes('/MediaBox [0 0 1190.55 841.89]'), 'A3 quer in Punkt');
});

test('documentBounds umfasst alle sichtbaren Elemente mit Rand', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  assert.equal(documentBounds(doc), null);
  doc.features.push(createRoad({ layerId, nodes: [[47, 8], [47.01, 8.02]] }));
  doc.features.push(createRoundabout({ layerId, center: [47.02, 8.03], radius: 20 }));
  const b = documentBounds(doc);
  assert.ok(b.south < 47 && b.north > 47.02 && b.west < 8 && b.east > 8.03);
  doc.layers[0].visible = false;
  assert.equal(documentBounds(doc), null, 'ausgeblendete Ebene zählt nicht');
});

test('buildPdf: mehrere Seiten mit Bild und Text, gültige xref', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = buildPdf({
    pages: [
      { image: { jpeg, width: 400, height: 300 } },
      { blocks: [{ text: 'Massnahmen', size: 13, bold: true }, { text: 'Hauptstrasse neu – Tempo 30, Brücke über die Bahn (Käse, Öl, Übung).' }] },
    ],
    pageWmm: 297, pageHmm: 210, title: 'Bericht',
  });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('/BaseFont /Helvetica-Bold'));
  assert.ok(text.includes('/Encoding /WinAnsiEncoding'));
  assert.ok(text.includes('(Massnahmen) Tj'));
  assert.ok(text.includes('K\xe4se'), 'Umlaute als cp1252');
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(new TextDecoder('latin1').decode(pdf.subarray(startxref, startxref + 4)), 'xref');
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const entries = text.slice(startxref).split('\n').slice(3, 3 + size - 1);
  entries.forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    const head = new TextDecoder('latin1').decode(pdf.subarray(off, off + `${i + 1} 0 obj`.length));
    assert.equal(head, `${i + 1} 0 obj`, `Objekt ${i + 1}`);
  });
});

test('Textumbruch, Breiten und WinAnsi-Escaping', () => {
  assert.ok(textWidth('iii', 10) < textWidth('WWW', 10));
  const lines = wrapText('Dies ist ein etwas längerer Satz, der umgebrochen werden muss.', 10, 120);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => textWidth(l, 10) <= 120 || !l.includes(' ')));
  assert.deepEqual(wrapText('a\n\nb', 10, 100), ['a', '', 'b']);
  assert.equal(pdfWinAnsi('a(b)c\\'), 'a\\(b\\)c\\\\');
  assert.equal(pdfWinAnsi('–'), String.fromCharCode(0x96));
  assert.equal(pdfWinAnsi('€'), String.fromCharCode(0x80));
  assert.equal(pdfWinAnsi('漢'), '?');
});

test('reportBlocks fasst Massnahmen, Route und Kommentare zusammen', () => {
  const doc = createDocument({ name: 'Bericht' });
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.01]], kind: 'main', maxspeed: 30 });
  road.segments[0].level = 'tunnel';
  doc.features.push(road);
  doc.features.push(createRoundabout({ layerId, center: [47, 8], radius: 15 }));
  const blocks = reportBlocks(doc, {
    routes: { current: { dist: 1500, time: 120, sd: 0 }, proposed: { dist: 1200, time: 100, sd: 10, p15: 90, p85: 110 } },
    comments: [{ id: 'c1', author: 'Anna', at: '2026-09-30T10:00:00Z', text: 'Bitte Tempo 30', resolved: false }, { id: 'c2', parentId: 'c1', author: 'Gemeinde', at: '2026-09-30T11:00:00Z', text: 'Wird geprüft' }],
    link: 'https://x/d/abc',
  });
  const all = blocks.map((b) => b.text).join('\n');
  assert.ok(all.includes('Hauptstrasse, neu') && all.includes('Tempo 30') && all.includes('Brücke/Tunnel'));
  assert.ok(all.includes('Kreisel, Radius 15 m'));
  assert.ok(all.includes('Heute: 1.50 km, 2:00 min') && all.includes('P15–P85'));
  assert.ok(all.includes('Differenz: −0.30 km, −0:20 min'));
  assert.ok(all.includes('Anna') && all.includes('↳ Gemeinde: Wird geprüft'));
});

test('Fester Massstab: Zoom aus Massstab und zurück', () => {
  assert.ok(Math.abs(mppForScale(2000) - 0.529166) < 1e-5, '1:2000 -> 0.529 m je CSS-Pixel');
  const z = zoomForScale(2000, 47);
  // Meter je Pixel bei diesem Zoom: 2πR / (256 · 2^z) · cos(47°)
  const mpp = ((2 * Math.PI * 6378137) / (256 * Math.pow(2, z))) * Math.cos((47 * Math.PI) / 180);
  assert.equal(scaleDenominator(mpp), 2000);
  assert.ok(zoomForScale(500, 47) > 19, '1:500 liegt über der Kachelgrenze');
  assert.ok(zoomForScale(10000, 47) < 16, '1:10000 liegt um Zoom 15.3');
});
