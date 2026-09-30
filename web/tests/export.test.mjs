import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfFromJpeg, exportSize, documentBounds } from '../js/export.js';
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
  const entries = /xref\n0 7\n0000000000 65535 f \n((?:\d{10} 00000 n \n){6})/.exec(text);
  assert.ok(entries, 'sechs xref-Einträge');
  entries[1].trim().split('\n').forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.equal(ascii(pdf, off, `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `Objekt ${i + 1} am Offset ${off}`);
  });
  const streamStart = text.indexOf('stream\n', text.indexOf('4 0 obj')) + 'stream\n'.length;
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
