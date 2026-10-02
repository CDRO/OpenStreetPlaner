import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionRings, mergeZones, mergeRoads, mergeFeatures, mergeKind, joinRoad } from '../js/merge.js';
import { createDocument, createRoad, createZone, createJunction, pointInPolygon, ringArea } from '../js/model.js';

const sq = (lat, lng, d) => [[lat, lng], [lat, lng + d], [lat + d, lng + d], [lat + d, lng]];

test('unionRings: überlappende Quadrate ergeben einen Ring mit der Vereinigungsfläche', () => {
  const a = sq(47, 8, 0.002);
  const b = sq(47.001, 8.001, 0.002);
  const u = unionRings([a, b]);
  assert.ok(u && u.length >= 8 && u.length <= 10, `Ecken: ${u && u.length}`);
  const area = ringArea(u);
  assert.ok(Math.abs(area - (2 * 0.002 * 0.002 - 0.001 * 0.001)) < 1e-9, `Fläche ${area}`);
  // Punkte beider Quadrate liegen drin, die Lücke daneben nicht
  assert.ok(pointInPolygon([47.0005, 8.0005], u) && pointInPolygon([47.0025, 8.0025], u) && pointInPolygon([47.0015, 8.0015], u));
  assert.ok(!pointInPolygon([47.0025, 8.0005], u) && !pointInPolygon([47.0005, 8.0025], u));
});

test('unionRings: aneinanderliegende Flächen mit gemeinsamer Kante verschmelzen zum Rechteck', () => {
  const a = sq(47, 8, 0.002);
  const b = sq(47, 8.002, 0.002);
  const u = unionRings([a, b]);
  assert.ok(u && u.length === 4, `Rechteck mit 4 Ecken: ${u && u.length} (${JSON.stringify(u)})`);
  assert.ok(Math.abs(ringArea(u) - 2 * 0.002 * 0.002) < 1e-9);
  // Teilweise gemeinsame Kante (b kürzer): Ergebnis sechs Ecken
  const c = [[47, 8.002], [47, 8.003], [47.001, 8.003], [47.001, 8.002]];
  const u2 = unionRings([a, c]);
  assert.ok(u2 && u2.length === 6, `Ecken: ${u2 && u2.length}`);
  assert.ok(Math.abs(ringArea(u2) - (0.002 * 0.002 + 0.001 * 0.001)) < 1e-9);
});

test('unionRings: getrennte Flächen lassen sich nicht vereinigen, drei Flächen schon, Loch fällt weg', () => {
  assert.equal(unionRings([sq(47, 8, 0.001), sq(47.01, 8.01, 0.001)]), null);
  const u3 = unionRings([sq(47, 8, 0.002), sq(47, 8.0015, 0.002), sq(47.0015, 8.003, 0.002)]);
  assert.ok(u3 && pointInPolygon([47.0005, 8.0005], u3) && pointInPolygon([47.003, 8.004], u3));
  // Ring um ein Loch: Vereinigung der vier Seitenstücke, das Loch in der Mitte wird gefüllt
  const parts = [[[47, 8], [47, 8.003], [47.001, 8.003], [47.001, 8]], [[47.002, 8], [47.002, 8.003], [47.003, 8.003], [47.003, 8]], [[47, 8], [47, 8.001], [47.003, 8.001], [47.003, 8]], [[47, 8.002], [47, 8.003], [47.003, 8.003], [47.003, 8.002]]];
  const ring = unionRings(parts);
  assert.ok(ring && ring.length === 4 && pointInPolygon([47.0015, 8.0015], ring), 'Loch gefüllt');
  assert.equal(unionRings([sq(47, 8, 0.001)]).length, 4, 'eine Fläche bleibt');
});

test('mergeZones ersetzt die Auswahl durch eine Fläche mit den Eigenschaften der ersten', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const z1 = createZone({ layerId, nodes: sq(47, 8, 0.002), kind: 'tempo30', name: 'West' });
  const z2 = createZone({ layerId, nodes: sq(47, 8.002, 0.002), kind: 'pedestrian', name: 'Ost' });
  const j = createJunction({ layerId, at: [47, 8] });
  doc.features.push(z1, z2, j);
  assert.equal(mergeKind(doc, [z1.id, z2.id]), 'zone');
  assert.equal(mergeKind(doc, [z1.id, j.id]), null);
  const res = mergeFeatures(doc, [z1.id, z2.id]);
  assert.deepEqual(res, { id: z1.id, type: 'zone' });
  assert.equal(doc.features.length, 2);
  const z = doc.features.find((f) => f.id === z1.id);
  assert.equal(z.kind, 'tempo30');
  assert.equal(z.name, 'West');
  assert.equal(z.nodes.length, 4);
  assert.throws(() => mergeZones(doc, [z1.id]), /zwei Flächen/);
  const far = createZone({ layerId, nodes: sq(47.1, 8.1, 0.001) });
  doc.features.push(far);
  assert.throws(() => mergeFeatures(doc, [z1.id, far.id]), /berühren/);
  assert.throws(() => mergeFeatures(doc, [z1.id, j.id]), /Nur Flächen/);
});

test('joinRoad und mergeRoads: Enden erkennen, umdrehen, Lücke schliessen, Einbahn und Abschnitte', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const a = createRoad({ layerId, nodes: [[47, 8], [47, 8.001]], kind: 'main', name: 'A', oneway: true });
  a.segments[0].level = 'bridge';
  // b beginnt am Ende von a, aber in Gegenrichtung gezeichnet
  const b = createRoad({ layerId, nodes: [[47, 8.002], [47, 8.001]], kind: 'main', oneway: true });
  b.segments[0].level = 'tunnel';
  // c hängt mit 5 m Lücke vor dem Anfang von a
  const c = createRoad({ layerId, nodes: [[47, 7.999], [47, 7.99995]], kind: 'residential' });
  const far = createRoad({ layerId, nodes: [[47.01, 8], [47.01, 8.001]] });
  doc.features.push(a, b, c, far);
  assert.equal(mergeKind(doc, [a.id, b.id, c.id]), 'road');
  assert.equal(mergeRoads(doc, [a.id, b.id, c.id]), a.id);
  const r = doc.features.find((f) => f.id === a.id);
  assert.deepEqual(r.nodes, [[47, 7.999], [47, 7.99995], [47, 8], [47, 8.001], [47, 8.002]]);
  assert.equal(r.segments.length, 4);
  assert.deepEqual(r.segments.map((s) => s.level), ['ground', 'ground', 'bridge', 'tunnel'], 'Lücke als Abschnitt, Abschnitte folgen der neuen Reihenfolge');
  assert.equal(r.oneway, false, 'b war entgegengesetzt gerichtet: keine Einbahn mehr');
  assert.equal(r.name, 'A');
  assert.equal(doc.features.length, 2);
  assert.throws(() => mergeRoads(doc, [a.id, far.id]), /hängen an den Enden nicht/);
  // Zwei gleich gerichtete Einbahnen bleiben Einbahn
  const d1 = createRoad({ layerId, nodes: [[47.02, 8], [47.02, 8.001]], oneway: true });
  const d2 = createRoad({ layerId, nodes: [[47.02, 8.001], [47.02, 8.002]], oneway: true });
  assert.equal(joinRoad(d1, d2), true);
  assert.equal(d1.oneway, true);
  assert.equal(d1.nodes.length, 3);
});
