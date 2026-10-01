import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lengthInPolygons, pointInRings, summarizeParcels, validParcels, parcelLabel, normalizeParcels } from '../js/parcels.js';
import { createDocument, createRoad, deserialize, serialize, nodesKey } from '../js/model.js';

const square = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w]];

test('Länge in Polygonen per Abtastung, Löcher zählen nicht', () => {
  // Strasse 1 km nach Osten auf 47°; Parzelle deckt die mittleren 40 %
  const road = [[47, 8], [47, 8.013145]]; // ~ 1000 m
  const parcel = [square(46.999, 8.0052580, 47.001, 8.0105160)];
  const inside = lengthInPolygons(road, [parcel]);
  assert.ok(Math.abs(inside - 400) < 3, `${inside} m`);
  const hole = [square(46.999, 8.0052580, 47.001, 8.0105160), square(46.9995, 8.0065725, 47.0005, 8.0078870)];
  const withHole = lengthInPolygons(road, [hole]);
  assert.ok(Math.abs(withHole - 300) < 3, `${withHole} m`);
  assert.equal(pointInRings([47, 8.007], hole), false);
  assert.equal(pointInRings([47, 8.006], hole), true);
  assert.equal(lengthInPolygons(road, []), 0);
});

test('summarizeParcels sortiert nach Länge, lässt Berührungen unter 0.5 m weg, validParcels prüft die Geometrie', () => {
  const doc = createDocument();
  const road = createRoad({ layerId: doc.layers[0].id, nodes: [[47, 8], [47, 8.013145]] });
  doc.features.push(road);
  const parcels = [
    { egrid: 'CH1', number: '1', canton: 'BE', polygons: [[square(46.999, 8, 47.001, 8.002)]] }, // ~152 m
    { egrid: 'CH2', number: '2', canton: 'BE', polygons: [[square(46.999, 8.002, 47.001, 8.01)]] }, // ~608 m
    { egrid: 'CH3', number: '3', polygons: [[square(47.002, 8, 47.003, 8.01)]] }, // nicht berührt
  ];
  const sum = summarizeParcels(road, parcels);
  assert.equal(sum.items.length, 2);
  assert.equal(sum.items[0].number, '2');
  assert.ok(sum.items[0].length > 600 && sum.items[1].length > 150);
  assert.equal(sum.key, nodesKey(road.nodes));
  road.parcels = sum;
  assert.ok(validParcels(road));
  const back = deserialize(serialize(doc));
  assert.deepEqual(back.features[0].parcels, sum);
  road.nodes[1] = [47, 8.02];
  assert.equal(validParcels(road), null, 'nach Geometrieänderung veraltet');
  assert.equal(parcelLabel({ number: '12', canton: 'ZH' }), 'Nr. 12 (ZH)');
  assert.equal(parcelLabel({ egrid: 'CH9' }), 'CH9');
  assert.equal(normalizeParcels({ key: 'k', items: [{ length: -3, egrid: 7 }] }).items[0].length, 0);
  assert.equal(normalizeParcels({ key: 'k', items: 'x' }), null);
});
