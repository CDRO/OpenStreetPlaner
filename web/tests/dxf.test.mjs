import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDXF, wgs84ToLV95, dxfLayerName, aciColor } from '../js/dxf.js';
import { createDocument, createLayer, createRoad, createJunction, createRoundabout, createZone } from '../js/model.js';

test('WGS84 -> LV95: Bern-Nullpunkt und Zürich innerhalb eines Meters', () => {
  const bern = wgs84ToLV95(46 + 57 / 60 + 8.66 / 3600, 7 + 26 / 60 + 22.5 / 3600);
  assert.ok(Math.abs(bern[0] - 2600072.37) < 1 && Math.abs(bern[1] - 1200147.07) < 1, `${bern}`);
  const zh = wgs84ToLV95(47.3769, 8.5417); // Zürich HB rund 2683000 / 1248000
  assert.ok(Math.abs(zh[0] - 2683100) < 400 && Math.abs(zh[1] - 1247900) < 400, `${zh}`);
  assert.equal(dxfLayerName('Variante Ä/Ö 1'), 'VARIANTE_A_O_1');
  assert.equal(dxfLayerName(''), 'EBENE');
  assert.equal(aciColor('#d7263d'), 1);
  assert.equal(aciColor('#00ff00'), 3);
  assert.equal(aciColor('kaputt'), 7);
});

test('DXF R12: Ebenen-Tabelle, Polylinien, Punkte, Kreise und Beschriftungen', () => {
  const doc = createDocument({ name: 'Test' });
  const a = doc.layers[0];
  const b = createLayer(doc, 'Variante B', '#2a9d3f');
  doc.features.push(
    createRoad({ layerId: a.id, nodes: [[47.05, 8.3], [47.051, 8.302], [47.052, 8.305]], kind: 'main', name: 'Umfahrung' }),
    createRoad({ layerId: b.id, nodes: [[47.05, 8.3], [47.05, 8.31]], kind: 'secondary', status: 'remove' }),
    createZone({ layerId: a.id, kind: 'tempo30', nodes: [[47.049, 8.299], [47.049, 8.303], [47.052, 8.303]] }),
    createJunction({ layerId: a.id, at: [47.05, 8.3], kind: 'busstop', name: 'Post', lines: ['12'] }),
    createRoundabout({ layerId: b.id, center: [47.052, 8.305], radius: 14 }),
  );
  const dxf = toDXF(doc);
  assert.ok(dxf.startsWith('0\nSECTION\n2\nHEADER\n') && dxf.endsWith('0\nEOF\n'));
  assert.ok(dxf.includes('AC1009'));
  assert.equal((dxf.match(/\n0\nLAYER\n/g) || []).length, 3, 'Beschriftung + zwei Ebenen');
  assert.ok(dxf.includes('2\nEBENE_1\n') && dxf.includes('2\nVARIANTE_B\n'));
  assert.equal((dxf.match(/\n0\nPOLYLINE\n/g) || []).length, 3, 'zwei Strassen und eine Fläche');
  assert.equal((dxf.match(/\n0\nVERTEX\n/g) || []).length, 3 + 2 + 3);
  assert.equal((dxf.match(/\n0\nSEQEND\n/g) || []).length, 3);
  assert.ok(/0\nPOLYLINE\n8\nVARIANTE_B\n6\nDASHED\n/.test(dxf), 'Rückbau gestrichelt');
  assert.ok(/70\n1\n/.test(dxf), 'Fläche geschlossen');
  assert.equal((dxf.match(/\n0\nPOINT\n/g) || []).length, 1);
  assert.equal((dxf.match(/\n0\nCIRCLE\n/g) || []).length, 1);
  assert.ok(/40\n14\.00\n/.test(dxf), 'Kreiselradius');
  assert.ok(dxf.includes('1\nUmfahrung (Hauptstrasse, new, B ') && dxf.includes('1\nPost 12\n'));
  // Koordinaten liegen im LV95-Bereich
  const east = /10\n(26\d{5}\.\d{2})\n/.exec(dxf);
  const north = /20\n(12\d{5}\.\d{2})\n/.exec(dxf);
  assert.ok(east && north, 'LV95-Koordinaten');
});
