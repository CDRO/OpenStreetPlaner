import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COST_ITEMS, costValue, estimateCosts, formatChf, ringAreaM2 } from '../js/costs.js';
import { COST_KEYS, createDocument, createJunction, createRoad, createRoundabout, createZone, deserialize, normalizeCosts, serialize } from '../js/model.js';

test('Einheitskosten: Schlüssel vollständig, Normalisierung, Überschreiben im Entwurf', () => {
  assert.deepEqual(COST_ITEMS.map((c) => c.key).sort(), COST_KEYS.slice().sort());
  assert.deepEqual(normalizeCosts({ 'road.main': '2500000.6', bridge: -5, unbekannt: 3, tunnel: 1e12 }), { 'road.main': 2500001 });
  assert.deepEqual(normalizeCosts(null), {});
  const doc = createDocument();
  assert.equal(costValue(doc, 'road.main'), 3e6);
  doc.costs = { 'road.main': 4e6 };
  assert.equal(costValue(doc, 'road.main'), 4e6);
  const back = deserialize(serialize(doc));
  assert.deepEqual(back.costs, { 'road.main': 4e6 });
  assert.equal(formatChf(1234567), '1.2 Mio. CHF');
  assert.equal(formatChf(123456789), '123 Mio. CHF');
  assert.equal(formatChf(456789), '457’000 CHF');
  assert.equal(formatChf(12), '12 CHF');
  assert.equal(formatChf(-250000), '−250’000 CHF');
});

test('Schätzung: Länge × Ansatz × Breite, Brücke/Tunnel-Zuschlag, Pauschalen, nur sichtbare Ebenen im Total', () => {
  const doc = createDocument();
  const a = doc.layers[0].id;
  const road = createRoad({ layerId: a, nodes: [[47, 8], [47, 8.01]], kind: 'main' }); // ~ 760 m
  road.segments[0].level = 'bridge';
  doc.features.push(road);
  const est1 = estimateCosts(doc);
  const len = 0.01 * 111320 * Math.cos((47 * Math.PI) / 180);
  const expected = (len / 1000) * 3e6 + len * 60000;
  assert.ok(Math.abs(est1.rows[0].amount - expected) < 1000, `${est1.rows[0].amount} vs ${expected} (Haversine vs. Näherung)`);
  assert.ok(est1.rows[0].detail.includes('Brücke'));
  // Breite skaliert: 14 m statt 7 m verdoppelt den Strassenanteil
  road.width = 14;
  road.segments[0].level = 'ground';
  const wide = estimateCosts(doc).rows[0].amount;
  assert.ok(Math.abs(wide - (len / 1000) * 3e6 * 2) < 1000);
  // Bestehend: 0; Rückbau: Ansatz pro km
  road.status = 'existing';
  assert.equal(estimateCosts(doc).rows[0].amount, 0);
  road.status = 'remove';
  assert.ok(Math.abs(estimateCosts(doc).rows[0].amount - (len / 1000) * 300000) < 100);
  road.status = 'new';
  road.width = null;
  // Pauschalen und Fläche
  doc.features.push(createRoundabout({ layerId: a, center: [47, 8], radius: 15 }));
  doc.features.push(createJunction({ layerId: a, at: [47, 8.005], kind: 'signals' }));
  doc.features.push(createZone({ layerId: a, nodes: [[47, 8], [47, 8.001], [47.001, 8.001], [47.001, 8]], kind: 'parking' }));
  const est2 = estimateCosts(doc);
  const byType = Object.fromEntries(est2.rows.map((r) => [r.type, r.amount]));
  assert.equal(byType.roundabout, 1.5e6);
  assert.equal(byType.junction, 400000);
  const area = ringAreaM2(doc.features[3].nodes);
  assert.ok(area > 8000 && area < 8800, `Parkplatz ${area} m²`);
  assert.equal(byType.zone, Math.round(area * 150));
  // Ebenen: ausgeblendete zählen nicht im Total
  const b = { id: 'l_b', name: 'Variante B', color: '#000000', visible: false };
  doc.layers.push(b);
  doc.features.push(createRoundabout({ layerId: 'l_b', center: [47.01, 8], radius: 15 }));
  const est3 = estimateCosts(doc);
  assert.equal(est3.layers.length, 2);
  assert.equal(est3.layers[1].amount, 1.5e6);
  assert.equal(est3.total, est3.layers[0].amount);
  // Eigener Ansatz wirkt
  doc.costs = { roundabout: 2e6 };
  assert.equal(estimateCosts(doc).layers[1].amount, 2e6);
});
