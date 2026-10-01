// Datenmodell eines Entwurfs: Ebenen und Elemente (Strassen, Kreuzungen, Kreisel).
// Reine Funktionen ohne DOM, damit sie in Node getestet werden können.

import { circleRing, pathLength } from './geometry.js';

export const DOC_VERSION = 1;

// width: Bildschirmbreite in Pixeln (kleine Zoomstufen); widthM: reale Breite der Fahrbahn in Metern (grosse Zoomstufen);
// speed: Standard-Tempolimit in km/h für den Routen-Rechner, wenn keines gesetzt ist (0 = nicht befahrbar);
// section: Standard-Querschnitt (Fahrstreifen, Mittelstreifen, Pannenstreifen); motorOnly: keine Fussgänger und Velos.
export const ROAD_KINDS = [
  { id: 'motorway', label: 'Autobahn', width: 9, widthM: 23, speed: 120, motorOnly: true, section: { lanes: 4, laneWidth: 3.75, median: 3, shoulder: 2.5 } },
  { id: 'trunk', label: 'Autostrasse', width: 8, widthM: 9.5, speed: 100, motorOnly: true, section: { lanes: 2, laneWidth: 3.75, median: 0, shoulder: 1 } },
  { id: 'main', label: 'Hauptstrasse', width: 7, widthM: 7, speed: 50, section: { lanes: 2, laneWidth: 3.5 } },
  { id: 'secondary', label: 'Nebenstrasse', width: 5.5, widthM: 6, speed: 50, section: { lanes: 2, laneWidth: 3 } },
  { id: 'residential', label: 'Quartierstrasse', width: 4.5, widthM: 5, speed: 30, section: { lanes: 2, laneWidth: 2.5 } },
  { id: 'service', label: 'Zufahrt / Erschliessung', width: 3.5, widthM: 3.5, speed: 20, section: { lanes: 1, laneWidth: 3.5 } },
  { id: 'path', label: 'Fuss- / Veloweg', width: 2.5, widthM: 2.5, speed: 0, section: { lanes: 1, laneWidth: 2.5 } },
  { id: 'other', label: 'Sonstiges', width: 4, widthM: 5, speed: 50, section: { lanes: 2, laneWidth: 2.5 } },
];

export const MAX_WIDTH_M = 60;

// --- Kostenansätze ----------------------------------------------------------------------
// Schlüssel der Einheitskosten (Werte und Beschriftungen in costs.js); im Entwurf als doc.costs überschreibbar.
export const COST_KEYS = [
  'road.motorway', 'road.trunk', 'road.main', 'road.secondary', 'road.residential', 'road.service', 'road.path', 'road.other',
  'bridge', 'tunnel', 'remove', 'roundabout',
  'junction.signals', 'junction.interchange', 'junction.crossing', 'junction.busstop', 'junction.plain',
  'zone.tempo30', 'zone.tempo20', 'zone.pedestrian', 'zone.parking',
];
export const MAX_COST = 1e10;

/** Prüft überschriebene Einheitskosten: nur bekannte Schlüssel, 0 … MAX_COST; leeres Objekt, wenn nichts gesetzt. */
export function normalizeCosts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of COST_KEYS) {
    const v = Number(raw[key]);
    if (raw[key] !== undefined && raw[key] !== null && Number.isFinite(v) && v >= 0 && v <= MAX_COST) out[key] = Math.round(v);
  }
  return out;
}

export function roadKind(road) {
  return ROAD_KINDS.find((k) => k.id === road.kind) || ROAD_KINDS[ROAD_KINDS.length - 1];
}

// --- Querschnitt --------------------------------------------------------------------
// Bänder von links nach rechts (in Zeichenrichtung): Trottoir, Parkstreifen, Velostreifen,
// Pannenstreifen, Fahrstreifen (bei Mittelstreifen in zwei Hälften), dann spiegelbildlich.

export const SECTION_LIMITS = {
  lanes: [1, 8], laneWidth: [2, 5], median: [0, 10], shoulder: [0, 4],
  bikeWidth: [1, 3], walkWidth: [1, 5], parkWidth: [1.5, 3],
};

const SECTION_BASE = { lanes: 2, laneWidth: 3.25, median: 0, shoulder: 0, bikeLeft: false, bikeRight: false, bikeWidth: 1.5, walkLeft: false, walkRight: false, walkWidth: 2, parkLeft: false, parkRight: false, parkWidth: 2 };

const clampRound = (v, [lo, hi], step = 0.25) => Math.round(Math.max(lo, Math.min(hi, v)) / step) * step;

/** Prüft einen rohen Querschnitt; null, wenn keiner gesetzt ist. */
export function normalizeSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = { ...SECTION_BASE };
  for (const key of Object.keys(SECTION_LIMITS)) {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) s[key] = key === 'lanes' ? Math.round(clampRound(v, SECTION_LIMITS.lanes, 1)) : clampRound(v, SECTION_LIMITS[key]);
  }
  for (const key of ['bikeLeft', 'bikeRight', 'walkLeft', 'walkRight', 'parkLeft', 'parkRight']) s[key] = raw[key] === true;
  if (sectionWidth(s) > MAX_WIDTH_M) return null;
  return s;
}

/** Standard-Querschnitt eines Strassentyps (als eigenständige Kopie). */
export function defaultSection(kind) {
  const k = ROAD_KINDS.find((x) => x.id === kind) || ROAD_KINDS[ROAD_KINDS.length - 1];
  return normalizeSection({ ...SECTION_BASE, ...(k.section || {}) });
}

/** Bänder eines Querschnitts: [{ kind, width, side }] von links nach rechts; width in Metern. */
export function sectionBands(s) {
  const bands = [];
  const side = (name, on, width, where) => { if (on && width > 0) bands.push({ kind: name, width, side: where }); };
  side('walk', s.walkLeft, s.walkWidth, 'left');
  side('park', s.parkLeft, s.parkWidth, 'left');
  side('bike', s.bikeLeft, s.bikeWidth, 'left');
  side('shoulder', s.shoulder > 0, s.shoulder, 'left');
  if (s.median > 0 && s.lanes >= 2) {
    const half = Math.floor(s.lanes / 2);
    for (let i = 0; i < half; i++) bands.push({ kind: 'lane', width: s.laneWidth, side: 'left' });
    bands.push({ kind: 'median', width: s.median, side: 'center' });
    for (let i = 0; i < s.lanes - half; i++) bands.push({ kind: 'lane', width: s.laneWidth, side: 'right' });
  } else {
    for (let i = 0; i < s.lanes; i++) bands.push({ kind: 'lane', width: s.laneWidth, side: 'center' });
  }
  side('shoulder', s.shoulder > 0, s.shoulder, 'right');
  side('bike', s.bikeRight, s.bikeWidth, 'right');
  side('park', s.parkRight, s.parkWidth, 'right');
  side('walk', s.walkRight, s.walkWidth, 'right');
  return bands;
}

/** Gesamtbreite eines Querschnitts in Metern. */
export function sectionWidth(s) {
  return Math.round(sectionBands(s).reduce((sum, b) => sum + b.width, 0) * 100) / 100;
}

/** Kurzbeschreibung, z. B. „2 Fahrstreifen à 3.25 m, Velostreifen rechts, Trottoir beidseitig“. */
export function sectionSummary(s) {
  const parts = [`${s.lanes} Fahrstreifen à ${s.laneWidth} m`];
  const both = (l, r, name) => (l && r ? `${name} beidseitig` : l ? `${name} links` : r ? `${name} rechts` : null);
  if (s.median > 0) parts.push(`Mittelstreifen ${s.median} m`);
  if (s.shoulder > 0) parts.push(`Pannenstreifen ${s.shoulder} m`);
  for (const p of [both(s.bikeLeft, s.bikeRight, 'Velostreifen'), both(s.parkLeft, s.parkRight, 'Parkstreifen'), both(s.walkLeft, s.walkRight, 'Trottoir')]) if (p) parts.push(p);
  return parts.join(', ');
}

/** Wirksamer Querschnitt einer Strasse: gesetzter, sonst Standard je Typ (bei gesetzter Breite ohne Querschnitt: null). */
export function roadSection(road) {
  return road.section || null;
}

/** Reale Breite in Metern: Querschnitt, sonst gesetzter Wert, sonst Standard je Typ. */
export function roadWidthMeters(road) {
  if (road.section) return sectionWidth(road.section);
  if (Number.isFinite(road.width) && road.width > 0) return road.width;
  return roadKind(road).widthM;
}

/** Mittelstreifen in Metern (getrennte Fahrbahnen); Autobahnen ohne eigenen Querschnitt bekommen den Standard. */
export function roadMedian(road) {
  if (road.section) return road.section.median || 0;
  const k = roadKind(road);
  return k.section && k.section.median ? k.section.median : 0;
}

/** Kennung der Punktfolge, um veraltete Höhenprofile zu erkennen. */
export function nodesKey(nodes) {
  let h = 0;
  for (const n of nodes) {
    const str = `${n[0]},${n[1]}`;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return `${nodes.length}:${h.toString(36)}`;
}

export function normalizeProfile(raw) {
  if (!raw || !Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 1000 || typeof raw.key !== 'string') return null;
  const points = [];
  for (const p of raw.points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    points.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  }
  return { points, key: raw.key };
}

/** Parzellenliste einer Strasse (Rohdaten prüfen; die Logik steht in parcels.js). */
export function normalizeParcelInfo(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || raw.key.length > 64 || !Array.isArray(raw.items) || raw.items.length > 500) return null;
  const items = [];
  for (const it of raw.items) {
    if (!it || typeof it !== 'object') return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const length = Number(it.length);
    items.push({ egrid: str(it.egrid, 64), number: str(it.number, 64), label: str(it.label, 120), canton: str(it.canton, 16), length: Number.isFinite(length) && length > 0 ? Math.round(length * 10) / 10 : 0 });
  }
  return { key: raw.key, items };
}

/** Höhenprofil einer Strasse, falls vorhanden und noch zur Geometrie passend. */
export function validProfile(road) {
  return road.profile && road.profile.key === nodesKey(road.nodes) ? road.profile : null;
}

export function normalizeWidth(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_WIDTH_M) return null;
  return Math.round(n * 10) / 10;
}

/** Tempolimit eines Abschnitts: Abschnitt, sonst Strasse, sonst Standard je Typ. */
export function segmentSpeed(road, i) {
  const seg = road.segments && road.segments[i];
  if (seg && Number.isFinite(seg.maxspeed) && seg.maxspeed > 0) return seg.maxspeed;
  return roadSpeed(road);
}

export const MAX_SPEED = 200;

/** Tempolimit einer Strasse in km/h: gesetzter Wert oder Standard je Typ (0 = nicht befahrbar). */
export function roadSpeed(road) {
  if (Number.isFinite(road.maxspeed) && road.maxspeed > 0) return road.maxspeed;
  return roadKind(road).speed;
}

export function normalizeMaxspeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SPEED) return null;
  return Math.round(n);
}

export const LEVELS = [
  { id: 'ground', label: 'Ebenerdig' },
  { id: 'bridge', label: 'Brücke' },
  { id: 'tunnel', label: 'Tunnel' },
];

export const STATUSES = [
  { id: 'new', label: 'Neu' },
  { id: 'existing', label: 'Bestehend' },
  { id: 'remove', label: 'Rückbau' },
];

// turns: ob Abbiegeregeln (Verbote) an dieser Art sinnvoll sind.
export const JUNCTION_KINDS = [
  { id: 'plain', label: 'Kreuzung', turns: true },
  { id: 'signals', label: 'Ampel', turns: true },
  { id: 'priority', label: 'Vortritt', turns: true },
  { id: 'stop', label: 'Stop', turns: true },
  { id: 'interchange', label: 'Anschluss (kreuzungsfrei)', turns: true },
  { id: 'crossing', label: 'Fussgängerstreifen', turns: false },
  { id: 'busstop', label: 'Bushaltestelle', turns: false },
];

export function junctionKind(j) {
  return JUNCTION_KINDS.find((k) => k.id === j.kind) || JUNCTION_KINDS[0];
}

/** Abbiegeregeln einer Kreuzung: welche Richtungen erlaubt sind. Standard: alles ausser Wenden. */
export const DEFAULT_TURNS = { left: true, right: true, straight: true, uturn: false };

export function normalizeTurns(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = {};
  for (const k of Object.keys(DEFAULT_TURNS)) t[k] = typeof raw[k] === 'boolean' ? raw[k] : DEFAULT_TURNS[k];
  return t;
}

/** Wirksame Abbiegeregeln (null = Standard). */
export function junctionTurns(j) {
  return j.turns || DEFAULT_TURNS;
}

// speed: Tempolimit, das die Zone auf alle Strassen darin legt (0 = nicht befahrbar, null = keines).
// color: Darstellung; null = Ebenenfarbe.
export const ZONE_KINDS = [
  { id: 'tempo30', label: 'Tempo-30-Zone', speed: 30, color: '#1b6ac9' },
  { id: 'tempo20', label: 'Begegnungszone (Tempo 20)', speed: 20, color: '#7b3fbf' },
  { id: 'pedestrian', label: 'Fussgängerzone', speed: 0, color: '#2a9d3f' },
  { id: 'parking', label: 'Parkplatz / Parkierung', speed: null, color: '#6b7480' },
  { id: 'other', label: 'Sonstige Fläche', speed: null, color: null },
];

export function zoneKind(zone) {
  return ZONE_KINDS.find((k) => k.id === zone.kind) || ZONE_KINDS[4];
}

/** Punkt-in-Polygon (Strahl nach Osten) in Breite/Länge; nodes = Ring ohne Wiederholung des Startpunkts. */
export function pointInPolygon(latlng, nodes) {
  let inside = false;
  const [y, x] = latlng;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
    const [yi, xi] = nodes[i];
    const [yj, xj] = nodes[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fläche eines Rings in Quadratgrad (nur zum Vergleichen, z. B. kleinste umschliessende Zone). */
export function ringArea(nodes) {
  let a = 0;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) a += (nodes[j][1] + nodes[i][1]) * (nodes[j][0] - nodes[i][0]);
  return Math.abs(a / 2);
}

export const LAYER_COLORS = [
  '#d7263d', '#1b6ac9', '#2a9d3f', '#e08a00',
  '#7b3fbf', '#0e9aa7', '#c2185b', '#5d4037',
];

let idCounter = 0;
export function newId(prefix = 'f') {
  idCounter = (idCounter + 1) % 46656;
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(3, '0')}${rand}`;
}

export function roundCoord(latlng) {
  return [Math.round(latlng[0] * 1e6) / 1e6, Math.round(latlng[1] * 1e6) / 1e6];
}

export function nowIso() {
  return new Date().toISOString();
}

export function createDocument({ name = 'Neuer Entwurf', center = [46.8, 8.23], zoom = 8 } = {}) {
  const doc = {
    version: DOC_VERSION,
    id: newId('d'),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    view: { center: [center[0], center[1]], zoom },
    layers: [],
    features: [],
    route: null,
    routePairs: [],
    isochrone: null,
    costs: {},
  };
  createLayer(doc, 'Ebene 1');
  return doc;
}

export const MAX_ROUTE_PAIRS = 20;
export const ISOCHRONE_MODES = ['proposed', 'current', 'diff'];
export const ISOCHRONE_PRESETS = [[5], [5, 10], [5, 10, 15], [10, 20, 30], [2, 5, 10]];

/** Prüft weitere Start-Ziel-Paare des Routen-Rechners. */
export function normalizeRoutePairs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw.slice(0, MAX_ROUTE_PAIRS)) {
    if (!p || typeof p !== 'object') continue;
    const pair = {
      id: typeof p.id === 'string' && p.id ? p.id.slice(0, 48) : newId('p'),
      name: typeof p.name === 'string' ? p.name.slice(0, 60) : '',
      from: isLatLng(p.from) ? roundCoord(p.from) : null,
      to: isLatLng(p.to) ? roundCoord(p.to) : null,
    };
    out.push(pair);
  }
  return out;
}

/** Prüft die Isochronen-Einstellung: Ursprung, Minuten (1–60, höchstens 5, aufsteigend), Modus. */
export function normalizeIsochrone(raw) {
  if (!raw || typeof raw !== 'object' || !isLatLng(raw.from)) return null;
  let minutes = Array.isArray(raw.minutes) ? raw.minutes.map(Number).filter((m) => Number.isFinite(m) && m >= 1 && m <= 60).map((m) => Math.round(m)) : [];
  minutes = Array.from(new Set(minutes)).sort((a, b) => a - b).slice(0, 5);
  if (!minutes.length) minutes = [5, 10, 15];
  return { from: roundCoord(raw.from), minutes, mode: ISOCHRONE_MODES.includes(raw.mode) ? raw.mode : 'proposed' };
}

export function createLayer(doc, name, color) {
  const layer = {
    id: newId('l'),
    name: name || `Ebene ${doc.layers.length + 1}`,
    color: color || LAYER_COLORS[doc.layers.length % LAYER_COLORS.length],
    visible: true,
  };
  doc.layers.push(layer);
  return layer;
}

export function getLayer(doc, id) {
  return doc.layers.find((l) => l.id === id) || null;
}

export function removeLayer(doc, id) {
  doc.layers = doc.layers.filter((l) => l.id !== id);
  doc.features = doc.features.filter((f) => f.layerId !== id);
}

export function moveLayer(doc, id, delta) {
  const i = doc.layers.findIndex((l) => l.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  const [layer] = doc.layers.splice(i, 1);
  doc.layers.splice(j, 0, layer);
}

export function createRoad({ layerId, nodes, kind = 'main', name = '', status = 'new', level = 'ground', oneway = false, maxspeed = null, osmId = null, width = null, section = null }) {
  const pts = nodes.map(roundCoord);
  return {
    id: newId('r'),
    type: 'road',
    layerId,
    name,
    kind,
    status,
    oneway,
    maxspeed: normalizeMaxspeed(maxspeed),
    width: normalizeWidth(width),
    section: normalizeSection(section),
    osmId: Number.isInteger(osmId) && osmId > 0 ? osmId : null,
    nodes: pts,
    segments: pts.slice(1).map(() => ({ level, maxspeed: null })),
    profile: null,
    parcels: null,
    note: '',
  };
}

/**
 * Teilt eine Strasse am Knoten nodeIndex in zwei Strassen (1 <= nodeIndex <= n-2).
 * Die zweite Hälfte wird als neue Strasse mit denselben Eigenschaften angelegt; liefert deren ID.
 */
export function splitRoadAtNode(doc, roadId, nodeIndex) {
  const road = getFeature(doc, roadId);
  if (!road || road.type !== 'road' || nodeIndex < 1 || nodeIndex > road.nodes.length - 2) return null;
  const second = {
    ...road,
    id: newId('r'),
    nodes: road.nodes.slice(nodeIndex),
    segments: road.segments.slice(nodeIndex).map((s) => ({ ...s })),
  };
  road.nodes = road.nodes.slice(0, nodeIndex + 1);
  road.segments = road.segments.slice(0, nodeIndex);
  doc.features.splice(doc.features.indexOf(road) + 1, 0, second);
  return second.id;
}

/** Hängt Punkte an das Ende (atEnd) oder den Anfang einer Strasse an; neue Abschnitte erben die Führung des Nachbarabschnitts. */
export function extendRoad(doc, roadId, latlngs, atEnd = true) {
  const road = getFeature(doc, roadId);
  if (!road || road.type !== 'road' || !latlngs.length) return;
  const pts = latlngs.map(roundCoord);
  if (atEnd) {
    const last = road.segments[road.segments.length - 1] || { level: 'ground', maxspeed: null };
    road.nodes.push(...pts);
    road.segments.push(...pts.map(() => ({ level: last.level, maxspeed: null })));
  } else {
    const first = road.segments[0] || { level: 'ground', maxspeed: null };
    road.nodes.unshift(...pts);
    road.segments.unshift(...pts.map(() => ({ level: first.level, maxspeed: null })));
  }
}

export function createJunction({ layerId, at, kind = 'plain', name = '', turns = null }) {
  return { id: newId('j'), type: 'junction', layerId, name, kind, at: roundCoord(at), turns: normalizeTurns(turns), note: '' };
}

export function createZone({ layerId, nodes, kind = 'tempo30', name = '' }) {
  return { id: newId('z'), type: 'zone', layerId, name, kind, nodes: nodes.map(roundCoord), note: '' };
}

export function insertZoneNode(doc, zoneId, afterIndex, latlng) {
  const z = getFeature(doc, zoneId);
  if (!z || z.type !== 'zone') return -1;
  const at = Math.min(afterIndex + 1, z.nodes.length);
  z.nodes.splice(at, 0, roundCoord(latlng));
  return at;
}

export function removeZoneNode(doc, zoneId, index) {
  const z = getFeature(doc, zoneId);
  if (!z || z.type !== 'zone' || z.nodes.length <= 3 || index < 0 || index >= z.nodes.length) return false;
  z.nodes.splice(index, 1);
  return true;
}

/** Verschiebt einen Punkt einer Strasse oder Zone. */
export function moveFeatureNode(doc, featureId, index, latlng) {
  const f = getFeature(doc, featureId);
  if (!f || !Array.isArray(f.nodes) || !f.nodes[index]) return;
  f.nodes[index] = roundCoord(latlng);
}

export function createRoundabout({ layerId, center, radius = 15, name = '' }) {
  return {
    id: newId('k'),
    type: 'roundabout',
    layerId,
    name,
    center: roundCoord(center),
    radius: Math.round(radius * 10) / 10,
    note: '',
  };
}

export function getFeature(doc, id) {
  return doc.features.find((f) => f.id === id) || null;
}

export function removeFeature(doc, id) {
  doc.features = doc.features.filter((f) => f.id !== id);
}

export function featureLabel(f) {
  if (f.name) return f.name;
  if (f.type === 'road') return roadKind(f).label;
  if (f.type === 'junction') return (JUNCTION_KINDS.find((k) => k.id === f.kind) || JUNCTION_KINDS[0]).label;
  if (f.type === 'roundabout') return 'Kreisel';
  if (f.type === 'zone') return zoneKind(f).label;
  return 'Element';
}

/**
 * Fügt an Position latlng einen Knoten in Abschnitt segIndex der Strasse ein.
 * Beide Hälften erben die Attribute des ursprünglichen Abschnitts.
 * Liefert den Index des neuen Knotens.
 */
export function splitRoadSegment(doc, roadId, segIndex, latlng) {
  const road = getFeature(doc, roadId);
  if (!road || road.type !== 'road') throw new Error('Strasse nicht gefunden');
  if (segIndex < 0 || segIndex >= road.segments.length) throw new Error('Ungültiger Abschnitt');
  const seg = road.segments[segIndex];
  road.nodes.splice(segIndex + 1, 0, roundCoord(latlng));
  road.segments.splice(segIndex + 1, 0, { ...seg });
  return segIndex + 1;
}

export function removeRoadNode(doc, roadId, index) {
  const road = getFeature(doc, roadId);
  if (!road || road.type !== 'road') return false;
  if (road.nodes.length <= 2) return false;
  if (index < 0 || index >= road.nodes.length) return false;
  road.nodes.splice(index, 1);
  // Abschnitt vor dem Knoten entfernen (beim ersten Knoten den ersten Abschnitt).
  road.segments.splice(Math.max(0, index - 1), 1);
  return true;
}

export function moveRoadNode(doc, roadId, index, latlng) {
  const road = getFeature(doc, roadId);
  if (!road || road.type !== 'road') return;
  road.nodes[index] = roundCoord(latlng);
}

export function setSegmentLevel(doc, roadId, segIndex, level) {
  const road = getFeature(doc, roadId);
  if (!road || !road.segments[segIndex]) return;
  road.segments[segIndex].level = level;
}

/**
 * Wendet für gezeichnete Punkte, die auf einen bestehenden Abschnitt eingerastet
 * sind, die entsprechenden Teilungen an, damit das Netz topologisch verbunden ist.
 * vertices: [{ latlng, snap }] mit snap.ref = { source: 'draft', type: 'road', featureId, index, kind: 'segment' }.
 * Teilungen werden pro Strasse mit absteigendem Abschnittsindex und absteigendem t
 * ausgeführt, damit sich die Indizes noch nicht verarbeiteter Teilungen nicht verschieben.
 */
export function applySnapSplits(doc, vertices) {
  const byRoad = new Map();
  for (const v of vertices) {
    const s = v.snap;
    if (!s || s.kind !== 'segment' || !s.ref || s.ref.source !== 'draft' || s.ref.type !== 'road') continue;
    const list = byRoad.get(s.ref.featureId) || [];
    list.push({ index: s.ref.index, t: s.t ?? 0.5, latlng: v.latlng });
    byRoad.set(s.ref.featureId, list);
  }
  let splits = 0;
  for (const [roadId, list] of byRoad) {
    if (!getFeature(doc, roadId)) continue;
    list.sort((a, b) => (b.index - a.index) || (b.t - a.t));
    for (const item of list) {
      splitRoadSegment(doc, roadId, item.index, item.latlng);
      splits++;
    }
  }
  return splits;
}

function isLatLng(v) {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180;
}

function idIn(list, id, fallback) {
  return list.some((x) => x.id === id) ? id : fallback;
}

/** Prüft ein rohes Objekt und ergänzt fehlende Felder; wirft bei ungültigen Daten. */
export function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Kein gültiger Entwurf');
  if (raw.version !== undefined && raw.version > DOC_VERSION) {
    throw new Error(`Entwurf stammt aus einer neueren Version (${raw.version})`);
  }
  const doc = {
    version: DOC_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('d'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Unbenannter Entwurf',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    view: { center: [46.8, 8.23], zoom: 8 },
    layers: [],
    features: [],
    route: null,
    routePairs: normalizeRoutePairs(raw.routePairs),
    isochrone: normalizeIsochrone(raw.isochrone),
    costs: normalizeCosts(raw.costs),
  };
  if (raw.route && isLatLng(raw.route.from) && isLatLng(raw.route.to)) {
    doc.route = { from: roundCoord(raw.route.from), to: roundCoord(raw.route.to) };
  }
  if (raw.view && isLatLng(raw.view.center) && Number.isFinite(raw.view.zoom)) {
    doc.view = { center: [raw.view.center[0], raw.view.center[1]], zoom: raw.view.zoom };
  }
  if (!Array.isArray(raw.layers)) throw new Error('Ebenen fehlen');
  for (const l of raw.layers) {
    if (!l || typeof l.id !== 'string') throw new Error('Ungültige Ebene');
    doc.layers.push({
      id: l.id,
      name: typeof l.name === 'string' ? l.name : 'Ebene',
      color: typeof l.color === 'string' ? l.color : LAYER_COLORS[doc.layers.length % LAYER_COLORS.length],
      visible: l.visible !== false,
    });
  }
  if (doc.layers.length === 0) createLayer(doc, 'Ebene 1');
  const layerIds = new Set(doc.layers.map((l) => l.id));
  const features = Array.isArray(raw.features) ? raw.features : [];
  for (const f of features) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string') throw new Error('Ungültiges Element');
    const layerId = layerIds.has(f.layerId) ? f.layerId : doc.layers[0].id;
    const base = { id: f.id, layerId, name: typeof f.name === 'string' ? f.name : '', note: typeof f.note === 'string' ? f.note : '' };
    if (f.type === 'road') {
      if (!Array.isArray(f.nodes) || f.nodes.length < 2 || !f.nodes.every(isLatLng)) {
        throw new Error(`Strasse ${f.id} hat ungültige Punkte`);
      }
      const nodes = f.nodes.map(roundCoord);
      const segs = Array.isArray(f.segments) ? f.segments : [];
      const segments = nodes.slice(1).map((_, i) => ({
        level: idIn(LEVELS, segs[i] && segs[i].level, 'ground'),
        maxspeed: normalizeMaxspeed(segs[i] && segs[i].maxspeed),
      }));
      doc.features.push({
        ...base,
        type: 'road',
        kind: idIn(ROAD_KINDS, f.kind, 'other'),
        status: idIn(STATUSES, f.status, 'new'),
        oneway: f.oneway === true,
        maxspeed: normalizeMaxspeed(f.maxspeed),
        width: normalizeWidth(f.width),
        section: normalizeSection(f.section),
        osmId: Number.isInteger(f.osmId) && f.osmId > 0 ? f.osmId : null,
        nodes,
        segments,
        profile: normalizeProfile(f.profile),
        parcels: normalizeParcelInfo(f.parcels),
      });
    } else if (f.type === 'junction') {
      if (!isLatLng(f.at)) throw new Error(`Kreuzung ${f.id} hat keine Position`);
      doc.features.push({ ...base, type: 'junction', kind: idIn(JUNCTION_KINDS, f.kind, 'plain'), at: roundCoord(f.at), turns: normalizeTurns(f.turns) });
    } else if (f.type === 'roundabout') {
      if (!isLatLng(f.center)) throw new Error(`Kreisel ${f.id} hat kein Zentrum`);
      const radius = Number.isFinite(f.radius) && f.radius > 0 ? Math.min(500, f.radius) : 15;
      doc.features.push({ ...base, type: 'roundabout', center: roundCoord(f.center), radius });
    } else if (f.type === 'zone') {
      if (!Array.isArray(f.nodes) || f.nodes.length < 3 || !f.nodes.every(isLatLng)) {
        throw new Error(`Zone ${f.id} hat ungültige Punkte`);
      }
      doc.features.push({ ...base, type: 'zone', kind: idIn(ZONE_KINDS, f.kind, 'other'), nodes: f.nodes.map(roundCoord) });
    } else {
      throw new Error(`Unbekannter Elementtyp: ${f.type}`);
    }
  }
  return doc;
}

export function serialize(doc) {
  return JSON.stringify(doc);
}

export function deserialize(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Datei ist kein gültiges JSON');
  }
  return normalizeDocument(raw);
}

export function cloneDocument(doc) {
  return JSON.parse(JSON.stringify(doc));
}

export function docStats(doc) {
  const stats = { roads: 0, junctions: 0, roundabouts: 0, zones: 0, lengthMeters: 0, bridges: 0, tunnels: 0 };
  for (const f of doc.features) {
    if (f.type === 'road') {
      stats.roads++;
      stats.lengthMeters += pathLength(f.nodes);
      for (const s of f.segments) {
        if (s.level === 'bridge') stats.bridges++;
        if (s.level === 'tunnel') stats.tunnels++;
      }
    } else if (f.type === 'junction') stats.junctions++;
    else if (f.type === 'roundabout') stats.roundabouts++;
    else if (f.type === 'zone') stats.zones++;
  }
  return stats;
}

/** GeoJSON-Export: ein LineString pro Abschnitt, Punkte für Kreuzungen, Polygone für Kreisel. */
export function toGeoJSON(doc) {
  const features = [];
  const layerName = (id) => (getLayer(doc, id) || {}).name || '';
  for (const f of doc.features) {
    const common = { id: f.id, name: f.name, layer: layerName(f.layerId), note: f.note || '' };
    if (f.type === 'road') {
      f.segments.forEach((seg, i) => {
        features.push({
          type: 'Feature',
          properties: { ...common, type: 'road', kind: f.kind, status: f.status, oneway: f.oneway, maxspeed: segmentSpeed(f, i), width: roadWidthMeters(f), section: f.section ? sectionSummary(f.section) : null, osmId: f.osmId, segment: i, level: seg.level },
          geometry: {
            type: 'LineString',
            coordinates: [f.nodes[i], f.nodes[i + 1]].map(([lat, lng]) => [lng, lat]),
          },
        });
      });
    } else if (f.type === 'junction') {
      features.push({
        type: 'Feature',
        properties: { ...common, type: 'junction', kind: f.kind, turns: f.turns || null },
        geometry: { type: 'Point', coordinates: [f.at[1], f.at[0]] },
      });
    } else if (f.type === 'roundabout') {
      features.push({
        type: 'Feature',
        properties: { ...common, type: 'roundabout', radius: f.radius },
        geometry: { type: 'Polygon', coordinates: [circleRing(f.center, f.radius).map(([lat, lng]) => [lng, lat])] },
      });
    } else if (f.type === 'zone') {
      const ring = [...f.nodes, f.nodes[0]].map(([lat, lng]) => [lng, lat]);
      features.push({
        type: 'Feature',
        properties: { ...common, type: 'zone', kind: f.kind, speed: zoneKind(f).speed },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return { type: 'FeatureCollection', name: doc.name, features };
}
