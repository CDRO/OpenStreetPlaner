import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneSpeedAt,
  parseMaxspeed, isDrivable, waySpeed, wayDirection, buildGraph, attachPoint, shortestPath, computeRoutes,
  insertPointsOnLine, formatDuration, keyOf,
} from '../js/routing.js';
import { createDocument, createLayer, createRoad, createRoundabout, createJunction, createZone } from '../js/model.js';
import { project as projectLL } from '../js/geometry.js';

test('parseMaxspeed versteht Zahlen, mph, Zonen und Sonderwerte', () => {
  assert.equal(parseMaxspeed('50'), 50);
  assert.equal(parseMaxspeed('30 mph'), 48);
  assert.equal(parseMaxspeed('CH:urban'), 50);
  assert.equal(parseMaxspeed('DE:rural'), 80);
  assert.equal(parseMaxspeed('walk'), 5);
  assert.equal(parseMaxspeed('none'), null);
  assert.equal(parseMaxspeed(undefined), null);
  assert.equal(parseMaxspeed('abc'), null);
});

test('Befahrbarkeit, Geschwindigkeit und Richtung aus Tags', () => {
  assert.equal(isDrivable({ highway: 'primary' }), true);
  assert.equal(isDrivable({ highway: 'footway' }), false);
  assert.equal(isDrivable({ highway: 'service', access: 'private' }), false);
  assert.equal(isDrivable({}), false);
  assert.equal(waySpeed({ highway: 'residential' }), 50);
  assert.equal(waySpeed({ highway: 'residential', maxspeed: '30' }), 30);
  assert.equal(wayDirection({ oneway: 'yes' }), 1);
  assert.equal(wayDirection({ oneway: '-1' }), -1);
  assert.equal(wayDirection({}), 0);
  assert.equal(formatDuration(190), '3:10 min');
  assert.equal(formatDuration(3660), '1 h 01 min');
});

// Umweg-Netz: A(47,8) -> Ecke (47,8.01) -> B (47.01,8.01). Der Entwurf zieht die Diagonale.
function detourWays() {
  return [
    { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] },
    { id: 2, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8.01], [47.005, 8.01], [47.01, 8.01]] },
    { id: 3, tags: { highway: 'footway' }, geometry: [[47, 8], [47.01, 8.01]] },
  ];
}

test('heute vs. neu: Diagonale verkürzt die Route, Rückbau entfernt OSM-Way', () => {
  const ways = detourWays();
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const from = [47, 8];
  const to = [47.01, 8.01];
  const before = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(before.current && !before.current.error, JSON.stringify(before.current));
  assert.ok(before.proposed && !before.proposed.error);
  assert.ok(Math.abs(before.current.dist - before.proposed.dist) < 1e-6, 'ohne Änderungen identisch');
  assert.ok(before.current.dist > 1800 && before.current.dist < 1900, `Umweg ${before.current.dist}`);

  doc.features.push(createRoad({ layerId, nodes: [from, to], kind: 'main', maxspeed: 50 }));
  const after = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(after.proposed.dist < after.current.dist * 0.8, 'Diagonale ist kürzer');
  assert.ok(after.proposed.time < after.current.time, 'und schneller');
  assert.ok(Math.abs(after.current.dist - before.current.dist) < 1e-6, 'heute unverändert');

  // Rückbau des Ecken-Ways 2: heute weiterhin über die Ecke, neu über die Diagonale
  doc.features.push(createRoad({ layerId, nodes: ways[1].geometry, kind: 'main', status: 'remove', osmId: 2 }));
  const removed = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(!removed.current.error);
  assert.ok(!removed.proposed.error);
  assert.ok(removed.proposed.dist < 1500);

  // Ohne Diagonale und mit Rückbau: kein Weg mehr
  doc.features = doc.features.filter((f) => f.status === 'remove');
  const cut = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(!cut.current.error, 'heute geht es noch');
  assert.ok(cut.proposed.error, 'neu ist unterbrochen');
});

test('Tempolimit wirkt auf die Fahrzeit, Einbahn auf die Richtung', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const from = [47, 8];
  const to = [47, 8.01];
  const fast = createRoad({ layerId, nodes: [from, to], kind: 'main', maxspeed: 80 });
  doc.features.push(fast);
  const r80 = computeRoutes({ osmWays: [], doc, from, to });
  fast.maxspeed = 30;
  const r30 = computeRoutes({ osmWays: [], doc, from, to });
  assert.ok(r30.proposed.time > r80.proposed.time * 2.5, `30er langsamer: ${r30.proposed.time} vs ${r80.proposed.time}`);
  assert.ok(r30.current.error, 'heute gibt es die Strasse nicht');
  fast.oneway = true;
  const back = computeRoutes({ osmWays: [], doc, from: to, to: from });
  assert.ok(back.proposed.error, 'gegen die Einbahn kein Weg');
});

test('Einrasten auf OSM-Abschnitt verbindet das Netz, Kreisel verbinden Anschlüsse, Ampeln kosten Zeit', () => {
  const ways = [{ id: 1, tags: { highway: 'residential' }, geometry: [[47, 8], [47, 8.01]] }];
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  // Neue Strasse startet mitten auf dem OSM-Way (kein OSM-Knoten dort)
  doc.features.push(createRoad({ layerId, nodes: [[47, 8.005], [47.005, 8.005]], kind: 'main' }));
  const r = computeRoutes({ osmWays: ways, doc, from: [47, 8], to: [47.005, 8.005] });
  assert.ok(!r.proposed.error, 'über den geteilten Abschnitt erreichbar');
  assert.ok(r.proposed.dist > 900 && r.proposed.dist < 1000, `Distanz ${r.proposed.dist}`);
  const g = buildGraph({ osmWays: ways, doc, mode: 'proposed' });
  assert.ok(g.nodes.has(keyOf([47, 8.005])), 'Teilungspunkt ist Knoten');

  // Kreisel: zwei Strassen enden auf dem Ring (r = 20 m), keine gemeinsame Koordinate
  const doc2 = createDocument();
  const l2 = doc2.layers[0].id;
  const center = [47.1, 8.1];
  const ringN = [47.1 + 20 / 111320, 8.1];
  const ringS = [47.1 - 20 / 111320, 8.1];
  doc2.features.push(createRoundabout({ layerId: l2, center, radius: 20 }));
  doc2.features.push(createRoad({ layerId: l2, nodes: [[47.105, 8.1], ringN], kind: 'main' }));
  doc2.features.push(createRoad({ layerId: l2, nodes: [ringS, [47.095, 8.1]], kind: 'main' }));
  const rr = computeRoutes({ osmWays: [], doc: doc2, from: [47.105, 8.1], to: [47.095, 8.1] });
  assert.ok(!rr.proposed.error, 'durch den Kreisel verbunden');
  const tNoSignal = rr.proposed.time;
  doc2.features.push(createJunction({ layerId: l2, at: ringN, kind: 'signals' }));
  const rs = computeRoutes({ osmWays: [], doc: doc2, from: [47.105, 8.1], to: [47.095, 8.1] });
  assert.ok(Math.abs(rs.proposed.time - tNoSignal - 20) < 1e-6, 'Ampel kostet 20 s');
});

test('attachPoint findet nur Punkte in Reichweite, insertPointsOnLine hält die Reihenfolge', () => {
  const g = buildGraph({ osmWays: [{ id: 1, tags: { highway: 'primary' }, geometry: [[47, 8], [47, 8.01]] }] });
  assert.equal(attachPoint(g, [48, 9]), null);
  const near = attachPoint(g, [47.0001, 8.005]);
  assert.ok(near && near.distanceMeters > 10 && near.distanceMeters < 12);
  assert.ok(shortestPath(g, near.key, keyOf([47, 8.01])));
  const line = insertPointsOnLine([[47, 8], [47, 8.01]], [[47, 8.008], [47, 8.002], [47.5, 8.5]].map((ll) => ({ ll, p: projectLL(ll) })));
  assert.deepEqual(line, [[47, 8], [47, 8.002], [47, 8.008], [47, 8.01]]);
});


test('Zonen deckeln das Tempo, Fussgängerzonen sperren', () => {
  const ways = [{ id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.01]] }];
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const from = [47, 8];
  const to = [47, 8.01];
  const base = computeRoutes({ osmWays: ways, doc, from, to });
  const zone = createZone({ layerId, nodes: [[46.999, 8.004], [46.999, 8.006], [47.001, 8.006], [47.001, 8.004]], kind: 'tempo30' });
  doc.features.push(zone);
  assert.equal(zoneSpeedAt([zone], [47, 8.005]), 30);
  assert.equal(zoneSpeedAt([zone], [47, 8.001]), null);
  // Der OSM-Way hat keinen Knoten in der Zone; Mittelpunkt des einzigen Abschnitts liegt bei 8.005 -> gedeckelt
  const capped = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(capped.proposed.time > base.proposed.time * 1.5, `Zone verlangsamt: ${capped.proposed.time} vs ${base.proposed.time}`);
  assert.ok(Math.abs(capped.current.time - base.current.time) < 1e-9, 'heute unverändert');
  zone.kind = 'pedestrian';
  const blocked = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(blocked.proposed.error, 'Fussgängerzone sperrt die Strasse');
  zone.kind = 'parking';
  const parking = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(Math.abs(parking.proposed.time - base.proposed.time) < 1e-9, 'Parkplatz ohne Tempolimit');
});

test('Ausgeblendete Ebenen zählen nicht; Abschnitts-Tempolimit wirkt', () => {
  const ways = detourWays();
  const doc = createDocument();
  const variant = createLayer(doc, 'Variante B');
  const from = [47, 8];
  const to = [47.01, 8.01];
  doc.features.push(createRoad({ layerId: variant.id, nodes: [from, to], kind: 'main', maxspeed: 50 }));
  const shown = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(shown.proposed.dist < shown.current.dist * 0.8, 'sichtbar: Abkürzung zählt');
  variant.visible = false;
  const hiddenRes = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(Math.abs(hiddenRes.proposed.dist - hiddenRes.current.dist) < 1e-6, 'ausgeblendet: wie heute');
  variant.visible = true;
  const road = doc.features[0];
  const t50 = computeRoutes({ osmWays: ways, doc, from, to }).proposed.time;
  road.segments[0].maxspeed = 20;
  const r20 = computeRoutes({ osmWays: ways, doc, from, to });
  assert.ok(r20.proposed.time > t50, `Abschnittslimit wirkt: ${r20.proposed.time} vs ${t50}`);
  assert.ok(Math.abs(r20.proposed.dist - r20.current.dist) < 1e-6, 'bei Tempo 20 lohnt sich wieder der Umweg');
});
