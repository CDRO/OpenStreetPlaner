// Routen-Rechner: schnellste Fahrroute im heutigen Strassennetz (OSM) und im
// Netz mit den Änderungen des Entwurfs. Reine Funktionen, in Node testbar.
//
// Knoten werden über gerundete Koordinaten identifiziert: OSM-Ways teilen sich
// an Kreuzungen exakt dieselben Punkte, und gezeichnete Strassen rasten auf
// OSM-Punkte ein. Punkte, die auf einen OSM-Abschnitt (nicht auf einen Knoten)
// eingerastet sind, teilen diesen Abschnitt beim Aufbau des Netzes.

import { closestPointOnSegment, haversine, mercatorScale, project, unproject } from './geometry.js';
import { pointInPolygon, segmentSpeed, validProfile, zoneKind } from './model.js';
import { polylineRadii } from './smooth.js';
import { NODE_DELAY, expectedSpeedKmh, segmentGrades, segmentTime, summarize } from './speedmodel.js';

const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road',
]);

const HIGHWAY_SPEED = {
  motorway: 120, motorway_link: 80, trunk: 100, trunk_link: 60, primary: 80, primary_link: 50,
  secondary: 80, secondary_link: 50, tertiary: 80, tertiary_link: 50, unclassified: 60,
  residential: 50, living_street: 20, service: 30, road: 50,
};

const ZONE_SPEED = {
  urban: 50, rural: 80, motorway: 120, trunk: 100, living_street: 20, walk: 5,
};

/** Tempo-Zuschlag in Sekunden beim Durchfahren einer gezeichneten Kreuzung. */
export const JUNCTION_PENALTY = { plain: 0, priority: 3, stop: 8, signals: 20, crossing: 2, busstop: 0 };

/** Strengstes Zonen-Tempolimit an einem Punkt (null = keine Zone mit Limit). */
export function zoneSpeedAt(zones, latlng) {
  let cap = null;
  for (const z of zones) {
    const speed = zoneKind(z).speed;
    if (speed === null || !pointInPolygon(latlng, z.nodes)) continue;
    cap = cap === null ? speed : Math.min(cap, speed);
  }
  return cap;
}

export const ROUNDABOUT_SPEED = 30;

/** OSM-maxspeed-Tag -> km/h oder null ("50", "30 mph", "CH:urban", "walk", "none"). */
export function parseMaxspeed(tag) {
  if (tag === undefined || tag === null) return null;
  const s = String(tag).trim().toLowerCase();
  if (!s || s === 'none' || s === 'signals' || s === 'variable') return null;
  const num = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/.exec(s);
  if (num) {
    const v = parseFloat(num[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.round(num[2] === 'mph' ? v * 1.609344 : v);
  }
  const zone = /^(?:[a-z]{2}(?:-[a-z]+)?:)?([a-z_]+)$/.exec(s);
  if (zone && ZONE_SPEED[zone[1]] !== undefined) return ZONE_SPEED[zone[1]];
  return null;
}

/** Ist ein OSM-Way für Autos befahrbar? */
export function isDrivable(tags = {}) {
  if (!DRIVABLE.has(tags.highway)) return false;
  const access = tags.motor_vehicle || tags.motorcar || tags.vehicle || tags.access;
  if (access === 'no' || access === 'private') return false;
  return true;
}

/** Geschwindigkeit eines OSM-Ways in km/h (maxspeed oder Standard je highway). */
export function waySpeed(tags = {}) {
  return parseMaxspeed(tags.maxspeed) || HIGHWAY_SPEED[tags.highway] || 50;
}

/** -1 = gegen Zeichenrichtung, 1 = in Zeichenrichtung, 0 = beide Richtungen. */
export function wayDirection(tags = {}) {
  if (tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' || tags.junction === 'roundabout') return 1;
  if (tags.oneway === '-1' || tags.oneway === 'reverse') return -1;
  return 0;
}

export const keyOf = (ll) => `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`;

export class Graph {
  constructor(model = 'limit') {
    this.model = model; // 'limit' = Tempolimit, 'geometry' = Kurven, Steigung, Streuung
    this.nodes = new Map(); // key -> { latlng, edges: [{ to, dist, time, variance }] }
    this.penalty = new Map(); // key -> { mean, variance } in Sekunden
    this.segments = []; // für die Suche nach dem nächsten Punkt: { a, b, ka, kb, speed, dir }
    this.speedCap = null; // (latlng) -> km/h oder null; deckelt Abschnitte in Zonen
  }

  node(ll) {
    const k = keyOf(ll);
    let n = this.nodes.get(k);
    if (!n) {
      n = { latlng: ll, edges: [] };
      this.nodes.set(k, n);
    }
    return k;
  }

  /**
   * Verbindet a und b; dir 0 = beide Richtungen, 1 = nur a->b, -1 = nur b->a.
   * geo = { radiusA, radiusB, grade } fliesst nur im Geometriemodell ein.
   */
  link(a, b, speedKmh, dir = 0, geo = null) {
    if (this.speedCap) {
      const cap = this.speedCap([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      if (cap !== null) speedKmh = Math.min(speedKmh, cap);
    }
    if (!(speedKmh > 0)) return;
    const ka = this.node(a);
    const kb = this.node(b);
    if (ka === kb) return;
    const dist = haversine(a, b);
    let time;
    let variance = 0;
    if (this.model === 'geometry') {
      const v = expectedSpeedKmh({ limitKmh: speedKmh, radiusStart: geo ? geo.radiusA : Infinity, radiusEnd: geo ? geo.radiusB : Infinity, gradePercent: geo ? geo.grade : 0 });
      const t = segmentTime(dist, v);
      time = t.mean;
      variance = t.variance;
    } else {
      time = dist / (speedKmh / 3.6);
    }
    if (dir >= 0) this.nodes.get(ka).edges.push({ to: kb, dist, time, variance });
    if (dir <= 0) this.nodes.get(kb).edges.push({ to: ka, dist, time, variance });
    this.segments.push({ a, b, ka, kb, speed: speedKmh, dir });
  }

  /** Linienzug mit einer Geschwindigkeit; im Geometriemodell mit Kurvenradien. */
  addPolyline(points, speedKmh, dir = 0, grades = null) {
    this.addPolylineSpeeds(points, points.slice(1).map(() => speedKmh), dir, grades);
  }

  /** Linienzug mit Geschwindigkeit je Abschnitt (speeds.length = points.length - 1). */
  addPolylineSpeeds(points, speeds, dir = 0, grades = null) {
    const radii = this.model === 'geometry' ? polylineRadii(points) : null;
    for (let i = 1; i < points.length; i++) {
      const geo = radii ? { radiusA: radii[i - 1], radiusB: radii[i], grade: grades ? grades[i - 1] : 0 } : null;
      // Steigung wirkt in Fahrtrichtung; bei beiden Richtungen nehmen wir den Betrag konservativ als bergauf.
      if (geo && dir === 0 && geo.grade) geo.grade = Math.abs(geo.grade);
      if (geo && dir === -1 && geo.grade) geo.grade = -geo.grade;
      this.link(points[i - 1], points[i], speeds[i - 1], dir, geo);
    }
  }

  addPenalty(ll, mean, sd = 0) {
    if (!(mean > 0) && !(sd > 0)) return;
    const k = keyOf(ll);
    const cur = this.penalty.get(k) || { mean: 0, variance: 0 };
    this.penalty.set(k, { mean: cur.mean + mean, variance: cur.variance + sd * sd });
  }
}

/** Fügt Punkte, die auf einem Abschnitt der Linie liegen, als Zwischenpunkte ein (Toleranz in Metern). */
export function insertPointsOnLine(points, candidates, toleranceMeters = 1) {
  if (!candidates.length || points.length < 2) return points;
  const proj = points.map(project);
  const scale = mercatorScale(points[0][0]);
  const tol = toleranceMeters * scale;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push(points[i]);
    const a = proj[i];
    const b = proj[i + 1];
    const minX = Math.min(a.x, b.x) - tol;
    const maxX = Math.max(a.x, b.x) + tol;
    const minY = Math.min(a.y, b.y) - tol;
    const maxY = Math.max(a.y, b.y) + tol;
    const hits = [];
    for (const c of candidates) {
      const p = c.p;
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
      const q = closestPointOnSegment(p, a, b);
      if (q.dist <= tol && q.t > 1e-6 && q.t < 1 - 1e-6) hits.push({ t: q.t, ll: c.ll });
    }
    hits.sort((x, y) => x.t - y.t);
    for (const h of hits) {
      if (keyOf(h.ll) !== keyOf(out[out.length - 1])) out.push(h.ll);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Baut das Netz. mode 'current' = nur OSM; 'proposed' = OSM plus Entwurf:
 * übernommene Strassen (osmId) ersetzen ihren OSM-Way, Rückbau entfernt ihn,
 * neue Strassen kommen dazu, Kreisel verbinden ihre Anschlüsse, Kreuzungen
 * kosten Zeit.
 */
export function buildGraph({ osmWays = [], doc = null, mode = 'current', model = 'limit' }) {
  const g = new Graph(model);
  const geometry = model === 'geometry';
  // Nur sichtbare Ebenen zählen: Ebenen ein- und ausblenden ist der Variantenvergleich.
  const hidden = doc ? new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id)) : new Set();
  const visible = mode === 'proposed' && doc ? doc.features.filter((f) => !hidden.has(f.layerId)) : [];
  const roads = visible.filter((f) => f.type === 'road');
  const zones = visible.filter((f) => f.type === 'zone' && zoneKind(f).speed !== null);
  if (zones.length) g.speedCap = (ll) => zoneSpeedAt(zones, ll);
  const replaced = new Set(roads.filter((r) => r.osmId).map((r) => r.osmId));
  const draftNodes = [];
  for (const r of roads) {
    if (r.status === 'remove') continue;
    for (const n of r.nodes) draftNodes.push({ ll: n, p: project(n) });
  }
  for (const w of osmWays) {
    if (replaced.has(w.id) || !isDrivable(w.tags)) continue;
    const pts = draftNodes.length ? insertPointsOnLine(w.geometry, draftNodes) : w.geometry;
    g.addPolyline(pts, waySpeed(w.tags), wayDirection(w.tags));
  }
  if (mode === 'proposed' && doc) {
    const roundabouts = visible.filter((f) => f.type === 'roundabout');
    for (const r of roads) {
      if (r.status === 'remove') continue;
      const speeds = r.segments.map((_, i) => segmentSpeed(r, i));
      let grades = null;
      const profile = geometry ? validProfile(r) : null;
      if (profile) {
        const dists = [0];
        for (let i = 1; i < r.nodes.length; i++) dists.push(dists[i - 1] + haversine(r.nodes[i - 1], r.nodes[i]));
        grades = segmentGrades(dists, profile.points);
      }
      g.addPolylineSpeeds(r.nodes, speeds, r.oneway ? 1 : 0, grades);
    }
    for (const k of roundabouts) {
      const c = project(k.center);
      const scale = mercatorScale(k.center[0]);
      let attached = false;
      for (const n of draftNodes) {
        const d = Math.hypot(n.p.x - c.x, n.p.y - c.y) / scale;
        if (Math.abs(d - k.radius) <= 1.5) {
          g.link(n.ll, k.center, ROUNDABOUT_SPEED, 0);
          attached = true;
        }
      }
      if (attached && geometry) g.addPenalty(k.center, NODE_DELAY.roundabout.mean, NODE_DELAY.roundabout.sd);
    }
    for (const j of visible) {
      if (j.type !== 'junction') continue;
      if (geometry) {
        const d = NODE_DELAY[j.kind] || NODE_DELAY.plain;
        g.addPenalty(j.at, d.mean, d.sd);
      } else {
        g.addPenalty(j.at, JUNCTION_PENALTY[j.kind] || 0);
      }
    }
  }
  return g;
}

/** Nächster Punkt auf dem Netz zu ll; verknüpft ihn als temporären Knoten. */
export function attachPoint(g, ll, maxMeters = 300) {
  const p = project(ll);
  const scale = mercatorScale(ll[0]);
  const tol = maxMeters * scale;
  let best = null;
  for (const s of g.segments) {
    const a = project(s.a);
    const b = project(s.b);
    if (p.x < Math.min(a.x, b.x) - tol || p.x > Math.max(a.x, b.x) + tol || p.y < Math.min(a.y, b.y) - tol || p.y > Math.max(a.y, b.y) + tol) continue;
    const q = closestPointOnSegment(p, a, b);
    if (q.dist <= tol && (!best || q.dist < best.dist)) best = { ...q, seg: s };
  }
  if (!best) return null;
  const onLine = unproject(best);
  const key = keyOf(onLine);
  if (!g.nodes.has(key)) {
    const s = best.seg;
    g.link(s.a, onLine, s.speed, s.dir);
    g.link(onLine, s.b, s.speed, s.dir);
  }
  return { key, latlng: onLine, distanceMeters: best.dist / scale };
}

class MinHeap {
  constructor() {
    this.a = [];
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/** Schnellste Route (nach Zeit). Liefert { path: [[lat,lng]], dist, time } oder null. */
export function shortestPath(g, fromKey, toKey) {
  if (!g.nodes.has(fromKey) || !g.nodes.has(toKey)) return null;
  const best = new Map([[fromKey, { cost: 0, dist: 0, variance: 0, prev: null }]]);
  const heap = new MinHeap();
  heap.push({ key: fromKey, cost: 0 });
  const done = new Set();
  while (heap.size) {
    const { key, cost } = heap.pop();
    if (done.has(key)) continue;
    done.add(key);
    if (key === toKey) break;
    const node = g.nodes.get(key);
    const pen = key === fromKey ? null : g.penalty.get(key);
    const penalty = pen ? pen.mean : 0;
    const penVar = pen ? pen.variance : 0;
    for (const e of node.edges) {
      const c = cost + penalty + e.time;
      const cur = best.get(e.to);
      if (!cur || c < cur.cost) {
        const here = best.get(key);
        best.set(e.to, { cost: c, dist: here.dist + e.dist, variance: here.variance + penVar + (e.variance || 0), prev: key });
        heap.push({ key: e.to, cost: c });
      }
    }
  }
  const end = best.get(toKey);
  if (!end || !done.has(toKey)) return null;
  const path = [];
  for (let k = toKey; k; k = best.get(k).prev) path.push(g.nodes.get(k).latlng);
  path.reverse();
  const band = summarize(end.cost, end.variance);
  return { path, dist: end.dist, time: end.cost, sd: band.sd, p15: band.p15, p85: band.p85 };
}

/** Beide Netze rechnen. Liefert { current, proposed, network: { current: n, proposed: n } }. */
export function computeRoutes({ osmWays, doc, from, to, model = 'limit' }) {
  const result = { current: null, proposed: null, error: null, model };
  for (const mode of ['current', 'proposed']) {
    const g = buildGraph({ osmWays, doc, mode, model });
    const a = attachPoint(g, from);
    const b = attachPoint(g, to);
    if (!a || !b) {
      result[mode] = { error: !a ? 'Start liegt nicht in der Nähe einer befahrbaren Strasse.' : 'Ziel liegt nicht in der Nähe einer befahrbaren Strasse.' };
      continue;
    }
    const r = shortestPath(g, a.key, b.key);
    result[mode] = r ? { ...r, path: [from, ...r.path, to] } : { error: 'Keine Verbindung im Netz gefunden (Strassennetz für den ganzen Bereich geladen?).' };
  }
  return result;
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  return `${m}:${String(rest).padStart(2, '0')} min`;
}
