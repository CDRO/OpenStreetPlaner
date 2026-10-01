import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmLaneSpaces, parkingBalance, SPACE_LENGTH, AREA_PER_SPACE } from '../js/parking.js';
import { createDocument, createRoad, createZone, defaultSection } from '../js/model.js';

test('OSM-Parkstreifen: altes und neues Schema, Ausrichtung, Verbote', () => {
  assert.deepEqual(osmLaneSpaces({ 'parking:lane:both': 'parallel' }, 120), { left: 20, right: 20 });
  assert.deepEqual(osmLaneSpaces({ 'parking:left': 'lane', 'parking:left:orientation': 'perpendicular', 'parking:right': 'no' }, 100), { left: 40, right: 0 });
  assert.deepEqual(osmLaneSpaces({ 'parking:both': 'street_side', 'parking:both:orientation': 'diagonal' }, 90), { left: 20, right: 20 });
  assert.deepEqual(osmLaneSpaces({ 'parking:lane:right': 'no_stopping' }, 100), { left: 0, right: 0 });
  assert.deepEqual(osmLaneSpaces({}, 100), { left: 0, right: 0 });
  assert.equal(SPACE_LENGTH.parallel, 6);
});

test('Bilanz: neue Parkstreifen und Flächen, entfallene aus OSM-Strassen und OSM-Parkplätzen', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  // Übernommene Strasse (rund 121 m) mit OSM-Parkstreifen links, neuer Querschnitt nur rechts -> links −20, rechts +20
  const adopted = createRoad({ layerId, nodes: [[47, 8], [47, 8.0016]], osmId: 11, section: { ...defaultSection('main'), parkLeft: false, parkRight: true } });
  // Rückbau einer OSM-Strasse mit Parkstreifen beidseits
  const removed = createRoad({ layerId, nodes: [[47.001, 8], [47.001, 8.0008]], osmId: 12, status: 'remove' });
  // Neue Strasse mit Parkstreifen beidseits (rund 61 m -> 10 je Seite)
  const fresh = createRoad({ layerId, nodes: [[47.002, 8], [47.002, 8.0008]], section: { ...defaultSection('main'), parkLeft: true, parkRight: true } });
  // Ohne Querschnitt: keine Aussage
  const plain = createRoad({ layerId, nodes: [[47.003, 8], [47.003, 8.0008]], osmId: 13 });
  // Parkfläche 50 × 50 m -> 100 Plätze
  const lot = createZone({ layerId, kind: 'parking', nodes: [[47.01, 8.01], [47.01, 8.01066], [47.01045, 8.01066], [47.01045, 8.01]] });
  // Neue Strasse durch einen OSM-Parkplatz mit capacity 40
  const through = createRoad({ layerId, nodes: [[47.02, 8.02], [47.02, 8.0206]] });
  doc.features.push(adopted, removed, fresh, plain, lot, through);
  const osmWays = [
    { id: 11, tags: { highway: 'residential', 'parking:lane:left': 'parallel' }, geometry: [[47, 8], [47, 8.0016]] },
    { id: 12, tags: { highway: 'residential', 'parking:both': 'lane' }, geometry: [[47.001, 8], [47.001, 8.0008]] },
    { id: 13, tags: { highway: 'residential', 'parking:both': 'lane' }, geometry: [[47.003, 8], [47.003, 8.0008]] },
  ];
  const parkingAreas = [
    { id: 500, tags: { amenity: 'parking', capacity: '40' }, geometry: [[47.0199, 8.0202], [47.0199, 8.0204], [47.0201, 8.0204], [47.0201, 8.0202]] },
    { id: 501, tags: { amenity: 'parking', parking: 'underground' }, geometry: [[47.0199, 8.0202], [47.0199, 8.0204], [47.0201, 8.0204], [47.0201, 8.0202]] },
    { id: 502, tags: { amenity: 'parking' }, geometry: [[47.05, 8.05], [47.05, 8.051], [47.051, 8.051]] },
  ];
  const b = parkingBalance({ doc, osmWays, parkingAreas });
  assert.equal(b.added.lanes, 40, 'rechts an der übernommenen (20) + beidseits neu (10+10)');
  assert.equal(b.removed.lanes, 40, 'links an der übernommenen (20) + Rückbau (10+10)');
  assert.equal(b.added.zones, Math.floor(50 * 50 / AREA_PER_SPACE) >= 95 ? b.added.zones : -1);
  assert.ok(b.added.zones >= 95 && b.added.zones <= 100, `Parkfläche: ${b.added.zones}`);
  assert.equal(b.removed.areas, 40, 'nur der berührte oberirdische Parkplatz mit capacity');
  assert.equal(b.net, b.added.lanes + b.added.zones - b.removed.lanes - b.removed.areas);
  assert.ok(b.items.some((it) => it.what === 'area' && it.osmId === 500) && !b.items.some((it) => it.osmId === 501 || it.osmId === 502));
  assert.ok(!b.items.some((it) => it.featureId === plain.id), 'ohne Querschnitt keine Aussage');
  doc.layers[0].visible = false;
  assert.equal(parkingBalance({ doc, osmWays, parkingAreas }).net, 0, 'ausgeblendete Ebene zählt nicht');
});
