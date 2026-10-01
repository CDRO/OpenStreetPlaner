import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVariants } from '../js/variants.js';
import { createDocument, createLayer, createRoad, createRoundabout } from '../js/model.js';

test('Variantenvergleich: jede Ebene allein mit Kosten, Fahrzeit-Differenz, Warnungen und Gebäuden', () => {
  const ways = [
    { id: 1, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8], [47, 8.005], [47, 8.01]] },
    { id: 2, tags: { highway: 'residential', maxspeed: '50' }, geometry: [[47, 8.01], [47.005, 8.01], [47.01, 8.01]] },
  ];
  const doc = createDocument();
  const a = doc.layers[0];
  const b = createLayer(doc, 'Variante B');
  doc.features.push(createRoad({ layerId: a.id, nodes: [[47, 8], [47.01, 8.01]], kind: 'main', maxspeed: 80 })); // Diagonale: schneller
  doc.features.push(createRoundabout({ layerId: b.id, center: [47.005, 8.005], radius: 6 })); // zu klein: Warnung
  doc.features.push(createRoad({ layerId: b.id, nodes: [[47, 8.002], [47.0005, 8.002]], kind: 'main' })); // kurz
  doc.route = { from: [47, 8], to: [47.01, 8.01] };
  doc.routePairs = [{ id: 'p1', name: 'x', from: [47, 8], to: [47.01, 8.01] }];
  const buildings = [{ id: 9, geometry: [[47.0049, 8.0049], [47.0049, 8.0051], [47.0051, 8.0051], [47.0051, 8.0049]] }];
  const v = compareVariants({ doc, osmWays: ways, buildings, radiusM: 50 });
  assert.equal(v.layers.length, 2);
  const [ra, rb] = v.layers;
  assert.ok(ra.routeDelta < 0 && Math.abs(rb.routeDelta) < 1e-6, `A schneller, B wie heute: ${ra.routeDelta} ${rb.routeDelta}`);
  assert.equal(ra.pairsCount, 1);
  assert.ok(ra.pairsDelta < 0);
  assert.ok(ra.costs > rb.costs, 'lange Diagonale teurer als Kreisel plus kurze Strasse');
  assert.ok(rb.warnings >= 1 && ra.warnings === 0, `Warnungen: ${ra.warnings} / ${rb.warnings}`);
  assert.equal(ra.buildings, 1, 'Gebäude an der Diagonale');
  assert.equal(rb.buildings, 0);
  assert.equal(ra.features, 1);
  assert.equal(rb.features, 2);
  assert.ok(ra.lengthNew > 1300 && rb.lengthNew < 100);
  assert.equal(v.currentTime > 0, true);
  b.visible = false;
  assert.equal(compareVariants({ doc, osmWays: [], buildings: [] }).layers[1].visible, false);
  assert.equal(compareVariants({ doc, osmWays: [], buildings: [] }).layers[0].routeTime, null, 'ohne Netz keine Fahrzeit');
});
