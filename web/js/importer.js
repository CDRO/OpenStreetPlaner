// Import von GeoJSON, GPX und KML als neue Ebene: Linien werden Strassen,
// Punkte Kreuzungen/Punkte, Polygone Flächen. Ohne DOM (regex-basiertes XML),
// damit es in Node testbar ist. Stadtplaner-JSON wird erkannt und durchgereicht.

import { createJunction, createLayer, createRoad, createZone } from './model.js';
import { roadKindFromHighway } from './osm.js';
import { parseMaxspeed } from './routing.js';
import { t } from './i18n.js';

export const MAX_IMPORT_FEATURES = 2000;
export const MAX_IMPORT_POINTS = 5000;
const GEOMETRIES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);

/** Erkennt das Format: 'stadtplaner' | 'geojson' | 'gpx' | 'kml' | null. */
export function detectFormat(text, filename = '') {
  const head = text.slice(0, 2000);
  const lower = filename.toLowerCase();
  if (/<gpx[\s>]/i.test(head) || lower.endsWith('.gpx')) return 'gpx';
  if (/<kml[\s>]/i.test(head) || /<Placemark/i.test(head) || lower.endsWith('.kml')) return 'kml';
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(text);
      if (obj && Array.isArray(obj.layers) && Array.isArray(obj.features) && !obj.type) return 'stadtplaner';
      if (obj && (obj.type === 'FeatureCollection' || obj.type === 'Feature' || GEOMETRIES.has(obj.type))) return 'geojson';
    } catch {
      return null;
    }
  }
  return null;
}


const validLL = (ll) => Array.isArray(ll) && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) && Math.abs(ll[0]) <= 90 && Math.abs(ll[1]) <= 180;

/** Rohe Elemente: [{ type: 'line'|'point'|'polygon', coords: [[lat,lng]…], name, props }]. */
export function parseGeoJSON(obj) {
  const out = [];
  const add = (type, coords, name, props) => {
    const clean = coords.filter(validLL);
    if ((type === 'point' && clean.length) || (type === 'line' && clean.length >= 2) || (type === 'polygon' && clean.length >= 3)) out.push({ type, coords: clean.slice(0, MAX_IMPORT_POINTS), name, props });
  };
  const toLL = (c) => [Number(c[1]), Number(c[0])];
  const geom = (g, name, props) => {
    if (!g) return;
    switch (g.type) {
      case 'Point': add('point', [toLL(g.coordinates)], name, props); break;
      case 'MultiPoint': (g.coordinates || []).forEach((c) => add('point', [toLL(c)], name, props)); break;
      case 'LineString': add('line', (g.coordinates || []).map(toLL), name, props); break;
      case 'MultiLineString': (g.coordinates || []).forEach((l) => add('line', l.map(toLL), name, props)); break;
      case 'Polygon': add('polygon', ring((g.coordinates || [])[0] || []).map(toLL), name, props); break;
      case 'MultiPolygon': (g.coordinates || []).forEach((p) => add('polygon', ring(p[0] || []).map(toLL), name, props)); break;
      case 'GeometryCollection': (g.geometries || []).forEach((x) => geom(x, name, props)); break;
      default: break;
    }
  };
  const feature = (f) => {
    if (!f) return;
    const props = f.properties || {};
    geom(f.geometry, typeof props.name === 'string' ? props.name : '', props);
  };
  if (obj.type === 'FeatureCollection') (obj.features || []).forEach(feature);
  else if (obj.type === 'Feature') feature(obj);
  else geom(obj, '', {});
  return out.slice(0, MAX_IMPORT_FEATURES);
}

/** Ring ohne wiederholten Schlusspunkt. */
function ring(coords) {
  if (coords.length > 1) {
    const a = coords[0];
    const b = coords[coords.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return coords.slice(0, -1);
  }
  return coords;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tagText = (block, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
};
const blocks = (text, tag) => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
  return text.match(re) || [];
};
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) || new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
  return m ? m[1] : null;
};

/** GPX: Tracks und Routen als Linien, Wegpunkte als Punkte. */
export function parseGPX(text) {
  const out = [];
  const points = (block, tag) => Array.from(block.matchAll(new RegExp(`<${tag}\\s[^>]*>`, 'gi'))).map((m) => [Number(attr(m[0], 'lat')), Number(attr(m[0], 'lon'))]).filter(validLL);
  for (const trk of blocks(text, 'trk')) {
    const name = tagText(trk, 'name');
    const segs = blocks(trk, 'trkseg');
    const lines = segs.length ? segs.map((s) => points(s, 'trkpt')) : [points(trk, 'trkpt')];
    for (const pts of lines) if (pts.length >= 2) out.push({ type: 'line', coords: pts.slice(0, MAX_IMPORT_POINTS), name, props: {} });
  }
  for (const rte of blocks(text, 'rte')) {
    const pts = points(rte, 'rtept');
    if (pts.length >= 2) out.push({ type: 'line', coords: pts.slice(0, MAX_IMPORT_POINTS), name: tagText(rte, 'name'), props: {} });
  }
  for (const wpt of blocks(text, 'wpt')) {
    const open = /<wpt\s[^>]*>/i.exec(wpt)[0];
    const ll = [Number(attr(open, 'lat')), Number(attr(open, 'lon'))];
    if (validLL(ll)) out.push({ type: 'point', coords: [ll], name: tagText(wpt, 'name'), props: {} });
  }
  return out.slice(0, MAX_IMPORT_FEATURES);
}

/** KML: Placemarks mit LineString, Point oder Polygon (äusserer Ring). */
export function parseKML(text) {
  const out = [];
  const coords = (block) => tagText(block, 'coordinates').split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2).map((c) => [c[1], c[0]]).filter(validLL);
  for (const pm of blocks(text, 'Placemark')) {
    const name = tagText(pm, 'name');
    for (const ls of blocks(pm, 'LineString')) {
      const pts = coords(ls);
      if (pts.length >= 2) out.push({ type: 'line', coords: pts.slice(0, MAX_IMPORT_POINTS), name, props: {} });
    }
    for (const pt of blocks(pm, 'Point')) {
      const pts = coords(pt);
      if (pts.length) out.push({ type: 'point', coords: [pts[0]], name, props: {} });
    }
    for (const poly of blocks(pm, 'Polygon')) {
      const outer = blocks(poly, 'outerBoundaryIs')[0] || poly;
      const pts = ring(coords(outer));
      if (pts.length >= 3) out.push({ type: 'polygon', coords: pts.slice(0, MAX_IMPORT_POINTS), name, props: {} });
    }
  }
  return out.slice(0, MAX_IMPORT_FEATURES);
}

/** Liest eine Datei: { format, doc } für Stadtplaner-JSON, sonst { format, items }. */
export function parseImport(text, filename = '') {
  const format = detectFormat(text, filename);
  if (!format) throw new Error(t('Format nicht erkannt (unterstützt: Stadtplaner-JSON, GeoJSON, GPX, KML)'));
  if (format === 'stadtplaner') return { format, raw: JSON.parse(text) };
  if (format === 'geojson') return { format, items: parseGeoJSON(JSON.parse(text)) };
  if (format === 'gpx') return { format, items: parseGPX(text) };
  return { format, items: parseKML(text) };
}

/**
 * Legt die Elemente als neue Ebene im Dokument an. Liefert { layerId, roads, junctions, zones }.
 * Eigenschaften aus GeoJSON (highway, maxspeed, kind, status, oneway) werden übernommen.
 */
export function applyImport(doc, items, { layerName = 'Import', kind = 'main', status = 'existing' } = {}) {
  const layer = createLayer(doc, layerName);
  const counts = { layerId: layer.id, roads: 0, junctions: 0, zones: 0 };
  for (const it of items) {
    const p = it.props || {};
    if (it.type === 'line') {
      const road = createRoad({
        layerId: layer.id,
        nodes: it.coords,
        kind: typeof p.highway === 'string' ? roadKindFromHighway(p.highway) : (typeof p.kind === 'string' ? p.kind : kind),
        name: it.name || '',
        status: ['new', 'existing', 'remove'].includes(p.status) ? p.status : status,
        oneway: p.oneway === true || p.oneway === 'yes',
        maxspeed: parseMaxspeed(p.maxspeed),
      });
      doc.features.push(road);
      counts.roads++;
    } else if (it.type === 'point') {
      doc.features.push(createJunction({ layerId: layer.id, at: it.coords[0], name: it.name || '', kind: typeof p.kind === 'string' ? p.kind : 'plain' }));
      counts.junctions++;
    } else if (it.type === 'polygon') {
      doc.features.push(createZone({ layerId: layer.id, nodes: it.coords, name: it.name || '', kind: typeof p.kind === 'string' ? p.kind : 'other' }));
      counts.zones++;
    }
  }
  return counts;
}
