// Datenmodell eines Entwurfs: Ebenen und Elemente (Strassen, Kreuzungen, Kreisel).
// Reine Funktionen ohne DOM, damit sie in Node getestet werden können.

import { circleRing, pathLength } from './geometry.js';

export const DOC_VERSION = 1;

// speed: Standard-Tempolimit in km/h für den Routen-Rechner, wenn keines gesetzt ist (0 = nicht befahrbar).
export const ROAD_KINDS = [
  { id: 'main', label: 'Hauptstrasse', width: 7, speed: 50 },
  { id: 'secondary', label: 'Nebenstrasse', width: 5.5, speed: 50 },
  { id: 'residential', label: 'Quartierstrasse', width: 4.5, speed: 30 },
  { id: 'service', label: 'Zufahrt / Erschliessung', width: 3.5, speed: 20 },
  { id: 'path', label: 'Fuss- / Veloweg', width: 2.5, speed: 0 },
  { id: 'other', label: 'Sonstiges', width: 4, speed: 50 },
];

export const MAX_SPEED = 200;

/** Tempolimit einer Strasse in km/h: gesetzter Wert oder Standard je Typ (0 = nicht befahrbar). */
export function roadSpeed(road) {
  if (Number.isFinite(road.maxspeed) && road.maxspeed > 0) return road.maxspeed;
  return (ROAD_KINDS.find((k) => k.id === road.kind) || ROAD_KINDS[5]).speed;
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

export const JUNCTION_KINDS = [
  { id: 'plain', label: 'Kreuzung' },
  { id: 'signals', label: 'Ampel' },
  { id: 'priority', label: 'Vortritt' },
  { id: 'stop', label: 'Stop' },
];

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
  };
  createLayer(doc, 'Ebene 1');
  return doc;
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

export function createRoad({ layerId, nodes, kind = 'main', name = '', status = 'new', level = 'ground', oneway = false, maxspeed = null, osmId = null }) {
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
    osmId: Number.isInteger(osmId) && osmId > 0 ? osmId : null,
    nodes: pts,
    segments: pts.slice(1).map(() => ({ level })),
    note: '',
  };
}

export function createJunction({ layerId, at, kind = 'plain', name = '' }) {
  return { id: newId('j'), type: 'junction', layerId, name, kind, at: roundCoord(at), note: '' };
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
  if (f.type === 'road') return (ROAD_KINDS.find((k) => k.id === f.kind) || ROAD_KINDS[5]).label;
  if (f.type === 'junction') return (JUNCTION_KINDS.find((k) => k.id === f.kind) || JUNCTION_KINDS[0]).label;
  if (f.type === 'roundabout') return 'Kreisel';
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
      }));
      doc.features.push({
        ...base,
        type: 'road',
        kind: idIn(ROAD_KINDS, f.kind, 'other'),
        status: idIn(STATUSES, f.status, 'new'),
        oneway: f.oneway === true,
        maxspeed: normalizeMaxspeed(f.maxspeed),
        osmId: Number.isInteger(f.osmId) && f.osmId > 0 ? f.osmId : null,
        nodes,
        segments,
      });
    } else if (f.type === 'junction') {
      if (!isLatLng(f.at)) throw new Error(`Kreuzung ${f.id} hat keine Position`);
      doc.features.push({ ...base, type: 'junction', kind: idIn(JUNCTION_KINDS, f.kind, 'plain'), at: roundCoord(f.at) });
    } else if (f.type === 'roundabout') {
      if (!isLatLng(f.center)) throw new Error(`Kreisel ${f.id} hat kein Zentrum`);
      const radius = Number.isFinite(f.radius) && f.radius > 0 ? Math.min(500, f.radius) : 15;
      doc.features.push({ ...base, type: 'roundabout', center: roundCoord(f.center), radius });
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
  const stats = { roads: 0, junctions: 0, roundabouts: 0, lengthMeters: 0, bridges: 0, tunnels: 0 };
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
          properties: { ...common, type: 'road', kind: f.kind, status: f.status, oneway: f.oneway, maxspeed: f.maxspeed, osmId: f.osmId, segment: i, level: seg.level },
          geometry: {
            type: 'LineString',
            coordinates: [f.nodes[i], f.nodes[i + 1]].map(([lat, lng]) => [lng, lat]),
          },
        });
      });
    } else if (f.type === 'junction') {
      features.push({
        type: 'Feature',
        properties: { ...common, type: 'junction', kind: f.kind },
        geometry: { type: 'Point', coordinates: [f.at[1], f.at[0]] },
      });
    } else if (f.type === 'roundabout') {
      features.push({
        type: 'Feature',
        properties: { ...common, type: 'roundabout', radius: f.radius },
        geometry: { type: 'Polygon', coordinates: [circleRing(f.center, f.radius).map(([lat, lng]) => [lng, lat])] },
      });
    }
  }
  return { type: 'FeatureCollection', name: doc.name, features };
}
