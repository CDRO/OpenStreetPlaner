import { test } from 'node:test';
import assert from 'node:assert/strict';
import { travelTimeConfidence, transitRouteConfidence, costConfidence, staticConfidence, confidenceText, mergeQuality, CONFIDENCE_LEVELS } from '../js/confidence.js';
import { createDocument, createRoad, BUS_DWELL_DEFAULT } from '../js/model.js';

const q = (dist, assumedDist = 0, extra = {}) => ({ quality: { dist, assumedDist, draftDist: 0, noProfileDist: 0, model: 'geometry', ...extra } });

test('Fahrzeiten: geschätztes Tempo, Netz, Modell und Höhenprofil bestimmen die Stufe', () => {
  assert.equal(CONFIDENCE_LEVELS.map((l) => l.id).join(','), 'high,medium,low');
  const high = travelTimeConfidence(q(1000, 100));
  assert.equal(high.level, 'high');
  assert.ok(high.reasons.some((r) => r.startsWith('10 % der Strecke mit geschätztem Tempo')) && high.reasons.some((r) => r.includes('Ampeln')), JSON.stringify(high));
  assert.equal(travelTimeConfidence(q(1000, 300)).level, 'medium');
  assert.equal(travelTimeConfidence(q(1000, 600)).level, 'low');
  assert.equal(travelTimeConfidence(q(1000, 0), { networkLoading: true }).level, 'low');
  const limit = travelTimeConfidence(q(1000, 0, { model: 'limit' }));
  assert.equal(limit.level, 'medium');
  assert.ok(limit.reasons.some((r) => r.startsWith('Tempolimit-Modell')));
  const noProfile = travelTimeConfidence(q(1000, 0, { noProfileDist: 700 }));
  assert.equal(noProfile.level, 'medium');
  assert.ok(noProfile.reasons.some((r) => r.includes('70 % der Strecke (kein Höhenprofil)')));
  assert.equal(travelTimeConfidence(q(1000, 0, { noProfileDist: 300 })).level, 'high');
  // heute + neu zusammen: Anteile über beide Strecken
  const both = travelTimeConfidence([q(1000, 0), q(1000, 800)]);
  assert.equal(both.level, 'medium', '40 % über beide');
  assert.deepEqual(mergeQuality([q(1000, 0), { error: 'x' }, null, q(500, 100, { draftDist: 500 })]), { dist: 1500, assumedDist: 100, draftDist: 500, noProfileDist: 0, model: 'geometry', vehicle: null });
  assert.ok(travelTimeConfidence(q(1000, 0, { draftDist: 400 })).reasons.some((r) => r.startsWith('40 % der Strecke auf gezeichneten Strassen')));
  assert.equal(travelTimeConfidence(null), null);
  assert.equal(travelTimeConfidence({ error: 'keine Verbindung' }), null);
  const dwell = travelTimeConfidence(q(1000, 0), { dwell: BUS_DWELL_DEFAULT });
  assert.ok(dwell.reasons.some((r) => r.includes('Haltezeit')) && dwell.level === 'high');
  assert.ok(!travelTimeConfidence(q(1000, 0), { dwell: 30 }).reasons.some((r) => r.includes('Haltezeit')));
});

test('OSM-Linien: Haltepositionen hoch, Plattformen mittel, ohne Rollen tief, ohne Nummer höchstens mittel', () => {
  assert.equal(transitRouteConfidence({ source: 'stop', ref: '12', name: 'Bus 12' }).level, 'high');
  assert.equal(transitRouteConfidence({ source: 'platform', ref: '12', name: 'x' }).level, 'medium');
  assert.equal(transitRouteConfidence({ source: 'plain', ref: '12', name: 'x' }).level, 'low');
  const noRef = transitRouteConfidence({ source: 'stop', ref: '', name: '' });
  assert.equal(noRef.level, 'medium');
  assert.ok(noRef.reasons.includes('Ohne Liniennummer in OSM') && noRef.reasons.includes('Ohne Namen in OSM'));
  assert.equal(transitRouteConfidence(null), null);
});

test('Kosten: Standardwerte ±40 %, eigene Ansätze ±25 %, unbekannte Breite und Brücken senken', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.01]], kind: 'main', width: 7 });
  doc.features.push(road);
  let c = costConfidence(doc);
  assert.equal(c.level, 'medium');
  assert.equal(c.band, 40);
  assert.ok(c.reasons.some((r) => r.startsWith('Alle Einheitskosten')));
  doc.costs = { 'road.main': 2500000 };
  c = costConfidence(doc);
  assert.equal(c.level, 'high');
  assert.equal(c.band, 25);
  assert.ok(c.reasons.some((r) => r === '1 Einheitskosten im Entwurf angepasst'));
  road.segments[0].level = 'bridge';
  c = costConfidence(doc);
  assert.equal(c.level, 'medium');
  assert.equal(c.band, 40);
  assert.ok(c.reasons.some((r) => r.includes('Brücken und Tunnel pauschal')));
  road.segments[0].level = 'ground';
  doc.features.push(createRoad({ layerId, nodes: [[47, 8], [47, 8.03]], kind: 'secondary' }));
  c = costConfidence(doc);
  assert.equal(c.level, 'low', '75 % der Länge ohne Breite');
  assert.ok(c.reasons.some((r) => r.includes('75 % der Strassenlänge')));
  // Ausgeblendete Ebene und Rückbau zählen nicht
  doc.features[1].status = 'remove';
  assert.equal(costConfidence(doc).level, 'high');
});

test('Feste Einstufungen und Text für den Bericht', () => {
  assert.equal(staticConfidence('parcels').level, 'high');
  assert.equal(staticConfidence('buildings').level, 'medium');
  assert.equal(staticConfidence('checks').level, 'medium');
  assert.equal(staticConfidence('egal'), null);
  assert.equal(confidenceText({ level: 'medium', band: 40, reasons: ['a', 'b'] }), 'Zuversicht mittel (±40 %): a; b');
  assert.equal(confidenceText({ level: 'low', reasons: [] }), 'Zuversicht tief');
  assert.equal(confidenceText(null), '');
});

test('Velo und zu Fuss: pauschales Tempo als Grund, geschätztes Tempo zählt nicht als Unsicherheit', () => {
  const bike = travelTimeConfidence({ quality: { dist: 1000, assumedDist: 1000, draftDist: 0, noProfileDist: 0, model: 'limit', vehicle: 'bike' } });
  assert.equal(bike.level, 'medium');
  assert.ok(bike.reasons.some((r) => r.startsWith('Velo pauschal')) && !bike.reasons.some((r) => r.includes('geschätztem Tempo')) && !bike.reasons.some((r) => r.startsWith('Tempolimit-Modell')));
  const foot = travelTimeConfidence({ quality: { dist: 1000, assumedDist: 1000, draftDist: 0, noProfileDist: 0, model: 'limit', vehicle: 'foot' } });
  assert.ok(foot.reasons.some((r) => r.startsWith('Zu Fuss pauschal')));
});

test('Fahrplan-Abgleich: nahe am Fahrplan hebt die Modell-Deckelung auf, grosse Abweichung senkt', () => {
  const q = { quality: { dist: 1000, assumedDist: 0, draftDist: 0, noProfileDist: 0, model: 'limit', vehicle: 'bus' } };
  const close = travelTimeConfidence(q, { schedule: { seconds: 900, model: 840, trips: 5 } });
  assert.equal(close.level, 'high', 'Abweichung −7 %: gemessen');
  assert.ok(close.reasons[0].includes('−7 %') || close.reasons[0].includes('-7 %'), close.reasons[0]);
  assert.ok(close.reasons[0].includes('5 Fahrten'));
  assert.equal(travelTimeConfidence(q, { schedule: { seconds: 900, model: 1100, trips: 2 } }).level, 'medium', '+22 %');
  assert.equal(travelTimeConfidence(q, { schedule: { seconds: 900, model: 1300, trips: 2 } }).level, 'low', '+44 %');
  assert.equal(travelTimeConfidence(q, { schedule: { seconds: 900, model: 840 }, networkLoading: true }).level, 'low', 'Netz lädt noch');
  assert.equal(travelTimeConfidence(q, { schedule: null }).level, 'medium');
});
