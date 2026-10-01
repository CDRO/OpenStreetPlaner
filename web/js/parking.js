// Parkplatzbilanz: neue Parkplätze aus Parkstreifen (Querschnitt) und Parkflächen des Entwurfs,
// entfallene aus OSM-Parkstreifen (parking:lane:*, parking:left/right/both) an übernommenen oder
// rückgebauten Strassen und aus OSM-Parkplätzen (amenity=parking), die neue Strassen oder Flächen berühren.
import { pathLength } from './geometry.js';
import { pointInPolygon } from './model.js';
import { ringAreaM2 } from './costs.js';
import { segmentsIntersect } from './buildings.js';
import { t } from './i18n.js';

export const SPACE_LENGTH = { parallel: 6, diagonal: 4.5, perpendicular: 2.5 }; // Meter Strassenlänge je Parkplatz
export const AREA_PER_SPACE = 25; // m² je Parkplatz inkl. Fahrgasse

/** Parkplätze je Seite aus OSM-Tags eines Ways: alte (parking:lane:*) und neue (parking:*) Schemata. */
export function osmLaneSpaces(tags = {}, lengthM) {
  const sides = { left: 0, right: 0 };
  const orient = (side) => {
    const o = tags[`parking:${side}:orientation`] || tags['parking:both:orientation'];
    if (SPACE_LENGTH[o]) return o;
    const legacy = tags[`parking:lane:${side}`] || tags['parking:lane:both'];
    if (SPACE_LENGTH[legacy]) return legacy;
    return 'parallel';
  };
  for (const side of ['left', 'right']) {
    const v = tags[`parking:${side}`] || tags['parking:both'];
    const legacy = tags[`parking:lane:${side}`] || tags['parking:lane:both'];
    const has = (v && !['no', 'separate', 'no_parking', 'no_stopping', 'missing'].includes(v)) || (legacy && !['no', 'no_parking', 'no_stopping', 'separate', 'fire_lane'].includes(legacy));
    if (has) sides[side] = Math.floor(lengthM / SPACE_LENGTH[orient(side)]);
  }
  return sides;
}

function sectionSpaces(road) {
  const s = road.section;
  if (!s) return { left: 0, right: 0 };
  const len = pathLength(road.nodes);
  return { left: s.parkLeft ? Math.floor(len / SPACE_LENGTH.parallel) : 0, right: s.parkRight ? Math.floor(len / SPACE_LENGTH.parallel) : 0 };
}

const xy = (ll) => ({ x: ll[1], y: ll[0] }); // segmentsIntersect rechnet mit {x, y}

function ringsTouch(a, b) {
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = xy(a[i]);
    const a2 = xy(a[(i + 1) % a.length]);
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, xy(b[j]), xy(b[(j + 1) % b.length]))) return true;
    }
  }
  return false;
}

function lineTouchesRing(line, ring) {
  if (line.some((p) => pointInPolygon(p, ring))) return true;
  for (let i = 1; i < line.length; i++) {
    const l1 = xy(line[i - 1]);
    const l2 = xy(line[i]);
    for (let j = 0; j < ring.length; j++) {
      if (segmentsIntersect(l1, l2, xy(ring[j]), xy(ring[(j + 1) % ring.length]))) return true;
    }
  }
  return false;
}

/** Bilanz: { added: {lanes, zones}, removed: {lanes, areas}, net, items[] }. Nur sichtbare Ebenen. */
export function parkingBalance({ doc, osmWays = [], parkingAreas = [] }) {
  const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
  const visible = doc.features.filter((f) => !hidden.has(f.layerId));
  const wayById = new Map(osmWays.map((w) => [w.id, w]));
  const items = [];
  const added = { lanes: 0, zones: 0 };
  const removed = { lanes: 0, areas: 0 };
  for (const f of visible) {
    if (f.type !== 'road') continue;
    const name = f.name || t('Strasse');
    const way = f.osmId ? wayById.get(f.osmId) : null;
    const before = way ? osmLaneSpaces(way.tags, pathLength(way.geometry)) : { left: 0, right: 0 };
    if (f.status === 'remove') {
      const n = before.left + before.right;
      if (n) {
        removed.lanes += n;
        items.push({ kind: 'removed', what: 'lane', label: name, spaces: -n, featureId: f.id, note: t('Rückbau: Parkstreifen aus OSM entfallen') });
      }
      continue;
    }
    if (!f.section && way) continue; // ohne Querschnitt keine Aussage: Bestand bleibt
    const after = sectionSpaces(f);
    for (const side of ['left', 'right']) {
      const d = after[side] - before[side];
      const sideLabel = side === 'left' ? t('links') : t('rechts');
      if (d > 0) {
        added.lanes += d;
        items.push({ kind: 'added', what: 'lane', label: `${name} (${sideLabel})`, spaces: d, featureId: f.id });
      } else if (d < 0) {
        removed.lanes += -d;
        items.push({ kind: 'removed', what: 'lane', label: `${name} (${sideLabel})`, spaces: d, featureId: f.id, note: t('Parkstreifen aus OSM ohne Entsprechung im Querschnitt') });
      }
    }
  }
  for (const f of visible) {
    if (f.type !== 'zone' || f.kind !== 'parking') continue;
    const area = ringAreaM2(f.nodes);
    const n = Math.floor(area / AREA_PER_SPACE);
    if (!n) continue;
    added.zones += n;
    items.push({ kind: 'added', what: 'zone', label: f.name || t('Parkplatz'), spaces: n, featureId: f.id, note: t('{a} m² à {s} m²', { a: Math.round(area), s: AREA_PER_SPACE }) });
  }
  // OSM-Parkplätze, die neue Strassen oder neue Nicht-Parkflächen berühren
  const newRoads = visible.filter((f) => f.type === 'road' && f.status === 'new');
  const newZones = visible.filter((f) => f.type === 'zone' && f.kind !== 'parking');
  for (const pa of parkingAreas) {
    const tags = pa.tags || {};
    if (tags.parking && !['surface', 'street_side', 'lane', 'layby'].includes(tags.parking)) continue; // Parkhäuser und Tiefgaragen bleiben
    const ring = pa.geometry;
    if (!ring || ring.length < 3) continue;
    const touched = newRoads.some((r) => lineTouchesRing(r.nodes, ring)) || newZones.some((z) => ringsTouch(z.nodes, ring));
    if (!touched) continue;
    const cap = parseInt(tags.capacity, 10);
    const known = Number.isFinite(cap) && cap > 0;
    const n = known ? cap : Math.max(1, Math.floor(ringAreaM2(ring) / AREA_PER_SPACE));
    removed.areas += n;
    items.push({ kind: 'removed', what: 'area', label: tags.name || t('Parkplatz (OSM)'), spaces: -n, osmId: pa.id, note: known ? t('capacity aus OSM') : t('aus der Fläche geschätzt; ganze Anlage gezählt') });
  }
  const net = added.lanes + added.zones - removed.lanes - removed.areas;
  return { added, removed, net, items };
}
