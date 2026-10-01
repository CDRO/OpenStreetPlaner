import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store.js';
import { createDocument, createJunction } from '../js/model.js';

test('commit/undo/redo', () => {
  const store = new Store(createDocument());
  const events = [];
  store.subscribe((doc, e) => events.push(e.type));
  const layerId = store.doc.layers[0].id;
  store.commit('Kreuzung', (doc) => doc.features.push(createJunction({ layerId, at: [1, 1] })));
  assert.equal(store.doc.features.length, 1);
  assert.equal(store.canUndo(), true);
  store.commit('nichts', () => {});
  assert.equal(store.undoStack.length, 1, 'keine Änderung -> kein Undo-Eintrag');
  assert.equal(store.undo(), 'Kreuzung');
  assert.equal(store.doc.features.length, 0);
  assert.equal(store.canRedo(), true);
  store.redo();
  assert.equal(store.doc.features.length, 1);
  assert.equal(store.undo(), 'Kreuzung');
  store.commit('neu', (doc) => doc.features.push(createJunction({ layerId, at: [2, 2] })));
  assert.equal(store.canRedo(), false, 'neuer Commit leert Redo');
  assert.deepEqual(events, ['change', 'undo', 'redo', 'undo', 'change']);
  assert.equal(store.redo(), null);
});

test('maxUndo begrenzt den Stapel, load leert ihn', () => {
  const store = new Store(createDocument(), { maxUndo: 3 });
  const layerId = store.doc.layers[0].id;
  for (let i = 0; i < 5; i++) store.commit('x', (doc) => doc.features.push(createJunction({ layerId, at: [i, i] })));
  assert.equal(store.undoStack.length, 3);
  store.load(createDocument());
  assert.equal(store.canUndo(), false);
});

test('Name und Route sind Teil des Undo-Schnappschusses', () => {
  const store = new Store(createDocument({ name: 'Alt' }));
  let events = 0;
  store.subscribe(() => events++);
  store.commit('umbenennen', (doc) => { doc.name = 'Neu'; });
  store.commit('Route', (doc) => { doc.route = { from: [1, 1], to: [2, 2] }; });
  assert.equal(events, 2, 'beide Änderungen lösen Ereignisse aus');
  store.undo();
  assert.equal(store.doc.route, null);
  store.undo();
  assert.equal(store.doc.name, 'Alt');
  store.redo();
  assert.equal(store.doc.name, 'Neu');
});

test('Etappen sind Teil des Snapshots: Anlegen ist eine Änderung und lässt sich rückgängig machen', async () => {
  const { Store } = await import('../js/store.js');
  const { createDocument, createPhase } = await import('../js/model.js');
  const store = new Store(createDocument());
  let events = 0;
  store.subscribe(() => { events++; });
  store.commit('Etappe', (d) => { createPhase(d, 'Erste', 2027); });
  assert.equal(events, 1);
  assert.equal(store.doc.phases.length, 1);
  assert.ok(store.canUndo());
  store.undo();
  assert.equal(store.doc.phases.length, 0);
  store.redo();
  assert.equal(store.doc.phases[0].name, 'Erste');
});
