import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfFromJpeg } from '../js/export.js';

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
