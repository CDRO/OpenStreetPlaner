// Baut den Einrast-Index aus dem Entwurf und den geladenen OSM-Strassen.
// Referenzen (ref) beschreiben, worauf eingerastet wurde:
//   { source: 'draft', type: 'road'|'junction'|'roundabout', featureId, index?, kind }
//   { source: 'osm', wayId, index?, kind }

import { findSnap, mercatorScale, project, segmentEntry, unitsPerPixel, unproject } from './geometry.js';

export function buildSnapIndex(doc, { osmWays = [], includeOsm = true } = {}) {
  const index = { nodes: [], segments: [], circles: [] };
  const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
  for (const f of doc.features) {
    if (hidden.has(f.layerId)) continue;
    if (f.type === 'road') {
      const pts = f.nodes.map(project);
      pts.forEach((p, i) => index.nodes.push({ x: p.x, y: p.y, ref: { source: 'draft', type: 'road', featureId: f.id, index: i } }));
      for (let i = 0; i < pts.length - 1; i++) {
        index.segments.push(segmentEntry(pts[i], pts[i + 1], { source: 'draft', type: 'road', featureId: f.id, index: i }));
      }
    } else if (f.type === 'zone') {
      const pts = f.nodes.map(project);
      pts.forEach((p, i) => index.nodes.push({ x: p.x, y: p.y, ref: { source: 'draft', type: 'zone', featureId: f.id, index: i } }));
      for (let i = 0; i < pts.length; i++) {
        index.segments.push(segmentEntry(pts[i], pts[(i + 1) % pts.length], { source: 'draft', type: 'zone', featureId: f.id, index: i }));
      }
    } else if (f.type === 'junction') {
      const p = project(f.at);
      index.nodes.push({ x: p.x, y: p.y, ref: { source: 'draft', type: 'junction', featureId: f.id } });
    } else if (f.type === 'roundabout') {
      const p = project(f.center);
      index.nodes.push({ x: p.x, y: p.y, ref: { source: 'draft', type: 'roundabout', featureId: f.id, part: 'center' } });
      index.circles.push({ x: p.x, y: p.y, r: f.radius * mercatorScale(f.center[0]), ref: { source: 'draft', type: 'roundabout', featureId: f.id, part: 'ring' } });
    }
  }
  if (includeOsm) {
    for (const way of osmWays) {
      const pts = way.geometry.map(project);
      pts.forEach((p, i) => index.nodes.push({ x: p.x, y: p.y, ref: { source: 'osm', wayId: way.id, index: i } }));
      for (let i = 0; i < pts.length - 1; i++) {
        index.segments.push(segmentEntry(pts[i], pts[i + 1], { source: 'osm', wayId: way.id, index: i }));
      }
    }
  }
  return index;
}

/**
 * Rastet eine [lat, lng]-Position ein. Liefert { latlng, snap } wobei snap null
 * ist, wenn nichts in Reichweite liegt. tolerancePx wird über den Zoom in
 * Mercator-Einheiten umgerechnet.
 */
export function snapLatLng(latlng, index, zoom, tolerancePx, filter = null) {
  const p = project(latlng);
  const tol = tolerancePx * unitsPerPixel(zoom);
  const hit = findSnap(p, index, tol, filter);
  if (!hit) return { latlng, snap: null };
  return { latlng: unproject(hit), snap: { kind: hit.kind, ref: hit.ref, t: hit.t, dist: hit.dist } };
}

/** Filter, der ein bestimmtes Element (z. B. das gerade bewegte) ausschliesst. */
export function excludeFeature(featureId) {
  return (ref) => !(ref.source === 'draft' && ref.featureId === featureId);
}
