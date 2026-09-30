import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapIndex, snapLatLng, excludeFeature } from '../js/snap.js';
import { createDocument, createLayer, createRoad, createRoundabout } from '../js/model.js';

test('Index enthält nur sichtbare Ebenen und optional OSM', () => {
  const doc = createDocument();
  const visible = doc.layers[0];
  const hidden = createLayer(doc, 'versteckt');
  hidden.visible = false;
  doc.features.push(createRoad({ layerId: visible.id, nodes: [[47, 8], [47, 8.001]] }));
  doc.features.push(createRoad({ layerId: hidden.id, nodes: [[46, 8], [46, 8.001]] }));
  doc.features.push(createRoundabout({ layerId: visible.id, center: [47.1, 8.1], radius: 20 }));
  const osmWays = [{ id: 7, tags: {}, geometry: [[47.2, 8.2], [47.2, 8.201], [47.2, 8.202]] }];
  const withOsm = buildSnapIndex(doc, { osmWays });
  assert.equal(withOsm.nodes.length, 2 + 1 + 3);
  assert.equal(withOsm.segments.length, 1 + 2);
  assert.equal(withOsm.circles.length, 1);
  const without = buildSnapIndex(doc, { osmWays, includeOsm: false });
  assert.equal(without.nodes.length, 3);
});

test('snapLatLng rastet innerhalb der Pixel-Toleranz ein', () => {
  const doc = createDocument();
  const layerId = doc.layers[0].id;
  const road = createRoad({ layerId, nodes: [[47, 8], [47, 8.01]] });
  doc.features.push(road);
  const index = buildSnapIndex(doc);
  // 47.00005° Breite sind ~5.5 m; bei Zoom 18 ist 1 px ~0.6 m -> ~9 px, also innerhalb 14 px.
  const hit = snapLatLng([47.00005, 8.005], index, 18, 14);
  assert.ok(hit.snap, 'sollte einrasten');
  assert.equal(hit.snap.kind, 'segment');
  assert.equal(hit.snap.ref.featureId, road.id);
  assert.ok(Math.abs(hit.latlng[0] - 47) < 1e-9);
  const miss = snapLatLng([47.00005, 8.005], index, 18, 4);
  assert.equal(miss.snap, null);
  assert.deepEqual(miss.latlng, [47.00005, 8.005]);
  const excluded = snapLatLng([47.00005, 8.005], index, 18, 14, excludeFeature(road.id));
  assert.equal(excluded.snap, null);
  const onNode = snapLatLng([47.00001, 8.00001], index, 18, 14);
  assert.equal(onNode.snap.kind, 'node');
  assert.equal(onNode.snap.ref.index, 0);
});
