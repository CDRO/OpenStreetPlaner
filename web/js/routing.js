// Routen-Rechner: schnellste Fahrroute im heutigen Strassennetz (OSM) und im
// Netz mit den Änderungen des Entwurfs. Reine Funktionen, in Node testbar.
//
// Knoten werden über gerundete Koordinaten identifiziert: OSM-Ways teilen sich
// an Kreuzungen exakt dieselben Punkte, und gezeichnete Strassen rasten auf
// OSM-Punkte ein. Punkte, die auf einen OSM-Abschnitt (nicht auf einen Knoten)
// eingerastet sind, teilen diesen Abschnitt beim Aufbau des Netzes.

import { closestPointOnSegment, haversine, mercatorScale, project, unproject } from './geometry.js';
import { BUS_DWELL_DEFAULT, junctionTurns, pointInPolygon, segmentAccess, segmentSpeed, validProfile, zoneKind, roadKind } from './model.js';
import { polylineRadii } from './smooth.js';
import { NODE_DELAY, expectedSpeedKmh, segmentGrades, segmentTime, summarize } from './speedmodel.js';

const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road',
]);

/** Wege, die nur für Velo bzw. zu Fuss zählen (zusätzlich zu den befahrbaren Strassen). */
const BIKE_WAYS = new Set(['cycleway', 'path', 'track', 'footway', 'pedestrian', 'bridleway']);
const FOOT_WAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'track', 'cycleway', 'bridleway']);
const MOTOR_ONLY = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
/** Pauschale Geschwindigkeiten (km/h) je Weg für Velo; Strassen 17, zu Fuss 4.8 (Treppen 2.5). */
export const BIKE_SPEED = { cycleway: 18, path: 12, footway: 10, pedestrian: 8, track: 14, living_street: 15, service: 16 };
export const BIKE_ROAD_SPEED = 17;
export const FOOT_SPEED = 4.8;
export const FOOT_STEPS_SPEED = 2.5;
export const VEHICLE_IDS = ['car', 'bus', 'bike', 'foot'];

const HIGHWAY_SPEED = {
  motorway: 120, motorway_link: 80, trunk: 100, trunk_link: 60, primary: 80, primary_link: 50,
  secondary: 80, secondary_link: 50, tertiary: 80, tertiary_link: 50, unclassified: 60,
  residential: 50, living_street: 20, service: 30, road: 50,
};

const ZONE_SPEED = {
  urban: 50, rural: 80, motorway: 120, trunk: 100, living_street: 20, walk: 5,
};

/** Tempo-Zuschlag in Sekunden beim Durchfahren einer gezeichneten Kreuzung. */
export const JUNCTION_PENALTY = { plain: 0, priority: 3, stop: 8, signals: 20, crossing: 2, busstop: 0, interchange: 0 };

/** Abbiegekosten in Sekunden (Erwartungswert, Streuung) an Knoten mit mindestens drei Armen. */
export const TURN_COST = {
  straight: { mean: 0, sd: 0 },
  right: { mean: 2, sd: 1 },
  left: { mean: 5, sd: 3 },
  uturn: { mean: 15, sd: 5 },
};

/**
 * Art des Abbiegens aus dem Richtungswechsel: Kurs vorher (a->b) und nachher (b->c).
 * Rechtsverkehr: Drehung im Uhrzeigersinn = rechts.
 */
export function turnKind(a, b, c) {
  const pa = project(a);
  const pb = project(b);
  const pc = project(c);
  const h1 = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  const h2 = Math.atan2(pc.y - pb.y, pc.x - pb.x);
  let d = ((h2 - h1) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  // Mercator-y wächst nach Norden: positiver Winkel = Drehung gegen den Uhrzeigersinn = links
  if (Math.abs(d) < 30) return 'straight';
  if (Math.abs(d) >= 150) return 'uturn';
  return d > 0 ? 'left' : 'right';
}

/** Strengstes Zonen-Tempolimit an einem Punkt (null = keine Zone mit Limit). Busse dürfen freigegebene Flächen mit 20 km/h durchfahren. */
export function zoneSpeedAt(zones, latlng, vehicle = 'car') {
  if (vehicle === 'foot') return null; // zu Fuss gilt keine Zone als Sperre oder Limit
  let cap = null;
  for (const z of zones) {
    let speed = zoneKind(z).speed;
    if (speed === null || !pointInPolygon(latlng, z.nodes)) continue;
    if (vehicle === 'bus' && z.busAllowed && speed < 20) speed = 20;
    if (vehicle === 'bike' && speed < 8) speed = 8; // Fussgängerzone: langsam fahren oder schieben
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

/** Ist ein OSM-Way befahrbar? vehicle 'car' (Standard) oder 'bus' (Busspuren, bus=yes, psv=yes). */
export function isDrivable(tags = {}, vehicle = 'car') {
  const hw = tags.highway;
  if (vehicle === 'bike') {
    if (!hw || MOTOR_ONLY.has(hw) || hw === 'steps') return false;
    if (tags.bicycle === 'no' || tags.bicycle === 'dismount') return false;
    const allowed = ['yes', 'designated', 'permissive'].includes(tags.bicycle);
    if ((hw === 'footway' || hw === 'pedestrian') && !allowed) return false;
    if (!DRIVABLE.has(hw) && !BIKE_WAYS.has(hw)) return false;
    if ((tags.access === 'no' || tags.access === 'private' || tags.vehicle === 'no') && !allowed) return false;
    return true;
  }
  if (vehicle === 'foot') {
    if (!hw || MOTOR_ONLY.has(hw)) return false;
    if (tags.foot === 'no') return false;
    const allowed = ['yes', 'designated', 'permissive'].includes(tags.foot);
    if (!DRIVABLE.has(hw) && !FOOT_WAYS.has(hw)) return false;
    if ((tags.access === 'no' || tags.access === 'private') && !allowed) return false;
    return true;
  }
  const busOk = tags.bus === 'yes' || tags.psv === 'yes' || tags.highway === 'busway';
  if (vehicle === 'bus' && busOk && (DRIVABLE.has(tags.highway) || tags.highway === 'busway')) return true;
  if (!DRIVABLE.has(tags.highway)) return false;
  if (vehicle === 'bus' && (tags.bus === 'no' || tags.psv === 'no')) return false;
  const access = tags.motor_vehicle || tags.motorcar || tags.vehicle || tags.access;
  if (access === 'no' || access === 'private') return false;
  return true;
}

/** Geschwindigkeit eines OSM-Ways in km/h (maxspeed oder Standard je highway); Velo und zu Fuss pauschal. */
export function waySpeed(tags = {}, vehicle = 'car') {
  if (vehicle === 'foot') return tags.highway === 'steps' ? FOOT_STEPS_SPEED : FOOT_SPEED;
  if (vehicle === 'bike') return BIKE_SPEED[tags.highway] || BIKE_ROAD_SPEED;
  return parseMaxspeed(tags.maxspeed) || HIGHWAY_SPEED[tags.highway] || 50;
}

const CYCLE_TAGS = ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'];
const QUIET_WAYS = new Set(['cycleway', 'path', 'track', 'footway', 'pedestrian', 'living_street', 'service', 'residential', 'bridleway', 'steps']);

/**
 * Unsicherer Abschnitt für Velo bzw. zu Fuss: schnelle Strasse (ab 50 km/h) ohne Velostreifen/Radweg
 * bzw. ohne Trottoir. Quartierstrassen und eigene Wege gelten als sicher.
 */
export function unsafeFor(tags = {}, vehicle) {
  if (vehicle !== 'bike' && vehicle !== 'foot') return false;
  const hw = tags.highway;
  if (QUIET_WAYS.has(hw)) return false;
  const speed = parseMaxspeed(tags.maxspeed) || HIGHWAY_SPEED[hw] || 50;
  if (speed < 50) return false;
  if (vehicle === 'bike') return !CYCLE_TAGS.some((k) => tags[k] && tags[k] !== 'no' && tags[k] !== 'none');
  const sw = tags.sidewalk || tags['sidewalk:both'] || tags['sidewalk:left'] || tags['sidewalk:right'];
  return !sw || sw === 'no' || sw === 'none';
}

/** Unsicherer Abschnitt einer gezeichneten Strasse (schnell, ohne Velostreifen bzw. Trottoir im Querschnitt). */
export function draftUnsafe(road, i, vehicle) {
  if (vehicle !== 'bike' && vehicle !== 'foot') return false;
  const kind = roadKind(road);
  if (kind.id === 'path' || kind.id === 'residential' || kind.id === 'service') return false;
  if (segmentSpeed(road, i) < 50) return false;
  const sec = road.section;
  if (vehicle === 'bike') return !(sec && (sec.bikeLeft || sec.bikeRight));
  return !(sec && (sec.walkLeft || sec.walkRight));
}

/** Tempo einer gezeichneten Strasse je Verkehrsmittel (0 = nicht befahrbar). */
export function draftSpeed(road, i, vehicle) {
  const kind = roadKind(road);
  const access = segmentAccess(road, i);
  if (vehicle === 'foot') return kind.motorOnly ? 0 : FOOT_SPEED;
  if (vehicle === 'bike') {
    if (kind.motorOnly) return 0;
    if (kind.id === 'path') return BIKE_SPEED.path;
    return Math.min(BIKE_ROAD_SPEED, segmentSpeed(road, i) || BIKE_ROAD_SPEED);
  }
  if (access === 'bus') return vehicle === 'bus' ? Math.min(30, segmentSpeed(road, i)) : 0;
  return segmentSpeed(road, i);
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
    this.degree = new Map(); // key -> Zahl der Nachbarknoten (Arme), unabhängig von der Richtung
    this.junctions = new Map(); // key -> { kind, turns } gezeichneter Kreuzungen (Abbiegeregeln)
    this.turnCosts = true; // Abbiegekosten nach Winkel an Knoten mit >= 3 Armen
  }

  /** Abbiegeregeln an einem Knoten setzen; kind 'roundabout' = frei drehen ohne Kosten. */
  setJunction(ll, kind, turns) {
    this.junctions.set(keyOf(ll), { kind, turns });
  }

  /**
   * Kosten (Sekunden) und Streuung für das Abbiegen prev -> node -> next;
   * null, wenn das Abbiegen verboten ist.
   */
  turnCost(prevKey, nodeKey, nextKey) {
    const zero = { mean: 0, variance: 0 };
    if (!this.turnCosts || this.vehicle === 'foot') return zero; // zu Fuss: weder Wartezeit noch Abbiegeverbot
    const j = this.junctions.get(nodeKey);
    if (j && j.kind === 'roundabout') return zero;
    const kind = turnKind(this.nodes.get(prevKey).latlng, this.nodes.get(nodeKey).latlng, this.nodes.get(nextKey).latlng);
    if (j) {
      if (j.turns && j.turns[kind] === false) return null;
      if (j.kind === 'interchange') return zero; // kreuzungsfrei: kein Warten auf Gegenverkehr
    }
    const scale = this.vehicle === 'bike' ? 0.5 : 1;
    const cost = (k) => ({ mean: TURN_COST[k].mean * scale, variance: TURN_COST[k].sd * TURN_COST[k].sd * scale * scale });
    if (kind === 'uturn') return cost('uturn'); // Wenden kostet überall, auch am Ende einer Sackgasse
    if (!j && (this.degree.get(nodeKey) || 0) < 3) return zero; // Knick ohne Abzweigung
    return cost(kind);
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
  link(a, b, speedKmh, dir = 0, geo = null, meta = null) {
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
    // Herkunft für die Zuversicht: assumed = Tempo geschätzt (kein maxspeed-Tag / kein Limit gesetzt),
    // draft = gezeichnete Strasse, noProfile = Steigung unbekannt (nur im Geometriemodell relevant)
    const assumed = !!(meta && meta.assumed);
    const draft = !!(meta && meta.draft);
    const noProfile = !!(meta && meta.noProfile);
    const unsafe = !!(meta && meta.unsafe);
    if (dir >= 0) this.nodes.get(ka).edges.push({ to: kb, dist, time, variance, assumed, draft, noProfile, unsafe });
    if (dir <= 0) this.nodes.get(kb).edges.push({ to: ka, dist, time, variance, assumed, draft, noProfile, unsafe });
    this.degree.set(ka, (this.degree.get(ka) || 0) + 1);
    this.degree.set(kb, (this.degree.get(kb) || 0) + 1);
    this.segments.push({ a, b, ka, kb, speed: speedKmh, dir });
  }

  /** Linienzug mit einer Geschwindigkeit; im Geometriemodell mit Kurvenradien. */
  addPolyline(points, speedKmh, dir = 0, grades = null, meta = null) {
    this.addPolylineSpeeds(points, points.slice(1).map(() => speedKmh), dir, grades, meta);
  }

  /** Linienzug mit Geschwindigkeit je Abschnitt (speeds.length = points.length - 1); meta als Objekt oder je Abschnitt. */
  addPolylineSpeeds(points, speeds, dir = 0, grades = null, meta = null) {
    const radii = this.model === 'geometry' ? polylineRadii(points) : null;
    for (let i = 1; i < points.length; i++) {
      const geo = radii ? { radiusA: radii[i - 1], radiusB: radii[i], grade: grades ? grades[i - 1] : 0 } : null;
      // Steigung wirkt in Fahrtrichtung; bei beiden Richtungen nehmen wir den Betrag konservativ als bergauf.
      if (geo && dir === 0 && geo.grade) geo.grade = Math.abs(geo.grade);
      if (geo && dir === -1 && geo.grade) geo.grade = -geo.grade;
      this.link(points[i - 1], points[i], speeds[i - 1], dir, geo, Array.isArray(meta) ? meta[i - 1] : meta);
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
export function buildGraph({ osmWays = [], doc = null, mode = 'current', model = 'limit', vehicle = 'car' }) {
  const g = new Graph(model);
  g.vehicle = vehicle;
  const geometry = model === 'geometry';
  // Nur sichtbare Ebenen zählen: Ebenen ein- und ausblenden ist der Variantenvergleich.
  const hidden = doc ? new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id)) : new Set();
  const visible = mode === 'proposed' && doc ? doc.features.filter((f) => !hidden.has(f.layerId)) : [];
  const roads = visible.filter((f) => f.type === 'road');
  const zones = visible.filter((f) => f.type === 'zone' && zoneKind(f).speed !== null);
  if (zones.length) g.speedCap = (ll) => zoneSpeedAt(zones, ll, vehicle);
  const replaced = new Set(roads.filter((r) => r.osmId).map((r) => r.osmId));
  const draftNodes = [];
  for (const r of roads) {
    if (r.status === 'remove') continue;
    for (const n of r.nodes) draftNodes.push({ ll: n, p: project(n) });
  }
  for (const w of osmWays) {
    if (replaced.has(w.id) || !isDrivable(w.tags, vehicle)) continue;
    const pts = draftNodes.length ? insertPointsOnLine(w.geometry, draftNodes) : w.geometry;
    const dir = vehicle === 'foot' ? 0 : wayDirection(w.tags); // Einbahnen gelten nicht zu Fuss
    g.addPolyline(pts, waySpeed(w.tags, vehicle), dir, null, { assumed: vehicle === 'car' || vehicle === 'bus' ? parseMaxspeed(w.tags.maxspeed) === null : true, noProfile: geometry, unsafe: unsafeFor(w.tags, vehicle) });
  }
  if (mode === 'proposed' && doc) {
    const roundabouts = visible.filter((f) => f.type === 'roundabout');
    for (const r of roads) {
      if (r.status === 'remove') continue;
      // Busschleusen (Zugang nur Bus) sind für Autos gesperrt; Busse fahren dort höchstens 30; Velo und Fuss pauschal
      const speeds = r.segments.map((_, i) => draftSpeed(r, i, vehicle));
      let grades = null;
      const profile = geometry ? validProfile(r) : null;
      if (profile) {
        const dists = [0];
        for (let i = 1; i < r.nodes.length; i++) dists.push(dists[i - 1] + haversine(r.nodes[i - 1], r.nodes[i]));
        grades = segmentGrades(dists, profile.points);
      }
      const metas = r.segments.map((seg, i) => ({ draft: true, assumed: vehicle === 'bike' || vehicle === 'foot' || (!(seg && seg.maxspeed) && !r.maxspeed), noProfile: geometry && !profile, unsafe: draftUnsafe(r, i, vehicle) }));
      g.addPolylineSpeeds(r.nodes, speeds, r.oneway && vehicle !== 'foot' ? 1 : 0, grades, metas);
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
      if (attached) g.setJunction(k.center, 'roundabout', null);
    }
    for (const j of visible) {
      if (j.type !== 'junction') continue;
      if (vehicle === 'foot') {
        if (j.kind === 'signals') g.addPenalty(j.at, 15, geometry ? 10 : 0);
      } else if (geometry) {
        const d = NODE_DELAY[j.kind] || NODE_DELAY.plain;
        g.addPenalty(j.at, d.mean, d.sd);
      } else {
        g.addPenalty(j.at, JUNCTION_PENALTY[j.kind] || 0);
      }
      if (j.kind !== 'crossing' && j.kind !== 'busstop') g.setJunction(j.at, j.kind, junctionTurns(j));
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

/**
 * Dijkstra über Zustände (Knoten, Vorgänger), damit Abbiegekosten und -verbote
 * am Knoten aus dem Richtungswechsel folgen. Stoppt bei toKey oder wenn alle
 * Zustände unter maxCost abgearbeitet sind. Liefert { best, endState, nodeCost }.
 */
export function search(g, fromKey, { toKey = null, maxCost = Infinity } = {}) {
  const stateKey = (node, prev) => (prev ? `${node}|${prev}` : node);
  const best = new Map([[fromKey, { node: fromKey, prev: null, cost: 0, dist: 0, variance: 0, from: null, assumedDist: 0, draftDist: 0, noProfileDist: 0, unsafeDist: 0 }]]);
  const nodeCost = new Map([[fromKey, 0]]);
  const heap = new MinHeap();
  heap.push({ state: fromKey, node: fromKey, prev: null, cost: 0 });
  const done = new Set();
  let endState = null;
  while (heap.size) {
    const { state, node: key, prev, cost } = heap.pop();
    if (done.has(state)) continue;
    done.add(state);
    if (cost > maxCost) break;
    if (!nodeCost.has(key) || cost < nodeCost.get(key)) nodeCost.set(key, cost);
    if (toKey !== null && key === toKey) {
      endState = state;
      break;
    }
    const node = g.nodes.get(key);
    const pen = key === fromKey ? null : g.penalty.get(key);
    const penalty = pen ? pen.mean : 0;
    const penVar = pen ? pen.variance : 0;
    const here = best.get(state);
    for (const e of node.edges) {
      let turn = { mean: 0, variance: 0 };
      if (prev) {
        turn = g.turnCost(prev, key, e.to);
        if (!turn) continue; // Abbiegeverbot
      }
      const c = cost + penalty + turn.mean + e.time;
      const next = stateKey(e.to, key);
      const cur = best.get(next);
      if (!cur || c < cur.cost) {
        best.set(next, {
          node: e.to, prev: key, cost: c, dist: here.dist + e.dist, variance: here.variance + penVar + turn.variance + (e.variance || 0), from: state,
          assumedDist: here.assumedDist + (e.assumed ? e.dist : 0), draftDist: here.draftDist + (e.draft ? e.dist : 0), noProfileDist: here.noProfileDist + (e.noProfile ? e.dist : 0), unsafeDist: here.unsafeDist + (e.unsafe ? e.dist : 0),
        });
        heap.push({ state: next, node: e.to, prev: key, cost: c });
      }
    }
  }
  return { best, endState, nodeCost };
}

/** Schnellste Route (nach Zeit). Liefert { path: [[lat,lng]], dist, time, sd, p15, p85 } oder null. */
export function shortestPath(g, fromKey, toKey) {
  if (!g.nodes.has(fromKey) || !g.nodes.has(toKey)) return null;
  const { best, endState } = search(g, fromKey, { toKey });
  if (!endState) return null;
  const end = best.get(endState);
  const path = [];
  for (let st = endState; st; st = best.get(st).from) path.push(g.nodes.get(best.get(st).node).latlng);
  path.reverse();
  const band = summarize(end.cost, end.variance);
  return { path, dist: end.dist, time: end.cost, sd: band.sd, p15: band.p15, p85: band.p85, quality: { dist: end.dist, assumedDist: end.assumedDist, draftDist: end.draftDist, noProfileDist: end.noProfileDist, unsafeDist: end.unsafeDist, model: g.model, vehicle: g.vehicle } };
}

/** Fahrzeit (s) zu jedem erreichbaren Knoten bis maxSeconds: Map Knoten-Key -> Sekunden. */
export function reachTimes(g, fromKey, maxSeconds) {
  if (!g.nodes.has(fromKey)) return new Map();
  const { nodeCost } = search(g, fromKey, { maxCost: maxSeconds });
  for (const [k, t] of nodeCost) if (t > maxSeconds) nodeCost.delete(k);
  return nodeCost;
}

/**
 * Zerlegt die Kanten in Stücke je Zeitband: bands = Sekunden-Schwellen aufsteigend.
 * Jede ungerichtete Kante zählt einmal; sind beide Enden erreicht, trifft sich die
 * Ausbreitung in der Mitte (Zeit an Position = Minimum beider Richtungen).
 * Liefert [{ a, b, band, dist }] (band = Index der Schwelle, in der das Stück liegt).
 */
export function isochronePieces(g, times, bands) {
  const pieces = [];
  const maxT = bands[bands.length - 1];
  const seen = new Set();
  const emit = (a, b, t0, tEnd, T, dist, assumed = false) => {
    // Stücke von a (Zeit t0) Richtung b bis zur Zeit tEnd (höchstens t0 + T)
    let lo = t0;
    const stop = Math.min(tEnd, t0 + T, maxT);
    for (let i = 0; i < bands.length && lo < stop; i++) {
      const hi = Math.min(stop, bands[i]);
      if (hi <= lo) continue;
      const f0 = (lo - t0) / T;
      const f1 = (hi - t0) / T;
      pieces.push({
        assumed: !!assumed,
        a: [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0],
        b: [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1],
        band: i,
        dist: dist * (f1 - f0),
      });
      lo = hi;
    }
  };
  for (const [key, tu] of times) {
    const node = g.nodes.get(key);
    for (const e of node.edges) {
      if (!(e.time > 0)) continue;
      const id = key < e.to ? `${key}>${e.to}` : `${e.to}>${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const other = g.nodes.get(e.to);
      const tv = times.has(e.to) ? times.get(e.to) : Infinity;
      const back = other.edges.find((x) => x.to === key);
      const Tback = back && back.time > 0 ? back.time : e.time;
      // Treffpunkt in der Zeit, wenn beide Enden erreicht sind
      const tm = Number.isFinite(tv) ? (tu + tv + Math.min(e.time, Tback)) / 2 : Infinity;
      emit(node.latlng, other.latlng, tu, tm, e.time, e.dist, e.assumed);
      if (Number.isFinite(tv) && back) emit(other.latlng, node.latlng, tv, tm, Tback, e.dist, e.assumed);
    }
  }
  return pieces;
}

/**
 * Erreichbarkeit ab einem Punkt. mode 'current' | 'proposed' | 'diff'; minutes aufsteigend.
 * Liefert { mode, minutes, pieces, stats } oder { error }.
 * Bei 'diff' trägt jedes Stück status 'gained' (nur neu), 'lost' (nur heute) oder 'both';
 * stats = { gainedKm, lostKm, bothKm }. Sonst stats = { km: [je Band kumuliert] }.
 */
export function computeIsochrone({ osmWays, doc, from, minutes = [5, 10, 15], mode = 'proposed', model = 'limit', graphs = null }) {
  const bands = minutes.map((m) => m * 60);
  const maxT = bands[bands.length - 1];
  const run = (m) => {
    const g = graphs && graphs[m] ? graphs[m] : buildGraph({ osmWays, doc, mode: m, model });
    const start = attachPoint(g, from);
    if (!start) return null;
    const times = reachTimes(g, start.key, maxT);
    return { g, times };
  };
  if (mode !== 'diff') {
    const r = run(mode);
    if (!r) return { error: 'Der Ursprung liegt nicht in der Nähe einer befahrbaren Strasse.' };
    const pieces = isochronePieces(r.g, r.times, bands);
    const km = bands.map(() => 0);
    let assumedDist = 0;
    let dist = 0;
    for (const p of pieces) {
      km[p.band] += p.dist / 1000;
      dist += p.dist;
      if (p.assumed) assumedDist += p.dist;
    }
    for (let i = 1; i < km.length; i++) km[i] += km[i - 1];
    return { mode, minutes, pieces, stats: { km: km.map((v) => Math.round(v * 10) / 10) }, quality: { dist, assumedDist, draftDist: 0, noProfileDist: 0, model } };
  }
  const cur = run('current');
  const neu = run('proposed');
  if (!cur || !neu) return { error: 'Der Ursprung liegt nicht in der Nähe einer befahrbaren Strasse.' };
  // Vergleich auf den Kanten des Netzes mit Entwurf (es enthält auch die heutigen Strassen ausser Rückbau)
  const pieces = [];
  const stats = { gainedKm: 0, lostKm: 0, bothKm: 0 };
  const quality = { dist: 0, assumedDist: 0, draftDist: 0, noProfileDist: 0, model };
  const seen = new Set();
  // Eine Kante gilt in einem Netz als erreicht, wenn sie dort existiert und eines ihrer Enden erreicht ist
  const edgeReached = (g, times, u, v) => {
    if (!times.has(u) && !times.has(v)) return false;
    const nu = g.nodes.get(u);
    const nv = g.nodes.get(v);
    return !!((nu && nu.edges.some((e) => e.to === v)) || (nv && nv.edges.some((e) => e.to === u)));
  };
  const classify = (g, times, otherG, other, statusIfOnly) => {
    for (const [key] of times) {
      const node = g.nodes.get(key);
      for (const e of node.edges) {
        const id = key < e.to ? `${key}>${e.to}` : `${e.to}>${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const status = edgeReached(otherG, other, key, e.to) ? 'both' : statusIfOnly;
        pieces.push({ a: node.latlng, b: g.nodes.get(e.to).latlng, status, dist: e.dist });
        quality.dist += e.dist;
        if (e.assumed) quality.assumedDist += e.dist;
        if (e.draft) quality.draftDist += e.dist;
        if (e.noProfile) quality.noProfileDist += e.dist;
        if (status === 'both') stats.bothKm += e.dist / 1000;
        else if (status === 'gained') stats.gainedKm += e.dist / 1000;
        else stats.lostKm += e.dist / 1000;
      }
    }
  };
  classify(neu.g, neu.times, cur.g, cur.times, 'gained');
  classify(cur.g, cur.times, neu.g, neu.times, 'lost');
  for (const k of Object.keys(stats)) stats[k] = Math.round(stats[k] * 10) / 10;
  return { mode, minutes, pieces, stats, quality };
}

/** Baut beide Netze einmal; Routen und Isochronen teilen sie sich. */
export function buildGraphs({ osmWays, doc, model = 'limit', vehicle = 'car' }) {
  return {
    current: buildGraph({ osmWays, doc, mode: 'current', model, vehicle }),
    proposed: buildGraph({ osmWays, doc, mode: 'proposed', model, vehicle }),
  };
}

/**
 * Fahrzeiten der Buslinien: je Linie die Strecke über alle Haltestellen (Bus-Netz),
 * heute und neu, plus Haltezeit je Zwischenhalt. Liefert [{ id, stops, current, proposed }],
 * current/proposed = { time, dist, path, legs, error } (error, wenn ein Abschnitt keine Verbindung hat).
 */
export function computeBusLines({ osmWays, doc, model = 'limit', graphs = null }) {
  if (!doc || !doc.busLines || !doc.busLines.length) return [];
  const g = graphs || buildGraphs({ osmWays, doc, model, vehicle: 'bus' });
  const stopAt = (id) => {
    const f = doc.features.find((x) => x.id === id && x.type === 'junction');
    return f ? f.at : null;
  };
  const out = [];
  for (const line of doc.busLines) {
    const stops = line.stops.map(stopAt).filter(Boolean);
    const entry = { id: line.id, stops: stops.length, current: null, proposed: null };
    if (stops.length < 2) {
      out.push(entry);
      continue;
    }
    const dwell = Number.isFinite(line.dwell) ? line.dwell : BUS_DWELL_DEFAULT;
    for (const mode of ['current', 'proposed']) {
      let time = 0;
      let dist = 0;
      const path = [];
      const legs = [];
      const quality = { dist: 0, assumedDist: 0, draftDist: 0, noProfileDist: 0, model: g[mode].model };
      let error = null;
      for (let i = 1; i < stops.length; i++) {
        const r = routeOnGraph(g[mode], stops[i - 1], stops[i]);
        if (r.error) {
          error = r.error;
          legs.push({ error: r.error });
          continue;
        }
        time += r.time;
        dist += r.dist;
        legs.push({ time: r.time, dist: r.dist });
        if (r.quality) for (const k of ['dist', 'assumedDist', 'draftDist', 'noProfileDist']) quality[k] += r.quality[k];
        for (const p of r.path) if (!path.length || path[path.length - 1][0] !== p[0] || path[path.length - 1][1] !== p[1]) path.push(p);
      }
      time += dwell * Math.max(0, stops.length - 2);
      entry[mode] = error ? { error, time, dist, path, legs, quality } : { time, dist, path, legs, quality };
    }
    out.push(entry);
  }
  return out;
}

/** Route auf einem fertigen Netz; Start und Ziel werden temporär angebunden. */
export function routeOnGraph(g, from, to) {
  const a = attachPoint(g, from);
  const b = attachPoint(g, to);
  if (!a || !b) return { error: !a ? 'Start liegt nicht in der Nähe einer befahrbaren Strasse.' : 'Ziel liegt nicht in der Nähe einer befahrbaren Strasse.' };
  const r = shortestPath(g, a.key, b.key);
  return r ? { ...r, path: [from, ...r.path, to] } : { error: 'Keine Verbindung im Netz gefunden (Strassennetz für den ganzen Bereich geladen?).' };
}

/** Mehrere Start-Ziel-Paare auf denselben Netzen: [{ id, current, proposed }]. */
export function computeRoutesMany({ osmWays, doc, pairs, model = 'limit' }) {
  const cache = new Map();
  const graphsFor = (vehicle) => {
    if (!cache.has(vehicle)) cache.set(vehicle, buildGraphs({ osmWays, doc, model, vehicle }));
    return cache.get(vehicle);
  };
  return pairs.map((p) => {
    const g = graphsFor(VEHICLE_IDS.includes(p.vehicle) ? p.vehicle : 'car');
    return { id: p.id, current: routeOnGraph(g.current, p.from, p.to), proposed: routeOnGraph(g.proposed, p.from, p.to) };
  });
}

/** Beide Netze rechnen. Liefert { current, proposed, model }. */
export function computeRoutes({ osmWays, doc, from, to, model = 'limit', vehicle = 'car' }) {
  const graphs = buildGraphs({ osmWays, doc, model, vehicle: VEHICLE_IDS.includes(vehicle) ? vehicle : 'car' });
  return { current: routeOnGraph(graphs.current, from, to), proposed: routeOnGraph(graphs.proposed, from, to), error: null, model };
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  return `${m}:${String(rest).padStart(2, '0')} min`;
}
