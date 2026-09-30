import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneSpeedAt,
  parseMaxspeed, isDrivable, waySpeed, wayDirection, buildGraph, attachPoint, shortestPath, computeRoutes,
  insertPointsOnLine, formatDuration, keyOf, turnKind, TURN_COST, ROUNDABOUT_SPEED,
} from '../js/routing.js';
import { createDocument, createLayer, createRoad, createRoundabout, createJunction, createZone } from '../js/model.js';
import { project as projectLL } from '../js/geometry.js';
import { nodesKey } from '../js/model.js';

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

test('Geometriemodell: Kurven verlangsamen, Steigung aus Profil, Streuband, Ampel-Streuung', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  // Gerade Strasse 1 km, daneben eine kurvige mit gleicher Länge (Zickzack)
  const from = [47, 8];
  const to = [47, 8.0132];
  const straight = createRoad({ layerId, nodes: [from, to], kind: 'main', maxspeed: 80 });
  doc.features.push(straight);
  const limitRes = computeRoutes({ osmWays: [], doc, from, to, model: 'limit' });
  const geoRes = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' });
  assert.ok(Math.abs(limitRes.proposed.time - geoRes.proposed.time) < 1e-6, 'gerade Strasse: Modell ändert Erwartungswert nicht');
  assert.equal(limitRes.proposed.sd, 0);
  assert.ok(geoRes.proposed.sd > 0 && geoRes.proposed.p15 < geoRes.proposed.time && geoRes.proposed.p85 > geoRes.proposed.time, 'Streuband');
  // Enge Kurve einbauen
  straight.nodes = [from, [47.0003, 8.004], [46.9997, 8.0045], [47.0003, 8.005], to];
  straight.segments = straight.nodes.slice(1).map(() => ({ level: 'ground', maxspeed: null }));
  const curvy = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' });
  const curvyLimit = computeRoutes({ osmWays: [], doc, from, to, model: 'limit' });
  assert.ok(curvy.proposed.time > curvyLimit.proposed.time * 1.1, `Kurven kosten Zeit: ${curvy.proposed.time} vs ${curvyLimit.proposed.time}`);
  // Steigung aus Höhenprofil (nur bei passendem Schlüssel)
  straight.nodes = [from, to];
  straight.segments = [{ level: 'ground', maxspeed: null }];
  straight.profile = { points: [[0, 500], [1000, 600]], key: nodesKey(straight.nodes) };
  const steep = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' });
  assert.ok(steep.proposed.time > geoRes.proposed.time * 1.15, `Steigung bremst: ${steep.proposed.time} vs ${geoRes.proposed.time}`);
  straight.profile.key = 'veraltet';
  const stale = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' });
  assert.ok(Math.abs(stale.proposed.time - geoRes.proposed.time) < 1e-6, 'veraltetes Profil wird ignoriert');
  // Ampel an einem Zwischenknoten bringt Erwartungswert und Streuung (Start und Ziel selbst kosten nichts)
  straight.profile = null;
  const mid = [47, 8.0066];
  straight.nodes = [from, mid, to];
  straight.segments = [{ level: 'ground', maxspeed: null }, { level: 'ground', maxspeed: null }];
  const withoutSignal = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' }).proposed;
  doc.features.push(createJunction({ layerId, at: mid, kind: 'signals' }));
  const withSignal = computeRoutes({ osmWays: [], doc, from, to, model: 'geometry' }).proposed;
  assert.ok(Math.abs(withSignal.time - withoutSignal.time - 20) < 1e-6, `Ampel +20 s: ${withSignal.time} vs ${withoutSignal.time}`);
  assert.ok(withSignal.sd > withoutSignal.sd, 'Ampel erhöht die Streuung');
});

// Kreuz: Ost-West-Strasse auf 47° und Nord-Süd-Strasse auf 8.005°, Schnittpunkt (47, 8.005) mit vier Armen.
function crossWays() {
  return [
    { id: 11, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] },
    { id: 12, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47.004, 8.005], [47, 8.005], [46.996, 8.005]] },
  ];
}

test('Abbiegen: Winkelklassen, Linksabbiegen kostet mehr als rechts, geradeaus nichts', () => {
  assert.equal(turnKind([47, 8], [47, 8.001], [47.001, 8.001]), 'left', 'Ost, dann Nord = links');
  assert.equal(turnKind([47, 8], [47, 8.001], [46.999, 8.001]), 'right', 'Ost, dann Süd = rechts');
  assert.equal(turnKind([47, 8], [47, 8.001], [47, 8.002]), 'straight');
  assert.equal(turnKind([47, 8], [47, 8.001], [47, 8]), 'uturn');
  assert.equal(turnKind([47, 8], [47.001, 8], [47.001, 8.001]), 'right', 'Nord, dann Ost = rechts');
  const ways = crossWays();
  const from = [47, 8];
  const straight = computeRoutes({ osmWays: ways, doc: null, from, to: [47, 8.01] }).current;
  const left = computeRoutes({ osmWays: ways, doc: null, from, to: [47.004, 8.005] }).current;
  const right = computeRoutes({ osmWays: ways, doc: null, from, to: [46.996, 8.005] }).current;
  assert.ok(Math.abs(straight.time - straight.dist / (50 / 3.6)) < 1e-6, 'geradeaus ohne Zuschlag');
  assert.ok(Math.abs(left.dist - right.dist) < 1, 'gleich lange Arme');
  assert.ok(Math.abs((left.time - right.time) - (TURN_COST.left.mean - TURN_COST.right.mean)) < 1e-6, `links − rechts = 3 s: ${left.time} vs ${right.time}`);
  assert.ok(Math.abs(right.time - (right.dist / (50 / 3.6) + TURN_COST.right.mean)) < 1e-6, 'rechts = Fahrzeit + 2 s');
  // Zwischenknoten mit zwei Armen: keine Abbiegekosten trotz Knick
  const bent = [{ id: 13, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47.004, 8.005]] }];
  const b = computeRoutes({ osmWays: bent, doc: null, from, to: [47.004, 8.005] }).current;
  assert.ok(Math.abs(b.time - b.dist / (50 / 3.6)) < 1e-6, 'Knick ohne Abzweigung kostet nichts');
});

test('Abbiegeverbot sperrt, Anschluss ist kreuzungsfrei, Kreisel dreht frei', () => {
  const ways = crossWays();
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const from = [47, 8];
  const toNorth = [47.004, 8.005];
  const j = createJunction({ layerId, at: [47, 8.005], kind: 'plain', turns: { left: false } });
  doc.features.push(j);
  const banned = computeRoutes({ osmWays: ways, doc, from, to: toNorth });
  assert.ok(banned.current.path && banned.current.time > 0, 'heute erlaubt');
  // Mit Verbot bleibt nur: geradeaus bis ans Ende, wenden (kostet), zurück und rechts abbiegen
  assert.ok(banned.proposed.path, 'Wenden am Ende der Sackgasse ist erlaubt');
  assert.ok(banned.proposed.dist > banned.current.dist + 700, `Umweg über die Sackgasse (2 × 380 m): ${banned.proposed.dist} vs ${banned.current.dist}`);
  assert.ok(banned.proposed.time > banned.current.time + TURN_COST.uturn.mean, 'Wenden kostet');
  const rightOk = computeRoutes({ osmWays: ways, doc, from, to: [46.996, 8.005] }).proposed;
  assert.ok(rightOk.path && Math.abs(rightOk.dist - banned.current.dist) < 1, 'rechts weiterhin direkt erlaubt');
  // Einbahn nach Osten (kein Zurück) und zusätzlich Geradeaus-Verbot: auch der Trick
  // „rechts, am Ende wenden, zurück und geradeaus“ fällt weg, keine Verbindung
  const noReturn = [{ id: 15, tags: { highway: 'residential', maxspeed: '50', oneway: 'yes' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] }, ways[1]];
  const viaSouth = computeRoutes({ osmWays: noReturn, doc, from, to: toNorth });
  assert.ok(viaSouth.proposed.path && viaSouth.proposed.dist > viaSouth.current.dist + 700, 'rechts, wenden, zurück und geradeaus ist erlaubt');
  j.turns = { left: false, right: true, straight: false, uturn: false };
  const none = computeRoutes({ osmWays: noReturn, doc, from, to: toNorth });
  assert.ok(none.current.path, 'heute erreichbar');
  assert.ok(none.proposed.error, 'mit Linksabbiegeverbot keine Verbindung');
  // Umweg: Verbot zwingt auf eine längere, erlaubte Route
  const loop = ways.concat([{ id: 14, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8.01], [47.004, 8.01], [47.004, 8.005]] }]);
  const detour = computeRoutes({ osmWays: loop, doc, from, to: toNorth });
  assert.ok(detour.proposed.path && detour.proposed.dist > detour.current.dist * 1.5, `Umweg statt Linksabbiegen: ${detour.proposed.dist} vs ${detour.current.dist}`);
  // Anschluss (kreuzungsfrei): keine Abbiegekosten, kein Verbot ausser Wenden
  j.kind = 'interchange';
  j.turns = null;
  const ic = computeRoutes({ osmWays: ways, doc, from, to: toNorth }).proposed;
  assert.ok(Math.abs(ic.time - ic.dist / (50 / 3.6)) < 1e-6, `Anschluss ohne Zuschlag: ${ic.time}`);
  // Kreisel: Drehen kostet nichts über die Kreisel-Verzögerung hinaus
  doc.features = [];
  const ring = createRoundabout({ layerId, center: [47.002, 8.02], radius: 15 });
  doc.features.push(ring);
  const rM = 15 / (111320 * Math.cos((47.002 * Math.PI) / 180));
  const rLat = 15 / 111320;
  doc.features.push(createRoad({ layerId, nodes: [[47.002, 8.015], [47.002, 8.02 - rM]], kind: 'main', maxspeed: 50 }));
  doc.features.push(createRoad({ layerId, nodes: [[47.002 + rLat, 8.02], [47.006, 8.02]], kind: 'main', maxspeed: 50 }));
  const viaRing = computeRoutes({ osmWays: [], doc, from: [47.002, 8.015], to: [47.006, 8.02] }).proposed;
  assert.ok(viaRing.path, 'Kreisel verbindet');
  const expected = viaRing.dist - 30 > 0 ? (viaRing.dist - 30) / (50 / 3.6) + 30 / (ROUNDABOUT_SPEED / 3.6) : 0;
  assert.ok(Math.abs(viaRing.time - expected) < 0.05, `Kreisel ohne Abbiegezuschlag (Rundung der Speichen): ${viaRing.time} vs ${expected}`);
});
