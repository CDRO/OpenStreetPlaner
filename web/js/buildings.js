// Betroffene Gebäude: welche OSM-Gebäude innerhalb eines Abstands zu einer
// Linie (Route oder neue Strasse) liegen. Reine Funktionen, in Node testbar.

import { closestPointOnSegment, mercatorScale, project } from './geometry.js';
import { pointInPolygon } from './model.js';

/** Kleinster Abstand (m) eines Gebäude-Umrings zu einem Linienzug; 0, wenn die Linie das Gebäude durchquert. */
export function buildingDistance(ring, line) {
  if (!ring || ring.length < 3 || !line || line.length < 2) return Infinity;
  const scale = mercatorScale(ring[0][0]);
  const R = ring.map(project);
  const L = line.map(project);
  let best = Infinity;
  for (const p of R) {
    for (let i = 1; i < L.length; i++) {
      const q = closestPointOnSegment(p, L[i - 1], L[i]);
      if (q.dist < best) best = q.dist;
    }
  }
  for (const p of L) {
    for (let i = 1; i < R.length; i++) {
      const q = closestPointOnSegment(p, R[i - 1], R[i]);
      if (q.dist < best) best = q.dist;
    }
  }
  if (line.some((ll) => pointInPolygon(ll, ring))) return 0;
  // Die Linie quert den Umring (ohne Eckpunkt im Gebäude)
  for (let i = 1; i < L.length; i++) {
    for (let j = 1; j < R.length; j++) {
      if (segmentsIntersect(L[i - 1], L[i], R[j - 1], R[j])) return 0;
    }
  }
  return best / scale;
}

const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** Schneiden sich die Strecken p1-p2 und q1-q2 (inklusive Berührung)? */
export function segmentsIntersect(p1, p2, q1, q2) {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (a, b, c) => Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
  return (o1 === 0 && on(p1, p2, q1)) || (o2 === 0 && on(p1, p2, q2)) || (o3 === 0 && on(q1, q2, p1)) || (o4 === 0 && on(q1, q2, p2));
}

/** Gebäude, deren Abstand zur Linie höchstens radiusM beträgt. */
export function buildingsNear(buildings, line, radiusM) {
  if (!line || line.length < 2) return [];
  const out = [];
  // Grobfilter: Rechteck um die Linie mit Rand
  const lats = line.map((p) => p[0]);
  const lngs = line.map((p) => p[1]);
  const dLat = radiusM / 111320 + 0.001;
  const dLng = radiusM / (111320 * Math.cos((lats[0] * Math.PI) / 180)) + 0.001;
  const south = Math.min(...lats) - dLat;
  const north = Math.max(...lats) + dLat;
  const west = Math.min(...lngs) - dLng;
  const east = Math.max(...lngs) + dLng;
  for (const b of buildings) {
    const g = b.geometry;
    if (!g || g.length < 3) continue;
    if (g.every((p) => p[0] < south || p[0] > north || p[1] < west || p[1] > east)) continue;
    const d = buildingDistance(g, line);
    if (d <= radiusM) out.push({ building: b, distance: Math.round(d * 10) / 10 });
  }
  return out;
}

/**
 * Betroffenheit: Gebäude im Umkreis der heutigen Route, der neuen Route und aller neuen Strassen.
 * Liefert { radius, current: {count, ids}, proposed: {count, ids}, roads: {count, ids}, delta }.
 */
export function exposure({ buildings = [], routes = null, roads = [], radiusM = 50 }) {
  const collect = (lines) => {
    const ids = new Set();
    for (const line of lines) for (const hit of buildingsNear(buildings, line, radiusM)) ids.add(hit.building.id);
    return { count: ids.size, ids };
  };
  const cur = routes && routes.current && routes.current.path ? [routes.current.path] : [];
  const neu = routes && routes.proposed && routes.proposed.path ? [routes.proposed.path] : [];
  const current = collect(cur);
  const proposed = collect(neu);
  const roadLines = roads.filter((r) => r.type === 'road' && r.status === 'new').map((r) => r.nodes);
  return {
    radius: radiusM,
    hasRoutes: cur.length > 0 || neu.length > 0,
    current,
    proposed,
    roads: collect(roadLines),
    delta: proposed.count - current.count,
  };
}
