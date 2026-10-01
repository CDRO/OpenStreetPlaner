import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minRadiusFor, runChecks, MIN_RADIUS } from '../js/checks.js';
import { createDocument, createJunction, createRoad, createRoundabout, createZone, nodesKey } from '../js/model.js';

test('Mindestradius interpoliert zwischen den Stützwerten', () => {
  assert.equal(minRadiusFor(0), 0);
  assert.equal(minRadiusFor(10), MIN_RADIUS[0][1]);
  assert.equal(minRadiusFor(50), 80);
  assert.equal(minRadiusFor(55), 100);
  assert.equal(minRadiusFor(200), 750);
});

test('Normen-Check findet enge Kurven, Steigung, Kreiselgrösse, Breite, Zonen und lose Enden', () => {
  const doc = createDocument();
  const a = doc.layers[0].id;
  // Gerade Strasse mit 50: keine Kurvenwarnung, aber beide Enden lose
  const straight = createRoad({ layerId: a, nodes: [[47, 8], [47, 8.002], [47, 8.004]], kind: 'main', maxspeed: 50 });
  doc.features.push(straight);
  let res = runChecks(doc);
  assert.equal(res.filter((c) => c.text.includes('Kurvenradius')).length, 0);
  assert.equal(res.filter((c) => c.text.includes('beide Enden')).length, 1);
  // Scharfe 90°-Ecke bei 50 km/h: Radius ~ 10 m -> Warnung
  const sharp = createRoad({ layerId: a, nodes: [[47, 8.004], [47, 8.0042], [47.0002, 8.0042]], kind: 'main', maxspeed: 50 });
  doc.features.push(sharp);
  res = runChecks(doc);
  const curve = res.find((c) => c.featureId === sharp.id && c.text.includes('Kurvenradius'));
  assert.ok(curve && curve.severity === 'warn', JSON.stringify(res));
  assert.ok(curve.at && Math.abs(curve.at[1] - 8.0042) < 1e-9, 'Position am Eckpunkt');
  // Angeschlossen: die zweite Strasse beginnt am Ende der ersten -> dort kein loses Ende mehr
  assert.equal(res.filter((c) => c.featureId === straight.id && c.text.includes('beide Enden')).length, 0);
  assert.equal(res.filter((c) => c.featureId === straight.id && c.text.includes('ein Ende')).length, 1);
  // Steigung aus Profil: 20 m auf 100 m = 20 %
  const steep = createRoad({ layerId: a, nodes: [[47.01, 8], [47.01, 8.0013]], kind: 'main', maxspeed: 50 });
  steep.profile = { points: [[0, 500], [100, 520]], key: nodesKey(steep.nodes) };
  doc.features.push(steep);
  res = runChecks(doc);
  assert.ok(res.some((c) => c.featureId === steep.id && c.severity === 'warn' && c.text.includes('Steigung')));
  // Kreisel zu klein / zu gross
  doc.features.push(createRoundabout({ layerId: a, center: [47.02, 8], radius: 8 }));
  doc.features.push(createRoundabout({ layerId: a, center: [47.03, 8], radius: 30 }));
  res = runChecks(doc);
  assert.equal(res.filter((c) => c.text.includes('Kreisel') && c.severity === 'warn').length, 1);
  assert.equal(res.filter((c) => c.text.includes('ungewöhnlich gross')).length, 1);
  // Fahrstreifen zu schmal
  straight.section = { lanes: 2, laneWidth: 2.5, median: 0, shoulder: 0, bikeLeft: false, bikeRight: false, bikeWidth: 1.5, walkLeft: false, walkRight: false, walkWidth: 2, parkLeft: false, parkRight: false, parkWidth: 2 };
  res = runChecks(doc);
  assert.ok(res.some((c) => c.featureId === straight.id && c.text.includes('Fahrstreifen 2.5 m')));
  straight.section = null;
  // Tempo 50 in Tempo-30-Zone
  doc.features.push(createZone({ layerId: a, nodes: [[46.999, 7.999], [46.999, 8.005], [47.001, 8.005], [47.001, 7.999]], kind: 'tempo30' }));
  res = runChecks(doc);
  assert.ok(res.some((c) => c.featureId === straight.id && c.text.includes('über der Zone')));
  // Warnungen vor Hinweisen
  assert.ok(res.findIndex((c) => c.severity === 'info') >= res.filter((c) => c.severity === 'warn').length - 1);
  // Kreuzung abseits des Netzes
  doc.features.push(createJunction({ layerId: a, at: [47.05, 8.05], kind: 'signals' }));
  res = runChecks(doc);
  assert.ok(res.some((c) => c.text.includes('auf keinem Strassenknoten')));
  // Ausgeblendete Ebene wird nicht geprüft
  doc.layers[0].visible = false;
  assert.equal(runChecks(doc).length, 0);
});
