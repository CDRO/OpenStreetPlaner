// Parzellen-Betroffenheit: welche Liegenschaften der amtlichen Vermessung eine
// Strasse berührt und wie viele Meter darauf liegen. Reine Funktionen.

import { haversine } from './geometry.js';
import { nodesKey, pointInPolygon } from './model.js';

/** Liegt der Punkt im Polygon (erster Ring aussen, weitere Ringe sind Löcher)? */
export function pointInRings(latlng, rings) {
  if (!rings || !rings.length || !pointInPolygon(latlng, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInPolygon(latlng, rings[i])) return false;
  return true;
}

/** Liegt der Punkt in einem der Polygone? */
export function pointInPolygons(latlng, polygons) {
  return (polygons || []).some((rings) => pointInRings(latlng, rings));
}

/**
 * Länge eines Linienzugs innerhalb der Polygone in Metern, durch Abtasten alle
 * stepM Meter (genau genug für Parzellen, ohne Schnittgeometrie).
 */
export function lengthInPolygons(nodes, polygons, stepM = 1) {
  if (!nodes || nodes.length < 2 || !polygons || !polygons.length) return 0;
  let inside = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const len = haversine(a, b);
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (pointInPolygons(p, polygons)) inside += len / n;
    }
  }
  return inside;
}

/**
 * Fasst die vom Server gelieferten Parzellen für eine Strasse zusammen:
 * [{ egrid, number, label, canton, length }] nach Länge absteigend, nur mit Länge > 0.5 m,
 * dazu der Schlüssel der Punktfolge, damit veraltete Ergebnisse erkannt werden.
 */
export function summarizeParcels(road, parcels) {
  const items = [];
  for (const p of parcels || []) {
    const length = lengthInPolygons(road.nodes, p.polygons);
    if (length < 0.5) continue;
    items.push({ egrid: p.egrid || '', number: p.number || '', label: p.label || '', canton: p.canton || '', length: Math.round(length * 10) / 10 });
  }
  items.sort((a, b) => b.length - a.length);
  return { key: nodesKey(road.nodes), items };
}

/** Gültig, solange die Strasse nicht verändert wurde. */
export function validParcels(road) {
  return road.parcels && road.parcels.key === nodesKey(road.nodes) ? road.parcels : null;
}

/** Anzeigename einer Parzelle: „Nr. 1234 (BE)“ oder EGRID. */
export function parcelLabel(p) {
  if (p.number) return `Nr. ${p.number}${p.canton ? ` (${p.canton})` : ''}`;
  return p.egrid || p.label || 'Parzelle';
}

export { normalizeParcelInfo as normalizeParcels } from './model.js';
