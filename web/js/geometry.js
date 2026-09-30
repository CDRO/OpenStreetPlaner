// Reine Geometrie-Helfer (Web-Mercator), ohne DOM und ohne Leaflet.
// Alle Berechnungen fürs Einrasten laufen in projizierten Mercator-Einheiten,
// damit Toleranzen zoomabhängig aber breitengrad-unabhängig in Pixeln
// angegeben werden können.

export const EARTH_RADIUS = 6378137;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** [lat, lng] -> {x, y} in Mercator-Metern. */
export function project(latlng) {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latlng[0]));
  const x = EARTH_RADIUS * latlng[1] * D2R;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
  return { x, y };
}

/** {x, y} in Mercator-Metern -> [lat, lng]. */
export function unproject(p) {
  const lng = (p.x / EARTH_RADIUS) * R2D;
  const lat = (2 * Math.atan(Math.exp(p.y / EARTH_RADIUS)) - Math.PI / 2) * R2D;
  return [lat, lng];
}

/** Mercator-Einheiten pro Bildschirm-Pixel bei gegebener Zoomstufe (256px-Kacheln). */
export function unitsPerPixel(zoom) {
  return (2 * Math.PI * EARTH_RADIUS) / (256 * Math.pow(2, zoom));
}

/** Faktor Mercator-Einheiten pro echtem Meter auf gegebener Breite. */
export function mercatorScale(lat) {
  return 1 / Math.cos(lat * D2R);
}

/** Grosskreis-Distanz in Metern zwischen zwei [lat, lng]. */
export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * D2R;
  const dLng = (b[1] - a[1]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Länge eines Linienzugs aus [lat, lng]-Punkten in Metern. */
export function pathLength(latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) total += haversine(latlngs[i - 1], latlngs[i]);
  return total;
}

/** Kompasskurs (Grad, 0 = Nord, im Uhrzeigersinn) von a nach b. */
export function bearing(a, b) {
  const pa = project(a);
  const pb = project(b);
  const deg = Math.atan2(pb.x - pa.x, pb.y - pa.y) * R2D;
  return (deg + 360) % 360;
}

export function distance(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Nächster Punkt auf der Strecke a-b zu p, inklusive Parameter t in [0, 1]. */
export function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return { x, y, t, dist: Math.hypot(p.x - x, p.y - y) };
}

/** Nächster Punkt auf dem Kreis (Zentrum c, Radius r) zu p. */
export function closestPointOnCircle(p, c, r) {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: c.x + r, y: c.y, dist: r };
  const x = c.x + (dx / d) * r;
  const y = c.y + (dy / d) * r;
  return { x, y, dist: Math.abs(d - r) };
}

/**
 * Sucht das beste Einrast-Ziel für p innerhalb der Toleranz tol.
 * Knoten haben Vorrang vor Abschnitten und Kreisen.
 * index = { nodes: [{x, y, ref}], segments: [{a, b, minX, ..., ref}], circles: [{x, y, r, ref}] }
 * filter(ref) kann Kandidaten ausschliessen (z. B. das gerade bearbeitete Element).
 */
export function findSnap(p, index, tol, filter = null) {
  let best = null;
  for (const n of index.nodes) {
    if (Math.abs(n.x - p.x) > tol || Math.abs(n.y - p.y) > tol) continue;
    if (filter && !filter(n.ref)) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= tol && (!best || d < best.dist)) {
      best = { x: n.x, y: n.y, dist: d, ref: n.ref, kind: 'node' };
    }
  }
  if (best) return best;
  for (const s of index.segments) {
    if (p.x < s.minX - tol || p.x > s.maxX + tol || p.y < s.minY - tol || p.y > s.maxY + tol) continue;
    if (filter && !filter(s.ref)) continue;
    const c = closestPointOnSegment(p, s.a, s.b);
    if (c.dist <= tol && (!best || c.dist < best.dist)) {
      best = { x: c.x, y: c.y, t: c.t, dist: c.dist, ref: s.ref, kind: 'segment' };
    }
  }
  for (const c of index.circles) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (Math.abs(d - c.r) > tol) continue;
    if (filter && !filter(c.ref)) continue;
    const q = closestPointOnCircle(p, c, c.r);
    if (q.dist <= tol && (!best || q.dist < best.dist)) {
      best = { x: q.x, y: q.y, dist: q.dist, ref: c.ref, kind: 'circle' };
    }
  }
  return best;
}

/** Baut einen Abschnitts-Eintrag mit Bounding-Box für den Snap-Index. */
export function segmentEntry(a, b, ref) {
  return {
    a,
    b,
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
    ref,
  };
}

/** Punkte eines Kreises als [lat, lng]-Ring (für GeoJSON-Export). */
export function circleRing(centerLatLng, radiusMeters, steps = 32) {
  const c = project(centerLatLng);
  const r = radiusMeters * mercatorScale(centerLatLng[0]);
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(unproject({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }));
  }
  return ring;
}
