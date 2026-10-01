import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roadSpeed, normalizeMaxspeed, segmentSpeed, roadWidthMeters, splitRoadAtNode, extendRoad, createZone, pointInPolygon, ringArea, insertZoneNode, removeZoneNode, moveFeatureNode, zoneKind,
  createDocument, createLayer, createRoad, createJunction, createRoundabout, splitRoadSegment,
  applySnapSplits, removeRoadNode, normalizeDocument, deserialize, serialize, toGeoJSON, docStats,
  removeLayer, moveLayer, featureLabel,
  ROAD_KINDS, defaultSection, normalizeSection, sectionWidth, sectionBands, sectionSummary, roadMedian, junctionTurns,
  normalizeRoutePairs, normalizeIsochrone,
  normalizeLines, normalizeBusLines, normalizeAccess, segmentAccess, createBusLine, BUS_COLORS, BUS_DWELL_DEFAULT,
  adoptBusRoute, normalizeOsmId, MAX_BUS_LINES,
  translateFeatures, featuresInBounds, shiftLatLng,
  normalizePhases, createPhase, removePhase, featureInPhase, docForPhase, phaseLabel, MAX_PHASES,
  normalizeSchedule,
} from '../js/model.js';
import { haversine } from '../js/geometry.js';

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
  assert.deepEqual(back.route, { from: [47, 8], to: [47, 8.001], vehicle: 'car' });
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

test('Tempolimit pro Abschnitt, Breite in Metern, teilen und verlängern', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const r = createRoad({ layerId, nodes: [[47, 8], [47, 8.001], [47, 8.002], [47, 8.003]], kind: 'main', maxspeed: 50 });
  doc.features.push(r);
  r.segments[1].maxspeed = 30;
  assert.equal(segmentSpeed(r, 0), 50);
  assert.equal(segmentSpeed(r, 1), 30);
  assert.equal(roadWidthMeters(r), 7);
  r.width = 6.5;
  assert.equal(roadWidthMeters(r), 6.5);
  const back = deserialize(serialize(doc));
  assert.equal(back.features[0].segments[1].maxspeed, 30);
  assert.equal(back.features[0].width, 6.5);
  assert.equal(splitRoadAtNode(doc, r.id, 0), null);
  assert.equal(splitRoadAtNode(doc, r.id, 3), null);
  const secondId = splitRoadAtNode(doc, r.id, 2);
  const second = doc.features.find((f) => f.id === secondId);
  assert.deepEqual(r.nodes, [[47, 8], [47, 8.001], [47, 8.002]]);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(second.nodes, [[47, 8.002], [47, 8.003]]);
  assert.equal(second.segments.length, 1);
  assert.equal(second.maxspeed, 50);
  assert.equal(second.width, 6.5);
  assert.equal(doc.features.indexOf(second), 1, 'direkt hinter dem Original');
  r.segments[1].level = 'bridge';
  extendRoad(doc, r.id, [[47, 8.0025], [47, 8.003]], true);
  assert.equal(r.nodes.length, 5);
  assert.deepEqual(r.segments.map((s) => s.level), ['ground', 'bridge', 'bridge', 'bridge']);
  extendRoad(doc, r.id, [[47, 7.999]], false);
  assert.deepEqual(r.nodes[0], [47, 7.999]);
  assert.equal(r.segments[0].level, 'ground');
});

test('Autobahn/Autostrasse, Querschnitte und Abbiegeregeln', () => {
  const mw = ROAD_KINDS.find((k) => k.id === 'motorway');
  const tr = ROAD_KINDS.find((k) => k.id === 'trunk');
  assert.ok(mw && tr && mw.motorOnly && tr.motorOnly);
  assert.equal(roadSpeed({ kind: 'motorway' }), 120);
  assert.equal(roadSpeed({ kind: 'trunk' }), 100);
  assert.equal(roadSpeed({ kind: 'unbekannt' }), 50, 'Rückfall auf Sonstiges');
  assert.equal(featureLabel({ type: 'road', kind: 'motorway', name: '' }), 'Autobahn');
  assert.equal(featureLabel({ type: 'junction', kind: 'interchange', name: '' }), 'Anschluss (kreuzungsfrei)');
  // Standard-Querschnitte: Fahrbahnbreite entspricht widthM, Autobahn hat Mittelstreifen
  for (const k of ROAD_KINDS) assert.equal(sectionWidth(defaultSection(k.id)), k.widthM, `${k.id}: Standardquerschnitt = widthM`);
  assert.equal(roadWidthMeters({ kind: 'motorway', width: null }), 23);
  assert.equal(roadMedian({ kind: 'motorway' }), 3);
  assert.equal(roadMedian({ kind: 'main' }), 0);
  assert.deepEqual(sectionBands(defaultSection('motorway')).map((b) => b.kind), ['shoulder', 'lane', 'lane', 'median', 'lane', 'lane', 'shoulder']);
  // Normalisierung: Raster 0.25 m, Grenzen, Gesamtbreite
  const s = normalizeSection({ lanes: 3, laneWidth: 3.1, walkLeft: true, walkRight: true, walkWidth: 2, bikeRight: true, bikeWidth: 1.5, parkLeft: 'ja' });
  assert.equal(s.laneWidth, 3);
  assert.equal(s.parkLeft, false);
  assert.equal(sectionWidth(s), 14.5);
  assert.deepEqual(sectionBands(s).map((b) => b.kind), ['walk', 'lane', 'lane', 'lane', 'bike', 'walk']);
  assert.ok(sectionSummary(s).includes('3 Fahrstreifen à 3 m') && sectionSummary(s).includes('Velostreifen rechts') && sectionSummary(s).includes('Trottoir beidseitig'));
  assert.equal(normalizeSection({ lanes: 8, laneWidth: 5, median: 10, shoulder: 4, walkLeft: true, walkRight: true, walkWidth: 5 }), null, 'breiter als 60 m');
  assert.equal(normalizeSection(null), null);
  assert.equal(normalizeSection({ lanes: 99, laneWidth: 0.1 }).lanes, 8);
  // Querschnitt setzt sich gegen Breite durch; Serialisierung behält beides
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.001]], kind: 'main', width: 6, section: s });
  doc.features.push(road);
  assert.equal(roadWidthMeters(road), 14.5);
  const j = createJunction({ layerId, at: [47, 8], kind: 'signals', turns: { left: false } });
  const j2 = createJunction({ layerId, at: [47, 8.001] });
  doc.features.push(j, j2);
  assert.deepEqual(j.turns, { left: false, right: true, straight: true, uturn: false });
  assert.equal(j2.turns, null);
  assert.deepEqual(junctionTurns(j2), { left: true, right: true, straight: true, uturn: false });
  const back = deserialize(serialize(doc));
  assert.deepEqual(back.features[0].section, s);
  assert.equal(back.features[0].width, 6);
  assert.deepEqual(back.features[1].turns, { left: false, right: true, straight: true, uturn: false });
  assert.equal(back.features[2].turns, null);
  const unknownKind = deserialize(JSON.stringify({ ...doc, features: [{ ...road, kind: 'autobahn', section: { lanes: 'x' } }] }));
  assert.equal(unknownKind.features[0].kind, 'other');
  assert.equal(unknownKind.features[0].section.lanes, 2, 'unbrauchbare Werte fallen auf die Basis zurück');
  const gj = toGeoJSON(doc);
  assert.ok(gj.features[0].properties.section.includes('Fahrstreifen'));
  assert.equal(gj.features[0].properties.width, 14.5);
  assert.deepEqual(gj.features.find((f) => f.properties.type === 'junction').properties.turns, j.turns);
});

test('Routenpaare und Isochronen-Einstellung werden geprüft und gespeichert', () => {
  const pairs = normalizeRoutePairs([{ id: 'p1', name: 'Schule', from: [47, 8], to: [99, 8] }, { name: 'x'.repeat(80) }, 'kaputt']);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0], { id: 'p1', name: 'Schule', from: [47, 8], to: null, vehicle: 'car' });
  assert.ok(pairs[1].id.startsWith('p_') && pairs[1].name.length === 60);
  assert.deepEqual(normalizeRoutePairs(null), []);
  assert.equal(normalizeRoutePairs(new Array(30).fill({ id: 'a' })).length, 20);
  assert.deepEqual(normalizeIsochrone({ from: [47.1234567, 8], minutes: [15, 5, 5, 'x', 99], mode: 'egal' }), { from: [47.123457, 8], minutes: [5, 15], mode: 'proposed' });
  assert.deepEqual(normalizeIsochrone({ from: [47, 8] }).minutes, [5, 10, 15]);
  assert.equal(normalizeIsochrone({ from: [91, 8] }), null);
  const doc = createDocument();
  doc.routePairs = pairs;
  doc.isochrone = { from: [47, 8], minutes: [10, 20, 30], mode: 'diff' };
  const back = deserialize(serialize(doc));
  assert.deepEqual(back.routePairs, pairs);
  assert.deepEqual(back.isochrone, doc.isochrone);
  assert.deepEqual(createDocument().routePairs, []);
});

test('Bus: Zugang je Strasse/Abschnitt, Liniennummern, Buslinien und Flächen-Freigabe', () => {
  assert.equal(normalizeAccess('bus'), 'bus');
  assert.equal(normalizeAccess('egal', 'all'), 'all');
  assert.deepEqual(normalizeLines([' 12 ', '12', '', 45, 'x'.repeat(20), null]), ['12', '45', 'xxxxxxxxxxxx']);
  assert.equal(normalizeLines(new Array(30).fill(0).map((_, i) => String(i))).length, 10);
  assert.deepEqual(normalizeLines('12'), []);
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.001], [47, 8.002]], access: 'bus' });
  assert.equal(segmentAccess(road, 0), 'bus');
  road.segments[1].access = 'all';
  assert.equal(segmentAccess(road, 1), 'all');
  assert.equal(segmentAccess(createRoad({ layerId, nodes: [[47, 8], [47, 8.001]] }), 0), 'all');
  const stopA = createJunction({ layerId, at: [47, 8], kind: 'busstop', lines: ['12', '12', ' 45 '] });
  const stopB = createJunction({ layerId, at: [47, 8.002], kind: 'busstop' });
  assert.deepEqual(stopA.lines, ['12', '45']);
  assert.deepEqual(stopB.lines, []);
  const zone = createZone({ layerId, nodes: [[47, 8], [47, 8.01], [47.01, 8]], kind: 'pedestrian', busAllowed: true });
  doc.features.push(road, stopA, stopB, zone);
  const line = createBusLine(doc, '12');
  assert.equal(line.name, '12');
  assert.equal(line.color, BUS_COLORS[0]);
  assert.equal(line.dwell, BUS_DWELL_DEFAULT);
  assert.equal(createBusLine(doc).name, '2');
  line.stops.push(stopA.id, stopB.id);
  const lines = normalizeBusLines([{ id: 'kaputt', name: ' Linie 12 lang lang ', color: 'rot', stops: [stopA.id, 'fehlt', 7, stopB.id], dwell: 999 }, 'x', { dwell: 45.4 }], new Set([stopA.id, stopB.id]));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { id: 'kaputt', name: 'Linie 12 lan', color: BUS_COLORS[0], stops: [stopA.id, stopB.id], dwell: BUS_DWELL_DEFAULT, osmId: null, schedule: null });
  assert.ok(lines[1].id.startsWith('b_') && lines[1].dwell === 45 && lines[1].color === BUS_COLORS[1]);
  assert.equal(normalizeBusLines(new Array(30).fill({})).length, 20);
  // Normalisierung über das Dokument: unbekannte Haltestellen fliegen raus, Zugang bleibt, Flächen-Freigabe bleibt
  const raw = JSON.parse(serialize(doc));
  raw.busLines[0].stops.push('gibtsnicht');
  raw.features[0].access = 'egal';
  raw.features[0].segments[0].access = 'bus';
  const back = normalizeDocument(raw);
  assert.deepEqual(back.busLines[0].stops, [stopA.id, stopB.id]);
  assert.equal(back.features[0].access, 'all');
  assert.equal(segmentAccess(back.features[0], 0), 'bus');
  assert.equal(segmentAccess(back.features[0], 1), 'all');
  assert.deepEqual(back.features[1].lines, ['12', '45']);
  assert.equal(back.features[3].busAllowed, true);
  assert.deepEqual(deserialize(serialize(back)).busLines, back.busLines);
  assert.deepEqual(createDocument().busLines, []);
  const gj = toGeoJSON(back);
  assert.equal(gj.features.find((f) => f.properties.id === stopA.id).properties.lines.join(','), '12,45');
});

test('OSM-Buslinie übernehmen: Haltestellen mit osmId wiederverwenden, Nummer, Farbe, Grenzen', () => {
  assert.equal(normalizeOsmId(42), 42);
  assert.equal(normalizeOsmId(42, 'signals'), null);
  assert.equal(normalizeOsmId(-1), null);
  assert.equal(normalizeOsmId('42'), null);
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const existing = createJunction({ layerId, at: [47, 8.01], kind: 'busstop', name: 'Post', lines: ['7'], osmId: 2 });
  doc.features.push(existing);
  assert.equal(createJunction({ layerId, at: [47, 8], kind: 'signals', osmId: 9 }).osmId, null, 'nur Haltestellen tragen eine OSM-Kennung');
  const route = {
    id: 100, ref: '12', name: 'Bus 12: Dorf – Post', colour: '#FF0000',
    stops: [{ id: 1, name: 'Dorf', at: [47, 8] }, { id: 2, name: 'Post', at: [47, 8.01] }, { id: 2, name: 'Post', at: [47, 8.01] }, { id: 3, name: 'kaputt', at: [99, 8] }, { id: 4, name: 'Bahnhof', at: [47.01, 8.01] }],
  };
  const line = adoptBusRoute(doc, route, layerId);
  assert.ok(line && line.name === '12' && line.color === '#ff0000' && line.osmId === 100, JSON.stringify(line));
  const stops = doc.features.filter((f) => f.kind === 'busstop');
  assert.equal(stops.length, 3, 'Post wiederverwendet, Dorf und Bahnhof neu, ungültige Position übersprungen');
  assert.deepEqual(line.stops, [stops[1].id, existing.id, stops[2].id]);
  assert.deepEqual(existing.lines, ['7', '12']);
  assert.deepEqual(stops[1].lines, ['12']);
  assert.equal(stops[1].osmId, 1);
  assert.equal(stops[1].name, 'Dorf');
  assert.equal(adoptBusRoute(doc, route, layerId), null, 'dieselbe Relation nicht zweimal');
  assert.equal(adoptBusRoute(doc, { id: 101, ref: '7', stops: [{ id: 2, at: [47, 8.01] }] }, layerId), null, 'zu wenig Haltestellen');
  const noRef = adoptBusRoute(doc, { id: 102, name: 'Ortsbus Musterhausen', stops: route.stops.slice(0, 2) }, layerId);
  assert.ok(noRef && noRef.name === 'Ortsbus Must' && noRef.osmId === 102 && noRef.color === BUS_COLORS[1]);
  assert.equal(doc.features.filter((f) => f.kind === 'busstop').length, 3, 'keine neuen Haltestellen für bekannte Knoten');
  // Normalisierung und Serialisierung behalten die OSM-Bezüge
  const back = deserialize(serialize(doc));
  assert.equal(back.busLines[0].osmId, 100);
  assert.equal(back.features.find((f) => f.osmId === 1).name, 'Dorf');
  assert.equal(normalizeBusLines([{ osmId: 5 }, { osmId: 'x' }])[1].osmId, null);
  assert.equal(toGeoJSON(back).features.find((f) => f.properties.id === existing.id).properties.osmId, 2);
  for (let i = doc.busLines.length; i < MAX_BUS_LINES; i++) createBusLine(doc);
  assert.equal(adoptBusRoute(doc, { id: 200, ref: '1', stops: route.stops.slice(0, 2) }, layerId), null, 'Grenze von 20 Linien');
});

test('Mehrfachauswahl: gemeinsam verschieben hält die Form, Rahmen findet Elemente sichtbarer Ebenen', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47.001, 8.002], [47.002, 8.002]] });
  const stop = createJunction({ layerId, at: [47, 8], kind: 'busstop' });
  const ring = createRoundabout({ layerId, center: [47.002, 8.002], radius: 12 });
  const zone = createZone({ layerId, nodes: [[47.01, 8.01], [47.01, 8.02], [47.02, 8.02]] });
  doc.features.push(road, stop, ring, zone);
  const before = [haversine(road.nodes[0], road.nodes[1]), haversine(road.nodes[1], road.nodes[2])];
  const moved = shiftLatLng([47, 8], 50, -30);
  translateFeatures(doc, [road.id, stop.id, ring.id, 'fehlt'], 50, -30);
  assert.deepEqual(road.nodes[0], moved);
  assert.deepEqual(stop.at, moved, 'Punkt und Strassenanfang bleiben zusammen');
  assert.ok(Math.abs(haversine(road.nodes[0], road.nodes[1]) - before[0]) < 0.05 && Math.abs(haversine(road.nodes[1], road.nodes[2]) - before[1]) < 0.05, 'Form bleibt');
  assert.deepEqual(ring.center, road.nodes[2]);
  assert.deepEqual(zone.nodes[0], [47.01, 8.01], 'nicht ausgewählt bleibt');
  const ids = featuresInBounds(doc, { south: 46.999, north: 47.0015, west: 7.999, east: 8.0025 });
  assert.ok(ids.includes(road.id) && ids.includes(stop.id) && !ids.includes(zone.id), JSON.stringify(ids));
  assert.deepEqual(featuresInBounds(doc, { north: 46.999, south: 47.0015, east: 7.999, west: 8.0025 }), ids, 'Rahmen in beliebiger Richtung');
  doc.layers[0].visible = false;
  assert.deepEqual(featuresInBounds(doc, { south: 46, north: 48, west: 7, east: 9 }), [], 'ausgeblendete Ebene zählt nicht');
});

test('Etappen: anlegen, prüfen, Zustand „bis Etappe“, löschen, Serialisierung', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const e1 = createPhase(doc, 'Erste', 2027);
  const e2 = createPhase(doc, '', 'x');
  assert.ok(e1 && e2 && e2.name === 'Etappe 2' && e2.year === null);
  assert.equal(phaseLabel(e1, 0), 'Erste (2027)');
  assert.equal(phaseLabel({ id: 'z', name: '', year: null }, 2), 'Etappe 3');
  const r1 = createRoad({ layerId, nodes: [[47, 8], [47, 8.001]] });
  const r2 = createRoad({ layerId, nodes: [[47, 8], [47, 8.002]] });
  const r3 = createRoad({ layerId, nodes: [[47, 8], [47, 8.003]] });
  r1.phase = e1.id;
  r2.phase = e2.id;
  doc.features.push(r1, r2, r3);
  assert.ok(featureInPhase(doc, r1, e1.id) && !featureInPhase(doc, r2, e1.id) && featureInPhase(doc, r3, e1.id));
  assert.ok(featureInPhase(doc, r2, e2.id) && featureInPhase(doc, r2, null));
  assert.deepEqual(docForPhase(doc, e1.id).features.map((f) => f.id), [r1.id, r3.id]);
  assert.equal(docForPhase(doc, null), doc);
  assert.deepEqual(normalizePhases([{ id: 'a', name: ' Lang '.repeat(20), year: 2030 }, { id: 'a', year: 1800 }, 'x', { year: '2040' }]).map((p) => [p.id.length > 0, p.name.length, p.year]), [[true, 40, 2030], [true, 0, null], [true, 0, 2040]]);
  assert.equal(normalizePhases(new Array(20).fill({})).length, MAX_PHASES);
  const back = deserialize(serialize(doc));
  assert.equal(back.phases.length, 2);
  assert.equal(back.features[0].phase, e1.id);
  const raw = JSON.parse(serialize(doc));
  raw.features[1].phase = 'gibtsnicht';
  assert.equal(normalizeDocument(raw).features[1].phase, null, 'unbekannte Etappe fällt weg');
  removePhase(doc, e1.id);
  assert.equal(doc.phases.length, 1);
  assert.equal(r1.phase, null, 'Elemente der gelöschten Etappe gehören wieder zu allen');
  for (let i = doc.phases.length; i < MAX_PHASES; i++) createPhase(doc);
  assert.equal(createPhase(doc), null, 'Grenze');
  assert.equal(toGeoJSON(doc).features.find((f) => f.properties.id === r2.id).properties.phase, 'Etappe 2');
});

test('Fahrplan-Abgleich einer Buslinie wird geprüft und gespeichert', () => {
  assert.deepEqual(normalizeSchedule({ seconds: 840.4, trips: 5, at: '2026-10-01T06:00:00Z', from: 'Dorf', to: 'Bahnhof' }), { seconds: 840, trips: 5, at: '2026-10-01T06:00:00Z', from: 'Dorf', to: 'Bahnhof' });
  assert.equal(normalizeSchedule({ seconds: 0 }), null);
  assert.equal(normalizeSchedule('x'), null);
  assert.equal(normalizeSchedule({ seconds: 100, trips: 500 }).trips, 99);
  assert.equal(normalizeSchedule({ seconds: 100 }).trips, 1);
  const doc = createDocument();
  const line = createBusLine(doc, '12');
  assert.equal(line.schedule, null);
  line.schedule = { seconds: 900, trips: 3, at: 'x', from: 'A', to: 'B' };
  assert.deepEqual(deserialize(serialize(doc)).busLines[0].schedule, line.schedule);
});
