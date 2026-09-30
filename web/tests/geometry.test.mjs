import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  project, unproject, unitsPerPixel, haversine, pathLength, closestPointOnSegment,
  closestPointOnCircle, findSnap, segmentEntry, bearing, circleRing,
} from '../js/geometry.js';

test('project/unproject ist umkehrbar', () => {
  const ll = [46.9481, 7.4474];
  const back = unproject(project(ll));
  assert.ok(Math.abs(back[0] - ll[0]) < 1e-9);
  assert.ok(Math.abs(back[1] - ll[1]) < 1e-9);
});

test('unitsPerPixel halbiert sich pro Zoomstufe', () => {
  assert.ok(Math.abs(unitsPerPixel(10) / unitsPerPixel(11) - 2) < 1e-12);
  assert.ok(Math.abs(unitsPerPixel(0) - 156543.03392804097) < 1e-6);
});

test('haversine Bern-Zürich ungefähr 95 km', () => {
  const d = haversine([46.9481, 7.4474], [47.3769, 8.5417]);
  assert.ok(d > 94000 && d < 96000, `d=${d}`);
  assert.equal(pathLength([[0, 0]]), 0);
});

test('closestPointOnSegment klemmt auf die Strecke', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  const mid = closestPointOnSegment({ x: 5, y: 3 }, a, b);
  assert.equal(mid.x, 5);
  assert.equal(mid.t, 0.5);
  assert.equal(mid.dist, 3);
  const before = closestPointOnSegment({ x: -4, y: 0 }, a, b);
  assert.equal(before.t, 0);
  assert.equal(before.dist, 4);
  const degenerate = closestPointOnSegment({ x: 1, y: 1 }, a, a);
  assert.equal(degenerate.t, 0);
});

test('closestPointOnCircle liegt auf dem Ring', () => {
  const q = closestPointOnCircle({ x: 20, y: 0 }, { x: 0, y: 0 }, 5);
  assert.equal(q.x, 5);
  assert.equal(q.dist, 15);
});

test('findSnap bevorzugt Knoten vor Abschnitten und beachtet Toleranz', () => {
  const index = {
    nodes: [{ x: 10, y: 0, ref: { id: 'n' } }],
    segments: [segmentEntry({ x: 0, y: 0 }, { x: 100, y: 0 }, { id: 's' })],
    circles: [{ x: 200, y: 0, r: 10, ref: { id: 'c' } }],
  };
  const nearNode = findSnap({ x: 11, y: 2 }, index, 5);
  assert.equal(nearNode.kind, 'node');
  assert.equal(nearNode.ref.id, 'n');
  const onSeg = findSnap({ x: 50, y: 3 }, index, 5);
  assert.equal(onSeg.kind, 'segment');
  assert.equal(onSeg.y, 0);
  assert.ok(Math.abs(onSeg.t - 0.5) < 1e-12);
  const onCircle = findSnap({ x: 212, y: 0 }, index, 5);
  assert.equal(onCircle.kind, 'circle');
  assert.equal(onCircle.x, 210);
  assert.equal(findSnap({ x: 50, y: 30 }, index, 5), null);
  const filtered = findSnap({ x: 11, y: 2 }, index, 5, (ref) => ref.id !== 'n');
  assert.equal(filtered.kind, 'segment');
});

test('bearing nach Norden ist 0, nach Osten 90', () => {
  assert.ok(Math.abs(bearing([47, 8], [48, 8])) < 1e-6);
  assert.ok(Math.abs(bearing([47, 8], [47, 9]) - 90) < 1e-6);
});

test('circleRing schliesst sich und hat den richtigen Radius', () => {
  const center = [47, 8];
  const ring = circleRing(center, 20, 16);
  assert.equal(ring.length, 17);
  assert.deepEqual(ring[0], ring[16]);
  for (const p of ring) assert.ok(Math.abs(haversine(center, p) - 20) < 0.05);
});
