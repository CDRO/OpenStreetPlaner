import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, trailAt, buildRunners, raceDuration, raceSnapshot, suggestedSpeed, formatClock, RACE_SPEEDS } from '../js/race.js';
import { buildGraph, attachPoint, shortestPath, routeOnGraph, computeBusLines, computeRace, buildGraphs } from '../js/routing.js';
import { createDocument, createJunction, createBusLine, createRoad } from '../js/model.js';

const path = [[47, 8], [47, 8.001], [47, 8.003], [47, 8.003], [47, 8.004]];
const times = [0, 10, 30, 50, 60]; // Pause von 20 s am dritten Punkt

test('positionAt interpoliert entlang der Zeitachse, hält an Pausen und klemmt die Enden', () => {
  assert.deepEqual(positionAt(path, times, -5).latlng, [47, 8]);
  assert.deepEqual(positionAt(path, times, 0).latlng, [47, 8]);
  const mid = positionAt(path, times, 5);
  assert.ok(Math.abs(mid.latlng[1] - 8.0005) < 1e-9 && mid.index === 0);
  const p20 = positionAt(path, times, 20);
  assert.ok(Math.abs(p20.latlng[1] - 8.002) < 1e-9, 'zweiter Abschnitt zur Hälfte');
  // Pause: zwischen 30 und 50 s steht das Fahrzeug
  assert.ok(Math.abs(positionAt(path, times, 35).latlng[1] - 8.003) < 1e-9);
  assert.ok(Math.abs(positionAt(path, times, 49).latlng[1] - 8.003) < 1e-9);
  assert.deepEqual(positionAt(path, times, 60).latlng, [47, 8.004]);
  assert.deepEqual(positionAt(path, times, 999).latlng, [47, 8.004]);
  assert.equal(positionAt([], [], 1), null);
  assert.deepEqual(positionAt([[1, 2]], [0], 5).latlng, [1, 2]);
});

test('trailAt liefert die Spur der letzten Sekunden mit interpolierten Enden', () => {
  const tr = trailAt(path, times, 20, 15);
  assert.equal(tr.length, 3, 'Startpunkt (5 s), Pfadpunkt bei 10 s, Endpunkt (20 s)');
  assert.ok(Math.abs(tr[0][1] - 8.0005) < 1e-9 && Math.abs(tr[2][1] - 8.002) < 1e-9);
  assert.deepEqual(trailAt(path, times, 0, 10), []);
  assert.deepEqual(trailAt([[1, 1]], [0], 5), []);
});

test('buildRunners, raceSnapshot und raceDuration: Teilnehmer je Modus, Ränge nach Ankunft', () => {
  const results = {
    car: { current: { path, times, dist: 300 }, proposed: { path: path.slice(0, 3), times: [0, 10, 30], dist: 200 } },
    foot: { current: { error: 'kein Weg' }, proposed: { path: path.slice(0, 2), times: [0, 90], dist: 100 } },
    bike: { current: null, proposed: { path: [[1, 1]], times: [0] } },
  };
  const both = buildRunners(results, { mode: 'both' });
  assert.deepEqual(both.map((r) => r.id), ['car:current', 'car:proposed', 'foot:proposed']);
  assert.equal(both[0].glyph, '🚗');
  assert.equal(buildRunners(results, { mode: 'current' }).length, 1);
  assert.equal(buildRunners(results, { mode: 'proposed' }).length, 2);
  assert.equal(raceDuration(both), 90);
  assert.equal(raceDuration([]), 0);
  const snap = raceSnapshot(both, 45);
  const car = snap.find((r) => r.id === 'car:current');
  assert.ok(!car.finished && car.rank === null && Math.abs(car.progress - 0.75) < 1e-9);
  const neu = snap.find((r) => r.id === 'car:proposed');
  assert.ok(neu.finished && neu.rank === 1 && neu.progress === 1);
  const end = raceSnapshot(both, 100);
  assert.deepEqual(end.map((r) => r.rank), [2, 1, 3]);
  assert.ok(end.every((r) => r.position && r.trail.length >= 0));
});

test('suggestedSpeed und formatClock', () => {
  assert.equal(suggestedSpeed(0), 10);
  assert.equal(suggestedSpeed(45), 1);
  assert.equal(suggestedSpeed(500), 10);
  assert.equal(suggestedSpeed(1500), 30);
  assert.equal(suggestedSpeed(100000), 100);
  assert.ok(RACE_SPEEDS.includes(suggestedSpeed(3000)));
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65.9), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
});

test('Routen-Rechner liefert eine Zeitachse: monoton, Start bei 0, Ende = Fahrzeit', () => {
  const ways = [
    { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] },
    { id: 2, tags: { highway: 'residential', maxspeed: '30' }, geometry: [[47, 8.01], [47, 8.015]] },
  ];
  const g = buildGraph({ osmWays: ways });
  const a = attachPoint(g, [47, 8]);
  const b = attachPoint(g, [47, 8.015]);
  const r = shortestPath(g, a.key, b.key);
  assert.equal(r.times.length, r.path.length);
  assert.equal(r.times[0], 0);
  assert.ok(Math.abs(r.times[r.times.length - 1] - r.time) < 1e-9);
  for (let i = 1; i < r.times.length; i++) assert.ok(r.times[i] >= r.times[i - 1]);
  const ro = routeOnGraph(g, [47.0001, 8], [47.0001, 8.015]);
  assert.equal(ro.times.length, ro.path.length);
  assert.equal(ro.times[0], 0);
  assert.ok(Math.abs(ro.times[ro.times.length - 1] - ro.time) < 1e-9);
  // Alle Verkehrsmittel auf einmal
  const race = computeRace({ osmWays: ways, doc: createDocument(), from: [47, 8], to: [47, 8.015] });
  assert.deepEqual(Object.keys(race), ['car', 'bus', 'bike', 'foot']);
  assert.ok(race.car.current.time < race.bike.current.time && race.bike.current.time < race.foot.current.time);
  assert.ok(race.foot.proposed.times.length === race.foot.proposed.path.length);
  assert.equal(computeRace({ osmWays: ways, doc: createDocument(), from: [47, 8], to: [47, 8.015], vehicles: ['car', 'ufo'] }).ufo, undefined);
});

test('Buslinien: Zeitachse mit Haltezeit als Pause an jeder Zwischenhaltestelle', () => {
  const ways = [{ id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] }];
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const s1 = createJunction({ layerId, at: [47, 8], kind: 'busstop' });
  const s2 = createJunction({ layerId, at: [47, 8.005], kind: 'busstop' });
  const s3 = createJunction({ layerId, at: [47, 8.01], kind: 'busstop' });
  doc.features.push(s1, s2, s3);
  const line = createBusLine(doc, '7');
  line.stops = [s1.id, s2.id, s3.id];
  line.dwell = 20;
  const res = computeBusLines({ osmWays: ways, doc })[0];
  const r = res.proposed;
  assert.equal(r.times.length, r.path.length);
  assert.ok(Math.abs(r.times[r.times.length - 1] - r.time) < 1e-9, 'Ende der Zeitachse = Fahrzeit inkl. Haltezeit');
  // Der Zwischenhalt steht doppelt im Pfad: Ankunft und Abfahrt 20 s später
  const i = r.path.findIndex((p, k) => k > 0 && p[0] === r.path[k - 1][0] && p[1] === r.path[k - 1][1]);
  assert.ok(i > 0, 'Pause gefunden');
  assert.ok(Math.abs(r.times[i] - r.times[i - 1] - 20) < 1e-9);
  assert.ok(Math.abs(r.path[i][1] - 8.005) < 1e-6);
  const g = buildGraphs({ osmWays: ways, doc, vehicle: 'bus' });
  const direct = routeOnGraph(g.proposed, [47, 8], [47, 8.01]);
  assert.ok(Math.abs(r.time - direct.time - 20) < 1e-6, 'Fahrzeit = Direktfahrt + ein Halt');
  // Schlauch-Test: Position während der Pause bleibt an der Haltestelle
  const pos = positionAt(r.path, r.times, r.times[i - 1] + 10);
  assert.ok(Math.abs(pos.latlng[1] - 8.005) < 1e-6);
  // Linie mit nur einem Halt im Netz: keine Pausen, kein Fehler
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.01]], kind: 'main' });
  doc.features.push(road);
  assert.ok(computeBusLines({ osmWays: ways, doc })[0].proposed.times.length > 2);
});
