import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothPolyline, simplifyIndices, circumradius, polylineRadii, smoothRoad, simplifyRoad, smoothZone } from '../js/smooth.js';
import { createDocument, createRoad, createZone } from '../js/model.js';
import { haversine } from '../js/geometry.js';

test('smoothPolyline behält Endpunkte, fügt Zwischenpunkte ein und verfolgt den Ursprungsabschnitt', () => {
  const line = [[47, 8], [47.001, 8.001], [47.001, 8.002], [47.002, 8.003]];
  const out = smoothPolyline(line, 3);
  assert.equal(out.length, 4 + 3 * 3);
  assert.deepEqual(out[0].latlng, line[0]);
  assert.deepEqual(out[out.length - 1].latlng, line[3]);
  assert.equal(out[1].segment, 0);
  assert.equal(out[5].segment, 1);
  assert.deepEqual(out[4].latlng, line[1], 'Originalpunkte bleiben erhalten');
  const two = smoothPolyline([[47, 8], [47.001, 8.001]], 3);
  assert.equal(two.length, 2, 'zwei Punkte werden nicht geglättet');
  const ring = smoothPolyline([[47, 8], [47, 8.01], [47.01, 8.01]], 2, true);
  assert.equal(ring.length, 9, 'geschlossen: n Abschnitte × (1 + k)');
});

test('simplifyIndices entfernt Punkte innerhalb der Toleranz', () => {
  const line = [[47, 8], [47, 8.001], [47.0000005, 8.002], [47, 8.003], [47.001, 8.004]];
  assert.deepEqual(simplifyIndices(line, 1), [0, 3, 4]);
  assert.deepEqual(simplifyIndices(line, 0.001), [0, 1, 2, 3, 4]);
  assert.deepEqual(simplifyIndices([[1, 1], [2, 2]], 5), [0, 1]);
});

test('circumradius und polylineRadii', () => {
  // Punkte auf einem Kreis mit r ≈ 100 m um (47, 8)
  const c = [47, 8];
  const r = 100;
  const at = (deg) => [c[0] + (r * Math.cos((deg * Math.PI) / 180)) / 111320, c[1] + (r * Math.sin((deg * Math.PI) / 180)) / (111320 * Math.cos((47 * Math.PI) / 180))];
  const R = circumradius(at(0), at(30), at(60));
  assert.ok(Math.abs(R - 100) < 2, `Radius ${R}`);
  assert.equal(circumradius([47, 8], [47, 8.001], [47, 8.002]), Infinity, 'Gerade');
  const radii = polylineRadii([at(0), at(30), at(60), at(90)]);
  assert.equal(radii[0], Infinity);
  assert.ok(Math.abs(radii[1] - 100) < 2 && Math.abs(radii[2] - 100) < 2);
  assert.ok(haversine(at(0), at(90)) > 130, 'Testgeometrie plausibel');
});

test('smoothRoad und simplifyRoad übertragen Abschnittseigenschaften', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47.001, 8.001], [47.001, 8.002], [47.002, 8.003]], kind: 'main' });
  road.segments[1].level = 'bridge';
  road.segments[1].maxspeed = 30;
  doc.features.push(road);
  assert.equal(smoothRoad(road, 2), true);
  assert.equal(road.nodes.length, 10);
  assert.equal(road.segments.length, 9);
  assert.deepEqual(road.segments.slice(3, 6).map((s) => s.level), ['bridge', 'bridge', 'bridge']);
  assert.equal(road.segments[4].maxspeed, 30);
  assert.equal(road.segments[0].level, 'ground');
  assert.equal(simplifyRoad(road, 0.01), false, 'nichts innerhalb 1 cm');
  assert.equal(simplifyRoad(road, 3), true);
  assert.ok(road.nodes.length < 10 && road.nodes.length >= 4, `Punkte: ${road.nodes.length}`);
  assert.equal(road.segments.length, road.nodes.length - 1);
  const zone = createZone({ layerId, nodes: [[47, 8], [47, 8.01], [47.01, 8.01]] });
  assert.equal(smoothZone(zone, 2), true);
  assert.equal(zone.nodes.length, 9);
});
