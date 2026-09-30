import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveSpeedKmh, gradeSpeedFactor, expectedSpeedKmh, segmentTime, summarize, segmentGrades, covForSpeed } from '../js/speedmodel.js';

test('Kurvenradius begrenzt die Geschwindigkeit plausibel', () => {
  assert.equal(curveSpeedKmh(Infinity), Infinity);
  assert.ok(Math.abs(curveSpeedKmh(30) - 34.2) < 1, `R=30: ${curveSpeedKmh(30)}`);
  assert.ok(Math.abs(curveSpeedKmh(120) - 68.3) < 1, `R=120: ${curveSpeedKmh(120)}`);
  assert.ok(curveSpeedKmh(1) === 15, 'Untergrenze');
  assert.equal(expectedSpeedKmh({ limitKmh: 50, radiusStart: 500 }), 50);
  assert.ok(expectedSpeedKmh({ limitKmh: 80, radiusStart: 60, radiusEnd: 400 }) < 50, 'enge Kurve am Anfang zählt');
  assert.equal(expectedSpeedKmh({ limitKmh: 0 }), 0);
});

test('Steigung und Streuung', () => {
  assert.equal(gradeSpeedFactor(2), 1);
  assert.ok(gradeSpeedFactor(10) < 0.8 && gradeSpeedFactor(10) > 0.7);
  assert.ok(gradeSpeedFactor(-10) > gradeSpeedFactor(10), 'bergab weniger Abschlag');
  assert.equal(gradeSpeedFactor(NaN), 1);
  assert.ok(expectedSpeedKmh({ limitKmh: 50, gradePercent: 12 }) < 40);
  assert.equal(covForSpeed(30), 0.22);
  const t = segmentTime(1000, 50);
  assert.ok(Math.abs(t.mean - 72) < 0.1);
  assert.ok(Math.abs(Math.sqrt(t.variance) - 0.18 * 72) < 0.1);
  const s = summarize(100, 400);
  assert.equal(s.sd, 20);
  assert.ok(Math.abs(s.p15 - 79.28) < 0.01 && Math.abs(s.p85 - 120.72) < 0.01);
});

test('segmentGrades interpoliert im Höhenprofil', () => {
  const profile = [[0, 500], [100, 510], [200, 505]];
  const grades = segmentGrades([0, 50, 100, 200], profile);
  assert.equal(grades.length, 3);
  assert.ok(Math.abs(grades[0] - 10) < 1e-9);
  assert.ok(Math.abs(grades[1] - 10) < 1e-9);
  assert.ok(Math.abs(grades[2] + 5) < 1e-9);
  assert.deepEqual(segmentGrades([0, 10], null), [0]);
});
