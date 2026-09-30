// Glätten, Vereinfachen und Kurvenradien von Linienzügen. Rechnet in
// Mercator-Metern; reine Funktionen, in Node testbar.

import { mercatorScale, project, unproject } from './geometry.js';

/**
 * Catmull-Rom-Spline durch die Punkte; zwischen je zwei Punkten werden
 * `subdivisions` Zwischenpunkte eingefügt. Liefert [{ latlng, segment }],
 * wobei segment der Index des ursprünglichen Abschnitts ist, aus dem der
 * Punkt hervorgeht (für das Weiterreichen von Abschnittseigenschaften).
 */
export function smoothPolyline(latlngs, subdivisions = 4, closed = false) {
  const n = latlngs.length;
  if (n < 3 || subdivisions < 1) return latlngs.map((ll, i) => ({ latlng: ll, segment: Math.min(i, n - 2) }));
  const pts = latlngs.map(project);
  const at = (i) => {
    if (closed) return pts[((i % n) + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };
  const out = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    out.push({ latlng: latlngs[i], segment: i });
    for (let k = 1; k <= subdivisions; k++) {
      const t = k / (subdivisions + 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ latlng: unproject({ x, y }), segment: i });
    }
  }
  if (!closed) out.push({ latlng: latlngs[n - 1], segment: n - 2 });
  return out;
}

/** Douglas-Peucker: Indizes der Punkte, die bei der Toleranz (Meter) bleiben. */
export function simplifyIndices(latlngs, toleranceMeters = 1) {
  const n = latlngs.length;
  if (n <= 2) return latlngs.map((_, i) => i);
  const pts = latlngs.map(project);
  const tol = toleranceMeters * mercatorScale(latlngs[0][0]);
  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(p.x - A.x, p.y - A.y);
      else {
        const t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / len2));
        d = Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Umkreisradius (Meter) dreier Punkte; Infinity, wenn sie auf einer Geraden liegen. */
export function circumradius(a, b, c) {
  const scale = mercatorScale(b[0]);
  const A = project(a);
  const B = project(b);
  const C = project(c);
  const ab = Math.hypot(B.x - A.x, B.y - A.y);
  const bc = Math.hypot(C.x - B.x, C.y - B.y);
  const ca = Math.hypot(A.x - C.x, A.y - C.y);
  const area2 = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y));
  if (area2 < 1e-9 || ab === 0 || bc === 0) return Infinity;
  return (ab * bc * ca) / (2 * area2) / scale;
}

/** Kurvenradius an jedem Punkt eines Linienzugs (Infinity an den Enden und auf Geraden). */
export function polylineRadii(latlngs) {
  const n = latlngs.length;
  const out = new Array(n).fill(Infinity);
  for (let i = 1; i < n - 1; i++) out[i] = circumradius(latlngs[i - 1], latlngs[i], latlngs[i + 1]);
  return out;
}

/** Glättet eine Strasse in place; Abschnittseigenschaften werden auf die Teilstücke übertragen. */
export function smoothRoad(road, subdivisions = 4) {
  if (!road || road.type !== 'road' || road.nodes.length < 3) return false;
  const pts = smoothPolyline(road.nodes, subdivisions);
  road.nodes = pts.map((p) => [Math.round(p.latlng[0] * 1e6) / 1e6, Math.round(p.latlng[1] * 1e6) / 1e6]);
  road.segments = pts.slice(0, -1).map((p) => ({ ...road.segments[Math.min(p.segment, road.segments.length - 1)] }));
  return true;
}

/** Vereinfacht eine Strasse in place; zusammengelegte Abschnitte behalten die Eigenschaften des ersten. */
export function simplifyRoad(road, toleranceMeters = 1) {
  if (!road || road.type !== 'road' || road.nodes.length < 3) return false;
  const keep = simplifyIndices(road.nodes, toleranceMeters);
  if (keep.length === road.nodes.length) return false;
  const nodes = keep.map((i) => road.nodes[i]);
  const segments = keep.slice(0, -1).map((i) => ({ ...road.segments[i] }));
  road.nodes = nodes;
  road.segments = segments;
  return true;
}

export function smoothZone(zone, subdivisions = 3) {
  if (!zone || zone.type !== 'zone' || zone.nodes.length < 3) return false;
  zone.nodes = smoothPolyline(zone.nodes, subdivisions, true).map((p) => [Math.round(p.latlng[0] * 1e6) / 1e6, Math.round(p.latlng[1] * 1e6) / 1e6]);
  return true;
}
