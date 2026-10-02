// Zusammenführen: Flächen vereinigen (Polygon-Vereinigung) und Strassen verbinden (Ende an Ende).
// Ohne Bibliothek: Kanten an Schnittpunkten teilen, Randkanten über die Lage ihrer beiden Seiten
// bestimmen, zum Ring verketten. Löcher fallen weg (Flächen sind einfache Ringe).
import { project, unproject, mercatorScale, closestPointOnSegment } from './geometry.js';
import { getFeature, removeFeature, roundCoord } from './model.js';

/** Zusammenfallende Punkte (m) und seitlicher Versatz für die Innen-/Aussen-Prüfung (m). */
export const MERGE_EPS = 0.5;
/** Grösster Abstand (m), über den zwei Strassenenden noch als zusammenhängend gelten. */
export const JOIN_TOLERANCE = 10;

function segIntersection(p1, p2, p3, p4, eps) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return null; // parallel oder kollinear: Endpunkte auf Kanten erledigt der Punkt-Test
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  const lenA = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const lenB = Math.hypot(p4.x - p3.x, p4.y - p3.y);
  const tolA = lenA > 0 ? eps / lenA : 0;
  const tolB = lenB > 0 ? eps / lenB : 0;
  if (t < -tolA || t > 1 + tolA || u < -tolB || u > 1 + tolB) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringAreaXY(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  return a / 2;
}

/**
 * Vereinigung mehrerer Ringe ([lat,lng][]). Liefert den äusseren Ring der Vereinigung oder null,
 * wenn die Flächen sich weder berühren noch überlappen (dann gibt es keine zusammenhängende Fläche).
 */
export function unionRings(rings) {
  const clean = rings.map((r) => r.filter((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1])).filter((r) => r.length >= 3);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0].map(roundCoord);
  const scale = mercatorScale(clean[0][0][0]);
  const eps = MERGE_EPS * scale;
  const polys = clean.map((r) => r.map(project));
  // 1. Alle Kanten mit ihren Teilungspunkten (Schnitte mit fremden Kanten, fremde Eckpunkte auf der Kante)
  const edges = [];
  polys.forEach((poly, pi) => {
    for (let i = 0; i < poly.length; i++) edges.push({ a: poly[i], b: poly[(i + 1) % poly.length], poly: pi, cuts: [] });
  });
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = 0; j < edges.length; j++) {
      const f = edges[j];
      if (f.poly === e.poly) continue;
      const x = segIntersection(e.a, e.b, f.a, f.b, eps);
      if (x) e.cuts.push(x.t);
      for (const v of [f.a, f.b]) {
        const q = closestPointOnSegment(v, e.a, e.b);
        if (q.dist <= eps) e.cuts.push(q.t);
      }
    }
  }
  // 2. Teilkanten klassifizieren: Rand, wenn genau eine Seite in mindestens einer Fläche liegt
  const inAny = (p) => polys.some((poly) => pointInRing(p, poly));
  const boundary = [];
  for (const e of edges) {
    const ts = Array.from(new Set([0, 1, ...e.cuts.map((t) => Math.min(1, Math.max(0, t)))])).sort((x, y) => x - y);
    for (let i = 0; i < ts.length - 1; i++) {
      if (ts[i + 1] - ts[i] < 1e-9) continue;
      const a = { x: e.a.x + (e.b.x - e.a.x) * ts[i], y: e.a.y + (e.b.y - e.a.y) * ts[i] };
      const b = { x: e.a.x + (e.b.x - e.a.x) * ts[i + 1], y: e.a.y + (e.b.y - e.a.y) * ts[i + 1] };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < eps) continue;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const off = Math.max(eps * 0.2, Math.min(eps, len * 0.25));
      const left = inAny({ x: m.x + nx * off, y: m.y + ny * off });
      const right = inAny({ x: m.x - nx * off, y: m.y - ny * off });
      if (left === right) continue;
      boundary.push(left ? { a, b } : { a: b, b: a }); // Innenseite links
    }
  }
  if (!boundary.length) return null;
  // 3. Verketten: Kante an Kante, Punkte innerhalb eps gelten als gleich
  const key = (p) => `${Math.round(p.x / eps)}:${Math.round(p.y / eps)}`;
  const byStart = new Map();
  for (const e of boundary) {
    const k = key(e.a);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(e);
  }
  const used = new Set();
  const loops = [];
  for (const start of boundary) {
    if (used.has(start)) continue;
    const loop = [start.a];
    let cur = start;
    used.add(cur);
    for (let guard = 0; guard < boundary.length + 1; guard++) {
      const nexts = (byStart.get(key(cur.b)) || []).filter((e) => !used.has(e));
      if (!nexts.length) break;
      // Bei mehreren Fortsetzungen die mit dem kleinsten Linksknick (bleibt auf dem äusseren Rand)
      const dirX = cur.b.x - cur.a.x;
      const dirY = cur.b.y - cur.a.y;
      nexts.sort((e1, e2) => turnAngle(dirX, dirY, e1) - turnAngle(dirX, dirY, e2));
      cur = nexts[0];
      used.add(cur);
      if (key(cur.b) === key(start.a)) {
        loop.push(cur.a);
        loops.push(loop);
        break;
      }
      loop.push(cur.a);
    }
  }
  if (!loops.length) return null;
  // 4. Äusserer Ring = grösste Fläche; weitere äussere Ringe heissen: Flächen hängen nicht zusammen
  loops.sort((x, y) => Math.abs(ringAreaXY(y)) - Math.abs(ringAreaXY(x)));
  const outer = loops[0];
  for (const l of loops.slice(1)) {
    const c = { x: l.reduce((s, p) => s + p.x, 0) / l.length, y: l.reduce((s, p) => s + p.y, 0) / l.length };
    if (!pointInRing(c, outer)) return null; // getrennte Fläche
  }
  const out = dropCollinear(outer, eps).map((p) => roundCoord(unproject(p)));
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
}

/** Entfernt Eckpunkte, die auf der Geraden zwischen ihren Nachbarn liegen (Reste geteilter Kanten). */
function dropCollinear(ring, eps) {
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const ux = cur.x - prev.x;
      const uy = cur.y - prev.y;
      const vx = next.x - cur.x;
      const vy = next.y - cur.y;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < eps || lv < eps || (Math.abs(ux * vy - uy * vx) / Math.max(lu, lv) < eps && ux * vx + uy * vy > 0)) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

function turnAngle(dx, dy, e) {
  const ex = e.b.x - e.a.x;
  const ey = e.b.y - e.a.y;
  // Winkel von -π (scharf links) bis π; Innenseite liegt links, der äussere Rand biegt möglichst rechts ab
  return -Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
}

/** Vereinigt die Flächen ids zur ersten; die anderen verschwinden. Liefert die ID oder wirft einen Fehler. */
export function mergeZones(doc, ids) {
  const zones = ids.map((id) => getFeature(doc, id)).filter((f) => f && f.type === 'zone');
  if (zones.length < 2) throw new Error('Mindestens zwei Flächen auswählen.');
  const ring = unionRings(zones.map((z) => z.nodes));
  if (!ring || ring.length < 3) throw new Error('Die Flächen berühren oder überlappen sich nicht – erst aneinanderlegen.');
  const keeper = zones[0];
  keeper.nodes = ring;
  for (const z of zones.slice(1)) removeFeature(doc, z.id);
  return keeper.id;
}

function endDistance(a, b) {
  const pa = project(a);
  const pb = project(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) / mercatorScale(a[0]);
}

/**
 * Hängt Strasse b an Strasse a (an dem Endenpaar mit dem kleinsten Abstand, bis tol m).
 * b wird bei Bedarf umgedreht; Abschnittseigenschaften bleiben, eine Lücke wird zum Abschnitt.
 * Liefert false, wenn die Enden zu weit auseinanderliegen.
 */
export function joinRoad(a, b, tol = JOIN_TOLERANCE) {
  const aS = a.nodes[0];
  const aE = a.nodes[a.nodes.length - 1];
  const bS = b.nodes[0];
  const bE = b.nodes[b.nodes.length - 1];
  const options = [
    { d: endDistance(aE, bS), atEnd: true, reverse: false },
    { d: endDistance(aE, bE), atEnd: true, reverse: true },
    { d: endDistance(aS, bE), atEnd: false, reverse: false },
    { d: endDistance(aS, bS), atEnd: false, reverse: true },
  ].sort((x, y) => x.d - y.d);
  const best = options[0];
  if (best.d > tol) return false;
  let nodes = b.nodes.slice();
  let segs = b.segments.map((s) => ({ ...s }));
  if (best.reverse) {
    nodes.reverse();
    segs.reverse();
  }
  const gap = best.d > MERGE_EPS;
  if (best.atEnd) {
    const joint = gap ? [] : nodes.slice(1);
    const jointSegs = gap ? [{ level: 'ground', maxspeed: null, access: null }, ...segs] : segs;
    a.nodes = a.nodes.concat(gap ? nodes : joint);
    a.segments = a.segments.concat(jointSegs);
  } else {
    const lead = gap ? nodes : nodes.slice(0, -1);
    const leadSegs = gap ? [...segs, { level: 'ground', maxspeed: null, access: null }] : segs;
    a.nodes = lead.concat(a.nodes);
    a.segments = leadSegs.concat(a.segments);
  }
  // Einbahn nur, wenn beide Einbahn sind und die Richtung zusammenpasst
  a.oneway = !!(a.oneway && b.oneway && !best.reverse);
  if (!a.name && b.name) a.name = b.name;
  a.profile = null; // Höhenprofil und Parzellen gelten für die alte Geometrie nicht mehr
  a.parcels = null;
  return true;
}

/** Verbindet die Strassen ids zu einer (die erste bleibt, Enden werden nacheinander angehängt). Liefert die ID oder wirft. */
export function mergeRoads(doc, ids, tol = JOIN_TOLERANCE) {
  const roads = ids.map((id) => getFeature(doc, id)).filter((f) => f && f.type === 'road');
  if (roads.length < 2) throw new Error('Mindestens zwei Strassen auswählen.');
  const keeper = roads[0];
  let rest = roads.slice(1);
  let progress = true;
  while (rest.length && progress) {
    progress = false;
    for (const r of rest) {
      if (joinRoad(keeper, r, tol)) {
        removeFeature(doc, r.id);
        rest = rest.filter((x) => x !== r);
        progress = true;
        break;
      }
    }
  }
  if (rest.length) throw new Error('Die Strassen hängen an den Enden nicht zusammen (bis 10 m Abstand).');
  return keeper.id;
}

/**
 * Zusammenführen der Auswahl: nur Flächen -> vereinigen, nur Strassen -> verbinden.
 * Liefert { id, type } oder wirft einen Fehler mit Erklärung.
 */
export function mergeFeatures(doc, ids) {
  const feats = ids.map((id) => getFeature(doc, id)).filter(Boolean);
  if (feats.length < 2) throw new Error('Mindestens zwei Elemente auswählen.');
  if (feats.every((f) => f.type === 'zone')) return { id: mergeZones(doc, ids), type: 'zone' };
  if (feats.every((f) => f.type === 'road')) return { id: mergeRoads(doc, ids), type: 'road' };
  throw new Error('Nur Flächen mit Flächen oder Strassen mit Strassen lassen sich zusammenführen.');
}

/** Was die Auswahl zusammenführen kann: 'zone', 'road' oder null. */
export function mergeKind(doc, ids) {
  const feats = ids.map((id) => getFeature(doc, id)).filter(Boolean);
  if (feats.length < 2) return null;
  if (feats.every((f) => f.type === 'zone')) return 'zone';
  if (feats.every((f) => f.type === 'road')) return 'road';
  return null;
}
