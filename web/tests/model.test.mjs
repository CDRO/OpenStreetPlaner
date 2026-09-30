import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roadSpeed, normalizeMaxspeed, createZone, pointInPolygon, ringArea, insertZoneNode, removeZoneNode, moveFeatureNode, zoneKind,
  createDocument, createLayer, createRoad, createJunction, createRoundabout, splitRoadSegment,
  applySnapSplits, removeRoadNode, normalizeDocument, deserialize, serialize, toGeoJSON, docStats,
  removeLayer, moveLayer, featureLabel,
} from '../js/model.js';

function docWithRoad() {
  const doc = createDocument({ name: 'Test' });
  const road = createRoad({ layerId: doc.layers[0].id, nodes: [[47, 8], [47, 8.001], [47, 8.002]], level: 'bridge' });
  doc.features.push(road);
  return { doc, road };
}

test('createDocument hat eine Ebene und gültige Metadaten', () => {
  const doc = createDocument();
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.version, 1);
  assert.ok(doc.id.startsWith('d_'));
});

test('splitRoadSegment fügt Knoten ein und vererbt Abschnittsattribute', () => {
  const { doc, road } = docWithRoad();
  road.segments[1].level = 'tunnel';
  const idx = splitRoadSegment(doc, road.id, 1, [47.0000004, 8.0015]);
  assert.equal(idx, 2);
  assert.equal(road.nodes.length, 4);
  assert.deepEqual(road.nodes[2], [47, 8.0015]);
  assert.deepEqual(road.segments.map((s) => s.level), ['bridge', 'tunnel', 'tunnel']);
  assert.throws(() => splitRoadSegment(doc, road.id, 9, [0, 0]));
});

test('applySnapSplits verarbeitet mehrere Teilungen derselben Strasse indexstabil', () => {
  const { doc, road } = docWithRoad();
  const snap = (index, t) => ({ kind: 'segment', t, ref: { source: 'draft', type: 'road', featureId: road.id, index } });
  const vertices = [
    { latlng: [47, 8.0002], snap: snap(0, 0.2) },
    { latlng: [47, 8.0018], snap: snap(1, 0.8) },
    { latlng: [47, 8.0006], snap: snap(0, 0.6) },
    { latlng: [47.1, 8.1], snap: null },
    { latlng: [47.1, 8.1], snap: { kind: 'segment', t: 0.5, ref: { source: 'osm', wayId: 1, index: 0 } } },
  ];
  const n = applySnapSplits(doc, vertices);
  assert.equal(n, 3);
  assert.deepEqual(road.nodes.map((p) => p[1]), [8, 8.0002, 8.0006, 8.001, 8.0018, 8.002]);
  assert.equal(road.segments.length, 5);
});

test('removeRoadNode lässt mindestens zwei Knoten übrig', () => {
  const { doc, road } = docWithRoad();
  assert.equal(removeRoadNode(doc, road.id, 0), true);
  assert.equal(road.nodes.length, 2);
  assert.equal(road.segments.length, 1);
  assert.equal(removeRoadNode(doc, road.id, 0), false);
});

test('normalizeDocument ergänzt Defaults und verwirft Ungültiges', () => {
  const layers = [{ id: 'l1', name: 'A' }];
  const ok = normalizeDocument({ layers, features: [{ id: 'r1', type: 'road', layerId: 'zzz', nodes: [[1, 2], [3, 4]], kind: 'weird' }] });
  assert.equal(ok.features[0].layerId, 'l1');
  assert.equal(ok.features[0].kind, 'other');
  assert.equal(ok.features[0].segments.length, 1);
  assert.equal(ok.features[0].segments[0].level, 'ground');
  assert.equal(ok.name, 'Unbenannter Entwurf');
  assert.throws(() => normalizeDocument({ layers, features: [{ id: 'x', type: 'road', nodes: [[1, 2]] }] }));
  assert.throws(() => normalizeDocument({ layers, features: [{ id: 'x', type: 'ufo' }] }));
  assert.throws(() => normalizeDocument({ layers, version: 99 }));
  assert.throws(() => normalizeDocument('nope'));
  assert.throws(() => deserialize('{not json'));
});

test('serialize/deserialize ist verlustfrei', () => {
  const doc = createDocument({ name: 'Rund' });
  const layerId = doc.layers[0].id;
  doc.features.push(createRoad({ layerId, nodes: [[47, 8], [47.001, 8.001]] }));
  doc.features.push(createJunction({ layerId, at: [47, 8], kind: 'signals' }));
  doc.features.push(createRoundabout({ layerId, center: [47.001, 8.001], radius: 12.34 }));
  const back = deserialize(serialize(doc));
  assert.deepEqual(back, doc);
});

test('toGeoJSON exportiert Abschnitte, Punkte und Kreisel-Polygone', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  doc.features.push(createRoad({ layerId, nodes: [[47, 8], [47, 8.001], [47, 8.002]] }));
  doc.features.push(createJunction({ layerId, at: [47, 8] }));
  doc.features.push(createRoundabout({ layerId, center: [47, 8.002], radius: 10 }));
  const gj = toGeoJSON(doc);
  assert.equal(gj.type, 'FeatureCollection');
  assert.equal(gj.features.length, 4);
  assert.equal(gj.features[0].geometry.type, 'LineString');
  assert.deepEqual(gj.features[0].geometry.coordinates[0], [8, 47]);
  assert.equal(gj.features[2].geometry.type, 'Point');
  assert.equal(gj.features[3].geometry.type, 'Polygon');
  const stats = docStats(doc);
  assert.equal(stats.roads, 1);
  assert.equal(stats.junctions, 1);
  assert.equal(stats.roundabouts, 1);
  assert.ok(stats.lengthMeters > 150 && stats.lengthMeters < 153);
});

test('Ebenen: löschen entfernt Elemente, verschieben ändert Reihenfolge', () => {
  const doc = createDocument();
  const l2 = createLayer(doc, 'Zwei');
  doc.features.push(createJunction({ layerId: l2.id, at: [1, 1] }));
  moveLayer(doc, l2.id, -1);
  assert.equal(doc.layers[0].id, l2.id);
  moveLayer(doc, l2.id, -1);
  assert.equal(doc.layers[0].id, l2.id);
  removeLayer(doc, l2.id);
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.features.length, 0);
});

test('featureLabel fällt auf den Typ zurück', () => {
  assert.equal(featureLabel({ type: 'road', kind: 'main', name: '' }), 'Hauptstrasse');
  assert.equal(featureLabel({ type: 'road', kind: 'main', name: 'Dorfstrasse' }), 'Dorfstrasse');
  assert.equal(featureLabel({ type: 'roundabout' }), 'Kreisel');
});

test('Tempolimit: Normalisierung, Standard je Typ, Route im Dokument', () => {
  assert.equal(normalizeMaxspeed('49.6'), 50);
  assert.equal(normalizeMaxspeed(-3), null);
  assert.equal(normalizeMaxspeed('abc'), null);
  assert.equal(normalizeMaxspeed(500), null);
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const r = createRoad({ layerId, nodes: [[47, 8], [47, 8.001]], kind: 'residential', osmId: 4242 });
  assert.equal(r.maxspeed, null);
  assert.equal(roadSpeed(r), 30, 'Quartierstrasse Standard 30');
  r.maxspeed = 20;
  assert.equal(roadSpeed(r), 20);
  assert.equal(roadSpeed({ kind: 'path', maxspeed: null }), 0, 'Fussweg nicht befahrbar');
  doc.features.push(r);
  doc.route = { from: [47, 8], to: [47.0000004, 8.001] };
  const back = deserialize(serialize(doc));
  assert.equal(back.features[0].osmId, 4242);
  assert.equal(back.features[0].maxspeed, 20);
  assert.deepEqual(back.route, { from: [47, 8], to: [47, 8.001] });
  const noRoute = normalizeDocument({ layers: [{ id: 'l1' }], route: { from: [99, 0], to: [0, 0] } });
  assert.equal(noRoute.route, null);
});

test('Zonen: anlegen, Punkt-in-Polygon, Punkte einfügen/entfernen, GeoJSON, Normalisierung', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const z = createZone({ layerId, nodes: [[47, 8], [47, 8.01], [47.01, 8.01], [47.01, 8]], kind: 'tempo30' });
  doc.features.push(z);
  assert.equal(zoneKind(z).speed, 30);
  assert.equal(pointInPolygon([47.005, 8.005], z.nodes), true);
  assert.equal(pointInPolygon([47.02, 8.005], z.nodes), false);
  assert.ok(ringArea(z.nodes) > 0.00009 && ringArea(z.nodes) < 0.00011);
  assert.equal(insertZoneNode(doc, z.id, 3, [47.005, 8]), 4, 'Zwischenpunkt auf der Schlusskante wird angehängt');
  assert.equal(z.nodes.length, 5);
  moveFeatureNode(doc, z.id, 4, [47.0049999, 8.0000004]);
  assert.deepEqual(z.nodes[4], [47.005, 8]);
  assert.equal(removeZoneNode(doc, z.id, 4), true);
  assert.equal(removeZoneNode(doc, z.id, 0), true);
  assert.equal(removeZoneNode(doc, z.id, 0), false, 'drei Punkte bleiben');
  const gj = toGeoJSON(doc);
  assert.equal(gj.features[0].geometry.type, 'Polygon');
  assert.equal(gj.features[0].geometry.coordinates[0].length, 4, 'Ring geschlossen');
  assert.equal(gj.features[0].properties.speed, 30);
  assert.equal(docStats(doc).zones, 1);
  const back = deserialize(serialize(doc));
  assert.deepEqual(back.features[0], z);
  assert.throws(() => normalizeDocument({ layers: [{ id: 'l1' }], features: [{ id: 'z', type: 'zone', nodes: [[1, 1], [2, 2]] }] }));
  const other = normalizeDocument({ layers: [{ id: 'l1' }], features: [{ id: 'z', type: 'zone', kind: 'weird', nodes: [[1, 1], [2, 2], [3, 1]] }] });
  assert.equal(other.features[0].kind, 'other');
  assert.equal(featureLabel({ type: 'zone', kind: 'pedestrian' }), 'Fussgängerzone');
  assert.equal(featureLabel({ type: 'junction', kind: 'crossing', name: '' }), 'Fussgängerstreifen');
});
