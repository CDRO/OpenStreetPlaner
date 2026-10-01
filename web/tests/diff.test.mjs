import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, describeChange, diffDocuments, featureTitle } from '../js/diff.js';
import { cloneDocument, createDocument, createJunction, createRoad, createRoundabout } from '../js/model.js';

test('canonical ignoriert die Schlüsselreihenfolge', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

test('diffDocuments findet hinzugefügte, entfernte und geänderte Elemente und Ebenen', () => {
  const a = createDocument({ name: 'Alt' });
  const layerId = a.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.001]], kind: 'main', maxspeed: 50, name: 'Haupt' });
  const j = createJunction({ layerId, at: [47, 8], kind: 'plain' });
  a.features.push(road, j);
  const b = cloneDocument(a);
  b.name = 'Neu';
  const r2 = b.features[0];
  r2.maxspeed = 30;
  r2.nodes.push([47, 8.002]);
  r2.segments.push({ level: 'bridge', maxspeed: null });
  b.features = b.features.filter((f) => f.id !== j.id);
  b.features.push(createRoundabout({ layerId, center: [47, 8.002], radius: 15 }));
  b.layers[0].name = 'Variante A';
  b.layers.push({ id: 'l_new', name: 'Variante B', color: '#000000', visible: true });
  const d = diffDocuments(a, b);
  assert.deepEqual(d.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(d.added[0].type, 'roundabout');
  assert.equal(d.removed[0].id, j.id);
  const ch = d.changed[0].changes;
  assert.ok(ch.includes('Tempolimit: 50 → 30'), ch.join(' | '));
  assert.ok(ch.includes('Geometrie (2 → 3 Punkte)'));
  assert.ok(ch.includes('Führung der Abschnitte'));
  assert.deepEqual(d.layers.renamed, [{ from: 'Ebene 1', to: 'Variante A' }]);
  assert.equal(d.layers.added[0].name, 'Variante B');
  assert.ok(d.nameChanged && !d.empty);
  assert.ok(diffDocuments(a, cloneDocument(a)).empty);
  // Reihenfolge der Schlüssel spielt keine Rolle
  const reorder = (o) => Object.fromEntries(Object.keys(o).sort().reverse().map((k) => [k, o[k]]));
  assert.ok(diffDocuments(a, { ...a, features: a.features.map(reorder) }).empty, 'andere Schlüsselreihenfolge = keine Änderung');
  assert.equal(featureTitle(road), 'Strasse „Haupt“');
  assert.deepEqual(describeChange({ name: 'a', nodes: [[47, 8]] }, { name: 'a', nodes: [[47.1, 8]] }), ['Geometrie verschoben']);
});
