import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsmRoadCache, roadKindFromHighway } from '../js/osm.js';

test('roadKindFromHighway ordnet gängige Tags zu', () => {
  assert.equal(roadKindFromHighway('primary'), 'main');
  assert.equal(roadKindFromHighway('tertiary'), 'secondary');
  assert.equal(roadKindFromHighway('residential'), 'residential');
  assert.equal(roadKindFromHighway('footway'), 'path');
  assert.equal(roadKindFromHighway('raceway'), 'other');
});

test('OsmRoadCache lädt einmal pro Bereich und meldet Zustand', async () => {
  let calls = 0;
  const cache = new OsmRoadCache(async () => {
    calls++;
    return [{ id: 1, tags: { highway: 'primary' }, geometry: [[47, 8], [47, 8.001]] }, { id: 2, geometry: [[1, 1]] }];
  });
  const states = [];
  cache.subscribe((s) => states.push(s.status));
  const bounds = { south: 46.99, west: 7.99, north: 47.01, east: 8.01 };
  cache.ensure(bounds, 15);
  assert.equal(calls, 0, 'unter Mindestzoom kein Laden');
  cache.ensure(bounds, 17);
  await cache.pending;
  assert.equal(calls, 1);
  assert.equal(cache.list().length, 1);
  assert.equal(cache.get(1).tags.highway, 'primary');
  cache.ensure({ south: 46.995, west: 7.995, north: 47.005, east: 8.005 }, 17);
  assert.equal(calls, 1, 'enthaltener Bereich wird nicht neu geladen');
  cache.ensure({ south: 48, west: 9, north: 48.01, east: 9.01 }, 17);
  await cache.pending;
  assert.equal(calls, 2);
  assert.deepEqual(states, ['loading', 'ready', 'loading', 'ready']);
});

test('OsmRoadCache meldet Fehler statt zu werfen', async () => {
  const cache = new OsmRoadCache(async () => { throw new Error('kaputt'); });
  const states = [];
  cache.subscribe((s) => states.push(s.status));
  cache.ensure({ south: 46.99, west: 7.99, north: 47.01, east: 8.01 }, 17);
  await cache.pending;
  assert.deepEqual(states, ['loading', 'error']);
  assert.equal(cache.lastError.message, 'kaputt');
});
