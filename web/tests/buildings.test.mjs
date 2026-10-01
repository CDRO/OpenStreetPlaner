import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingDistance, buildingsNear, exposure } from '../js/buildings.js';

const house = (id, lat, lng, size = 0.0001) => ({ id, tags: { building: 'house' }, geometry: [[lat, lng], [lat, lng + size], [lat + size, lng + size], [lat + size, lng], [lat, lng]] });

test('Abstand Gebäude zu Linie: seitlich, durchquert, Grobfilter', () => {
  const line = [[47, 8], [47, 8.01]];
  const beside = house(1, 47.0003, 8.005); // ~33 m nördlich
  const d = buildingDistance(beside.geometry, line);
  assert.ok(d > 30 && d < 36, `${d} m`);
  const crossed = house(2, 46.99995, 8.005);
  assert.equal(buildingDistance(crossed.geometry, line), 0);
  const far = house(3, 47.01, 8.005);
  const near = buildingsNear([beside, crossed, far], line, 50);
  assert.deepEqual(near.map((h) => h.building.id).sort(), [1, 2]);
  assert.equal(buildingsNear([beside], line, 20).length, 0);
});

test('Betroffenheit: heute vs. neu und entlang neuer Strassen', () => {
  const buildings = [house(1, 47.0002, 8.002), house(2, 47.0002, 8.006), house(3, 47.0102, 8.004), house(4, 47.02, 8.02)];
  const routes = {
    current: { path: [[47, 8], [47, 8.01]] },
    proposed: { path: [[47, 8], [47.01, 8], [47.01, 8.01]] },
  };
  const roads = [{ type: 'road', status: 'new', nodes: [[47.01, 8], [47.01, 8.01]] }, { type: 'road', status: 'existing', nodes: [[47.02, 8.02], [47.02, 8.03]] }];
  const e = exposure({ buildings, routes, roads, radiusM: 50 });
  assert.equal(e.current.count, 2);
  assert.equal(e.proposed.count, 1);
  assert.equal(e.delta, -1);
  assert.equal(e.roads.count, 1, 'nur neue Strassen');
  assert.ok(e.hasRoutes);
  const none = exposure({ buildings, routes: null, roads, radiusM: 50 });
  assert.equal(none.current.count, 0);
  assert.equal(none.hasRoutes, false);
});
