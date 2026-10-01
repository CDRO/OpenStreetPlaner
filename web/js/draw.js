// Zeichnet den Entwurf und alle Hilfsgrafiken auf das Karten-Canvas.
// Reihenfolge (unten nach oben): OSM-Strassen, Auswahl-Halo, Tunnel,
// ebenerdige Abschnitte, Brücken, Kreisel, Kreuzungen, Pfeile, Beschriftung,
// Bearbeitungsgriffe, Zeichenvorschau, Einrast-Markierung.

import { ROAD_KINDS, getLayer, roadMedian, roadWidthMeters, sectionBands, segmentAccess, segmentSpeed, zoneKind } from './model.js';
import { haversine } from './geometry.js';
import { ringAreaM2 } from './costs.js';

const KIND_WIDTH = Object.fromEntries(ROAD_KINDS.map((k) => [k.id, k.width]));
/** Strichmuster „neu“ (Routen) bzw. „nicht mehr“ (Differenz): Unterscheidung auch ohne Farbe. */
export const ROUTE_DASH = [14, 8];
export const LOST_DASH = [7, 7];

/** Farben der Querschnitt-Bänder. */
const BAND_COLORS = {
  walk: '#d8d8d8', park: '#b9c3cf', bike: '#e4b98f', shoulder: '#c9ccd1', median: '#8fa08a',
};
/** Ab dieser Auflösung (Pixel pro Meter) werden Querschnitte als Bänder gezeichnet. */
export const BAND_MIN_PX_PER_M = 1.2;
/** Ab dieser Auflösung kommen Fahrstreifen-Markierungen dazu. */
const MARKING_MIN_PX_PER_M = 3;

export function drawScene(ctx, map, s) {
  const { doc, selection, osmWays = [], showOsm = false, preview = null, snap = null, showHandles = false, routes = null, routeDraft = null, comments = [], activeCommentId = null, commentDraft = null, parcels = null, buildings = null, isochrone = null, pairs = null, routeTarget = null, diff = null, busLines = null, transit = null, multiIds = null, handleRadius = 6, ghostIds = null } = s;
  const zoom = map.getZoom();
  const P = (ll) => map.project(ll);
  const mpp = map.metersPerPixel();
  const lineScale = zoom >= 15 ? 1 : zoom >= 13 ? 0.7 : 0.45;
  // Ab etwa Zoom 17 übernimmt die reale Breite in Metern.
  const widthOf = (f) => Math.min(200, Math.max(KIND_WIDTH[f.kind] * lineScale, roadWidthMeters(f) / mpp));
  const visible = doc.features.filter((f) => {
    const l = getLayer(doc, f.layerId);
    return l && l.visible !== false && !(ghostIds && ghostIds.has(f.id));
  });
  // Elemente späterer Etappen: nur als graue, gestrichelte Geister
  if (ghostIds && ghostIds.size) {
    for (const f of doc.features) {
      const l = getLayer(doc, f.layerId);
      if (ghostIds.has(f.id) && l && l.visible !== false) outlineFeature(ctx, P, f, 'rgba(110,110,110,0.7)', [6, 6], mpp, 3);
    }
  }
  const colorOf = (f) => (getLayer(doc, f.layerId) || {}).color || '#333';

  if (showOsm && osmWays.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(61,90,254,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 5]);
    for (const w of osmWays) strokePath(ctx, w.geometry.map(P));
    ctx.restore();
  }

  // Bestehende Haltestellen aus OSM (blau; übernommene erscheinen als eigene Haltestellen)
  if (transit && zoom >= 13) drawOsmStops(ctx, P, transit, zoom);

  // Zonen (Flächen) unter allem anderen
  for (const f of visible) {
    if (f.type !== 'zone') continue;
    drawZone(ctx, P, f, colorOf(f), zoom);
  }

  // Betroffene Gebäude (rot: neu betroffen, grün: entlastet, orange: beides) und Parzellen der gewählten Strasse
  if (buildings) drawBuildings(ctx, P, buildings);
  if (parcels) drawParcels(ctx, P, parcels);
  if (isochrone && isochrone.pieces) drawIsochrone(ctx, P, isochrone, doc.isochrone);

  const selected = selection ? visible.find((f) => f.id === selection.featureId) : null;
  if (multiIds && multiIds.size) {
    for (const f of visible) if (multiIds.has(f.id) && f !== selected) drawSelectionHalo(ctx, P, f, { featureId: f.id, segIndex: null }, mpp, lineScale);
  }
  if (selected) drawSelectionHalo(ctx, P, selected, selection, mpp, lineScale);

  const roads = visible.filter((f) => f.type === 'road');
  // Tunnel
  for (const f of roads) {
    const w = widthOf(f);
    eachSegment(f, 'tunnel', (a, b) => {
      ctx.save();
      ctx.globalAlpha = f.status === 'existing' ? 0.4 : 0.55;
      ctx.setLineDash([10, 8]);
      ctx.lineCap = 'butt';
      stroke(ctx, [P(a), P(b)], roadColor(f, colorOf(f)), w);
      ctx.restore();
    });
  }
  // Ebenerdig: erst alle Einfassungen, dann alle Füllungen (saubere Kreuzungen)
  for (const f of roads) {
    const w = widthOf(f);
    ctx.save();
    ctx.globalAlpha = f.status === 'existing' ? 0.6 : 0.85;
    eachSegment(f, 'ground', (a, b) => stroke(ctx, [P(a), P(b)], '#2b2b2b', w + 2, 'round'));
    ctx.restore();
  }
  for (const f of roads) {
    const w = widthOf(f);
    ctx.save();
    if (f.status === 'existing') ctx.globalAlpha = 0.7;
    if (f.status === 'remove') ctx.setLineDash([6, 6]);
    eachSegment(f, 'ground', (a, b) => stroke(ctx, [P(a), P(b)], roadColor(f, colorOf(f)), w, f.status === 'remove' ? 'butt' : 'round'));
    ctx.restore();
  }
  // Brücken: dunkle Einfassung, weisser Rand, Füllung
  for (const f of roads) {
    const w = widthOf(f);
    ctx.save();
    if (f.status === 'existing') ctx.globalAlpha = 0.7;
    eachSegment(f, 'bridge', (a, b) => {
      const pts = [P(a), P(b)];
      stroke(ctx, pts, '#1a1a1a', w + 7, 'butt');
      stroke(ctx, pts, '#ffffff', w + 3, 'butt');
      if (f.status === 'remove') ctx.setLineDash([6, 6]);
      stroke(ctx, pts, roadColor(f, colorOf(f)), w, 'butt');
      ctx.setLineDash([]);
    });
    ctx.restore();
  }
  // Getrennte Fahrbahnen (Autobahn, Mittelstreifen) und Querschnitt-Bänder
  const pxPerM = 1 / mpp;
  for (const f of roads) {
    if (f.status === 'remove') continue;
    const median = roadMedian(f);
    const bands = f.section && pxPerM >= BAND_MIN_PX_PER_M ? sectionBands(f.section) : null;
    if (!bands && median > 0) {
      // Nur der Mittelstreifen: zwei Fahrbahnen mit Abstand
      const gap = Math.max(1.5, median * pxPerM);
      const w = widthOf(f);
      if (gap < w) drawMedian(ctx, P, f, gap, f.status === 'existing' ? 0.7 : 1);
      continue;
    }
    if (bands) drawSectionBands(ctx, P, f, bands, pxPerM, colorOf(f), f.status === 'existing' ? 0.7 : 1);
  }
  // Busschleusen: gelbe Strichelung in der Achse, ab Zoom 16 mit „BUS“
  for (const f of roads) {
    if (f.status === 'remove') continue;
    for (let i = 0; i < f.segments.length; i++) {
      if (segmentAccess(f, i) !== 'bus') continue;
      const a = P(f.nodes[i]);
      const b = P(f.nodes[i + 1]);
      ctx.save();
      ctx.setLineDash([8, 6]);
      stroke(ctx, [a, b], '#ffd600', Math.max(2, widthOf(f) * 0.35), 'butt');
      ctx.restore();
      if (zoom >= 16 && Math.hypot(b.x - a.x, b.y - a.y) > 36) {
        let angle = Math.atan2(b.y - a.y, b.x - a.x);
        if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
        ctx.save();
        ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
        ctx.rotate(angle);
        text(ctx, 'BUS', 0, 0.5, { font: 'bold 9px system-ui, sans-serif', color: '#5d4037', halo: 'rgba(255,214,0,0.9)', align: 'center', baseline: 'middle' });
        ctx.restore();
      }
    }
  }
  // Buslinien: dünne farbige Linien entlang der berechneten Strecke (Netz mit Entwurf), Nummer an der ersten Haltestelle
  if (busLines) drawBusLines(ctx, P, busLines, zoom);
  // Kreisel
  for (const f of visible) {
    if (f.type !== 'roundabout') continue;
    const c = P(f.center);
    const r = Math.max(2, f.radius / mpp);
    circle(ctx, c, r, { stroke: '#2b2b2b', width: 9 * lineScale, alpha: 0.85 });
    circle(ctx, c, r, { stroke: colorOf(f), width: 7 * lineScale, fill: 'rgba(255,255,255,0.5)' });
  }
  // Kreuzungen
  for (const f of visible) {
    if (f.type !== 'junction') continue;
    const c = P(f.at);
    const glyph = { plain: '', signals: 'A', priority: 'V', stop: 'S', crossing: '≡', busstop: 'H', interchange: '' }[f.kind] || '';
    const fill = f.kind === 'busstop' ? '#ffe600' : '#fff';
    if (f.kind === 'interchange') diamond(ctx, c, 11, { stroke: colorOf(f), width: 3, fill });
    else circle(ctx, c, 9, { stroke: colorOf(f), width: 3, fill });
    if (glyph) text(ctx, glyph, c.x, c.y + 0.5, { font: 'bold 11px system-ui, sans-serif', color: '#222', align: 'center', baseline: 'middle' });
    if (f.turns && zoom >= 16) drawTurnBans(ctx, c, f.turns);
    if (f.kind === 'busstop' && f.lines && f.lines.length && zoom >= 15) {
      text(ctx, f.lines.join(' '), c.x + 12, c.y + 0.5, { font: 'bold 10px system-ui, sans-serif', color: '#5d4037', halo: 'rgba(255,255,255,0.9)', align: 'left', baseline: 'middle' });
    }
  }
  // Einbahn-Pfeile
  if (zoom >= 15) {
    for (const f of roads) {
      if (!f.oneway) continue;
      for (let i = 0; i < f.nodes.length - 1; i++) {
        const a = P(f.nodes[i]);
        const b = P(f.nodes[i + 1]);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 24) continue;
        arrow(ctx, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.atan2(b.y - a.y, b.x - a.x));
      }
    }
  }
  // Beschriftung und Tempolimit-Schilder
  if (zoom >= 16) {
    for (const f of roads) {
      if (f.name) label(ctx, P, f, widthOf(f));
      speedSigns(ctx, P, f);
    }
  }
  drawRoutePairs(ctx, P, doc.routePairs || [], pairs, routeDraft, routeTarget);
  drawRoutes(ctx, P, doc.route, routes, routeDraft && !routeDraft.pairId ? routeDraft : null);
  if (doc.isochrone && doc.isochrone.from) {
    const c = P(doc.isochrone.from);
    circle(ctx, c, 10, { stroke: '#fff', width: 2, fill: '#7b3fbf' });
    circle(ctx, c, 4, { fill: '#fff' });
  }
  drawComments(ctx, P, comments, activeCommentId, commentDraft);
  if (diff) drawDiff(ctx, P, diff, mpp);
  if (showHandles && selected) drawHandles(ctx, P, selected, handleRadius);
  if (preview) drawPreview(ctx, P, preview, mpp);
  if (snap) {
    const c = P(snap.latlng);
    circle(ctx, c, snap.kind === 'node' ? 8 : 6, { stroke: snap.kind === 'node' ? '#ff6d00' : '#ff9800', width: 3, fill: '#fff' });
  }
}

/** Trefferprüfung für Griffe: liefert { kind: 'vertex'|'midpoint', index } oder null. */
export function hitHandle(map, feature, point, tol = 9) {
  if (!feature) return null;
  const pts = handlePoints(feature).map((h) => ({ ...h, p: map.project(h.latlng) }));
  let best = null;
  for (const h of pts) {
    const d = Math.hypot(h.p.x - point.x, h.p.y - point.y);
    const limit = h.kind === 'vertex' ? tol : tol - 2;
    if (d <= limit && (!best || d < best.d)) best = { ...h, d };
  }
  return best ? { kind: best.kind, index: best.index } : null;
}

export function handlePoints(feature) {
  const out = [];
  if (feature.type === 'road') {
    feature.nodes.forEach((n, i) => out.push({ kind: 'vertex', index: i, latlng: n }));
    for (let i = 0; i < feature.nodes.length - 1; i++) {
      const a = feature.nodes[i];
      const b = feature.nodes[i + 1];
      out.push({ kind: 'midpoint', index: i, latlng: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
  } else if (feature.type === 'zone') {
    const n = feature.nodes.length;
    feature.nodes.forEach((p, i) => out.push({ kind: 'vertex', index: i, latlng: p }));
    for (let i = 0; i < n; i++) {
      const a = feature.nodes[i];
      const b = feature.nodes[(i + 1) % n];
      out.push({ kind: 'midpoint', index: i, latlng: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
  } else if (feature.type === 'junction') {
    out.push({ kind: 'vertex', index: 0, latlng: feature.at });
  } else if (feature.type === 'roundabout') {
    out.push({ kind: 'vertex', index: 0, latlng: feature.center });
  }
  return out;
}

/** Kommentar-Marker unter dem Zeiger (Toleranz in Pixeln) oder null. */
export function hitComment(map, comments, point, tol = 13) {
  let best = null;
  for (const c of comments) {
    if (c.parentId) continue;
    const p = map.project([c.lat, c.lng]);
    const d = Math.hypot(p.x - point.x, p.y - (point.y + 10));
    if (d <= tol && (!best || d < best.d)) best = { id: c.id, d };
  }
  return best ? best.id : null;
}

export const COMMENT_COLOR = '#e08a00';
export const COMMENT_RESOLVED_COLOR = '#9aa3ad';

// --- Hilfen ------------------------------------------------------------------

function roadColor(f, layerColor) {
  return f.status === 'remove' ? '#c62828' : layerColor;
}

function eachSegment(road, level, fn) {
  for (let i = 0; i < road.segments.length; i++) {
    if (road.segments[i].level === level) fn(road.nodes[i], road.nodes[i + 1]);
  }
}

function strokePath(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function stroke(ctx, pts, color, width, cap = 'round') {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  strokePath(ctx, pts);
}

/** Parzellen-Umringe (erster Ring aussen, weitere Löcher) als orange Flächen. */
function drawParcels(ctx, P, polygons) {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 193, 7, 0.18)';
  ctx.strokeStyle = '#e08a00';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  for (const rings of polygons) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach((ll, i) => {
        const p = P(ll);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
  }
  ctx.restore();
}

export const BUILDING_COLORS = { proposed: 'rgba(198, 40, 40, 0.6)', relieved: 'rgba(42, 157, 63, 0.6)', both: 'rgba(224, 138, 0, 0.65)', other: 'rgba(120, 120, 120, 0.18)' };

/** Gebäude-Umringe: betroffene farbig, übrige blass. */
const hatchCache = new Map();
/** Schraffur-Muster (diagonal, Punkte, Kreuz) als Canvas-Pattern, damit Gebäude auch ohne Farbe unterscheidbar sind. */
export function hatchPattern(ctx, kind, color) {
  const key = `${kind}|${color}`;
  if (hatchCache.has(key)) return hatchCache.get(key);
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 1.5;
  if (kind === 'diagonal' || kind === 'cross') {
    g.beginPath();
    g.moveTo(0, 8);
    g.lineTo(8, 0);
    g.stroke();
  }
  if (kind === 'cross') {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(8, 8);
    g.stroke();
  }
  if (kind === 'dots') {
    g.beginPath();
    g.arc(4, 4, 1.4, 0, Math.PI * 2);
    g.fill();
  }
  const pat = ctx.createPattern(c, 'repeat');
  hatchCache.set(key, pat);
  return pat;
}

function drawBuildings(ctx, P, { list, current, proposed, roads }) {
  ctx.save();
  for (const b of list) {
    const g = b.geometry;
    if (!g || g.length < 3) continue;
    const hitNew = proposed.has(b.id) || roads.has(b.id);
    const hitCur = current.has(b.id);
    const color = hitNew && hitCur ? BUILDING_COLORS.both : hitNew ? BUILDING_COLORS.proposed : hitCur ? BUILDING_COLORS.relieved : BUILDING_COLORS.other;
    const hatch = hitNew && hitCur ? 'cross' : hitNew ? 'diagonal' : hitCur ? 'dots' : null;
    ctx.beginPath();
    g.forEach((ll, i) => {
      const p = P(ll);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    if (hatch && typeof document !== 'undefined') {
      ctx.fillStyle = hatchPattern(ctx, hatch, color);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fill();
    if (hitNew || hitCur) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Raute (kreuzungsfreier Anschluss). */
function diamond(ctx, c, r, { stroke: strokeColor, width = 1, fill = null } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(c.x, c.y - r);
  ctx.lineTo(c.x + r, c.y);
  ctx.lineTo(c.x, c.y + r);
  ctx.lineTo(c.x - r, c.y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** Kleine rote Verbotsmarken neben einer Kreuzung für gesperrte Abbiegerichtungen. */
function drawTurnBans(ctx, c, turns) {
  const banned = [];
  if (!turns.left) banned.push('↰');
  if (!turns.straight) banned.push('↑');
  if (!turns.right) banned.push('↱');
  if (!banned.length) return;
  banned.forEach((g, i) => {
    const x = c.x + 14 + i * 13;
    const y = c.y - 10;
    circle(ctx, { x, y }, 6, { stroke: '#c62828', width: 1.5, fill: '#fff' });
    text(ctx, g, x, y + 0.5, { font: 'bold 9px system-ui, sans-serif', color: '#c62828', align: 'center', baseline: 'middle' });
    ctx.save();
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4);
    ctx.lineTo(x + 4, y + 4);
    ctx.stroke();
    ctx.restore();
  });
}

/**
 * Parallele Linie im Abstand d (Pixel, positiv = rechts der Zeichenrichtung).
 * Eckpunkte werden entlang der Winkelhalbierenden versetzt (begrenzte Gehrung).
 */
export function offsetPolyline(pts, d) {
  const n = pts.length;
  if (n < 2 || d === 0) return pts.slice();
  const normals = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / len, y: dx / len }); // rechts der Richtung (y zeigt nach unten)
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(n - 2, i)];
    let mx = (a.x + b.x) / 2;
    let my = (a.y + b.y) / 2;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = b.x;
      my = b.y;
    } else {
      // Länge 1/cos(θ/2), auf das Dreifache begrenzt (spitze Winkel)
      const cosHalf = Math.max(1 / 3, ml);
      mx = (mx / ml) / cosHalf;
      my = (my / ml) / cosHalf;
    }
    out.push({ x: pts[i].x + mx * d, y: pts[i].y + my * d });
  }
  return out;
}

/** Mittelstreifen entlang der Achse, nur auf ebenerdigen und Brücken-Abschnitten. */
function drawMedian(ctx, P, road, gap, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < road.segments.length; i++) {
    if (road.segments[i].level === 'tunnel') continue;
    stroke(ctx, [P(road.nodes[i]), P(road.nodes[i + 1])], BAND_COLORS.median, gap, 'butt');
  }
  ctx.restore();
}

/** Querschnitt als Bänder: Trottoir, Parkstreifen, Velostreifen, Pannenstreifen, Mittelstreifen und Fahrstreifen-Markierungen. */
function drawSectionBands(ctx, P, road, bands, pxPerM, layerColor, alpha) {
  const total = bands.reduce((sum, b) => sum + b.width, 0);
  const pts = road.nodes.map(P);
  ctx.save();
  ctx.globalAlpha = alpha;
  const runs = [];
  // Zusammenhängende Läufe ohne Tunnel, damit die versetzten Linien saubere Ecken haben
  let start = null;
  for (let i = 0; i <= road.segments.length; i++) {
    const tunnel = i < road.segments.length && road.segments[i].level === 'tunnel';
    if (!tunnel && start === null) start = i;
    if ((tunnel || i === road.segments.length) && start !== null) {
      if (i > start) runs.push(pts.slice(start, i + 1));
      start = null;
    }
  }
  let offset = -total / 2;
  const markings = pxPerM >= MARKING_MIN_PX_PER_M;
  const edges = [];
  for (const b of bands) {
    const center = offset + b.width / 2;
    const color = BAND_COLORS[b.kind];
    if (color) {
      for (const run of runs) stroke(ctx, offsetPolyline(run, center * pxPerM), color, Math.max(1, b.width * pxPerM), 'butt');
    }
    if (b.kind === 'lane') edges.push(offset, offset + b.width);
    offset += b.width;
  }
  if (markings) {
    // Fahrbahnränder durchgezogen, Fahrstreifen-Grenzen gestrichelt
    const uniq = Array.from(new Set(edges.map((e) => Math.round(e * 100) / 100)));
    const counts = new Map();
    edges.forEach((e) => counts.set(Math.round(e * 100) / 100, (counts.get(Math.round(e * 100) / 100) || 0) + 1));
    for (const e of uniq) {
      const inner = counts.get(e) === 2; // Grenze zwischen zwei Fahrstreifen
      ctx.setLineDash(inner ? [3 * pxPerM, 6 * pxPerM] : []);
      for (const run of runs) stroke(ctx, offsetPolyline(run, e * pxPerM), 'rgba(255,255,255,0.9)', Math.max(1, 0.15 * pxPerM), 'butt');
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function circle(ctx, c, r, { stroke: strokeColor, width = 1, fill = null, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}

function text(ctx, str, x, y, { font, color = '#000', halo = null, align = 'left', baseline = 'alphabetic' }) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (halo) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function arrow(ctx, c, angle) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-5, -5);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function label(ctx, P, road, width) {
  let best = null;
  for (let i = 0; i < road.nodes.length - 1; i++) {
    const a = P(road.nodes[i]);
    const b = P(road.nodes[i + 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { a, b, len };
  }
  if (!best || best.len < 40) return;
  let angle = Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  ctx.save();
  ctx.translate((best.a.x + best.b.x) / 2, (best.a.y + best.b.y) / 2);
  ctx.rotate(angle);
  text(ctx, road.name, 0, -(width / 2 + 6), { font: '600 12px system-ui, sans-serif', color: '#1f2933', halo: 'rgba(255,255,255,0.9)', align: 'center', baseline: 'alphabetic' });
  ctx.restore();
}

function longestSegment(P, road) {
  let best = null;
  for (let i = 0; i < road.nodes.length - 1; i++) {
    const a = P(road.nodes[i]);
    const b = P(road.nodes[i + 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { a, b, len };
  }
  return best;
}

/** Ein Schild pro Lauf gleicher Geschwindigkeit, wenn ein Limit gesetzt ist (Strasse oder Abschnitt). */
function speedSigns(ctx, P, road) {
  let prev = null;
  let run = null;
  const flush = () => {
    if (!run) return;
    const seg = longestSegment(P, { nodes: road.nodes.slice(run.start, run.end + 2) });
    if (seg && seg.len >= 50) {
      const c = { x: seg.a.x + (seg.b.x - seg.a.x) * 0.35, y: seg.a.y + (seg.b.y - seg.a.y) * 0.35 };
      circle(ctx, c, 10, { stroke: '#c62828', width: 3, fill: '#fff' });
      text(ctx, String(run.speed), c.x, c.y + 0.5, { font: 'bold 9px system-ui, sans-serif', color: '#111', align: 'center', baseline: 'middle' });
    }
    run = null;
  };
  for (let i = 0; i < road.segments.length; i++) {
    const explicit = (road.segments[i].maxspeed || road.maxspeed) ? segmentSpeed(road, i) : null;
    if (explicit !== prev) {
      flush();
      if (explicit) run = { start: i, end: i, speed: explicit };
    } else if (run) {
      run.end = i;
    }
    prev = explicit;
  }
  flush();
}

function drawRoutes(ctx, P, query, routes, routeDraft) {
  const marker = (ll, letter) => {
    const c = P(ll);
    circle(ctx, c, 11, { stroke: '#fff', width: 2, fill: '#1f2933' });
    text(ctx, letter, c.x, c.y + 0.5, { font: 'bold 12px system-ui, sans-serif', color: '#fff', align: 'center', baseline: 'middle' });
  };
  if (routes) {
    const paths = [
      { r: routes.current, color: '#1b6ac9', dash: [] },
      { r: routes.proposed, color: '#2a9d3f', dash: ROUTE_DASH },
    ];
    for (const { r, color, dash } of paths) {
      if (!r || r.error || !r.path) continue;
      const pts = r.path.map(P);
      ctx.save();
      ctx.globalAlpha = 0.9;
      stroke(ctx, pts, '#ffffff', 9);
      ctx.setLineDash(dash); // neu gestrichelt: auch ohne Farbsehen unterscheidbar
      stroke(ctx, pts, color, 5);
      ctx.restore();
    }
  }
  if (routeDraft && routeDraft.from) marker(routeDraft.from, 'A');
  if (query && query.from && query.to) {
    marker(query.from, 'A');
    marker(query.to, 'B');
  }
}

/** Versionsvergleich: Halo um neue (grün) und geänderte (orange) Elemente, entfernte als rote gestrichelte Geister. */
/** Umriss eines Elements in einer Farbe mit Strichmuster (Versionsvergleich, Etappen-Geister). */
function outlineFeature(ctx, P, f, color, dash, mpp, width = 4) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = 0.9;
  ctx.setLineDash(dash);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (f.type === 'road' || f.type === 'zone') {
    const pts = f.nodes.map(P);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (f.type === 'zone') ctx.closePath();
    ctx.stroke();
  } else if (f.type === 'junction') {
    const c = P(f.at);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
    ctx.stroke();
  } else if (f.type === 'roundabout') {
    const c = P(f.center);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(6, f.radius / mpp) + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDiff(ctx, P, diff, mpp) {
  const outline = (f, color, dash) => outlineFeature(ctx, P, f, color, dash, mpp);
  // Entfernt gestrichelt, geändert punktiert, neu durchgezogen: auch ohne Farbe unterscheidbar
  for (const f of diff.removed) outline(f, '#c62828', [8, 6]);
  for (const c of diff.changed) outline(c.after, '#e08a00', [2, 5]);
  for (const f of diff.added) outline(f, '#2a9d3f', []);
}

/** Buslinien: [{ id, name, color, path }] – path = berechnete Strecke mit Entwurf. */
function drawOsmStops(ctx, P, { stops, adopted }, zoom) {
  const r = zoom >= 15 ? 6 : 4;
  for (const s of stops) {
    if (adopted && adopted.has(s.id)) continue;
    const c = P(s.at);
    circle(ctx, c, r, { stroke: 'rgba(61,90,254,0.8)', width: 2, fill: 'rgba(255,255,255,0.9)' });
    if (zoom >= 15) text(ctx, 'H', c.x, c.y + 0.5, { font: 'bold 8px system-ui, sans-serif', color: '#3d5afe', align: 'center', baseline: 'middle' });
    if (zoom >= 16 && s.name) {
      const label = s.lines && s.lines.length ? `${s.name} (${s.lines.join(' ')})` : s.name;
      text(ctx, label, c.x + r + 3, c.y + 0.5, { font: '10px system-ui, sans-serif', color: '#3d5afe', halo: 'rgba(255,255,255,0.9)', align: 'left', baseline: 'middle' });
    }
  }
}

function drawBusLines(ctx, P, lines, zoom) {
  for (const l of lines) {
    if (!l.path || l.path.length < 2) continue;
    const pts = l.path.map(P);
    ctx.save();
    ctx.globalAlpha = 0.9;
    stroke(ctx, pts, '#ffffff', 5, 'round');
    ctx.setLineDash([10, 4]);
    stroke(ctx, pts, l.color, 3, 'round');
    ctx.restore();
    if (zoom >= 14) {
      const p = pts[0];
      ctx.save();
      ctx.fillStyle = l.color;
      const w = ctx.measureText(l.name).width + 10;
      ctx.fillRect(p.x + 8, p.y - 18, Math.max(22, w), 14);
      text(ctx, l.name, p.x + 8 + Math.max(22, w) / 2, p.y - 11, { font: 'bold 10px system-ui, sans-serif', color: '#fff', align: 'center', baseline: 'middle' });
      ctx.restore();
    }
  }
}

export const ISO_COLORS = ['#2a9d3f', '#e0b400', '#e07a00', '#c62828', '#7b3fbf'];
export const ISO_DIFF_COLORS = { gained: '#2a9d3f', lost: '#c62828', both: 'rgba(90, 90, 90, 0.35)' };

/** Erreichbarkeits-Netz: Kantenstücke je Zeitband (schnellste zuletzt, damit sie oben liegen) oder Differenz. */
function drawIsochrone(ctx, P, iso) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  if (iso.mode === 'diff') {
    for (const status of ['both', 'lost', 'gained']) {
      ctx.setLineDash(status === 'lost' ? LOST_DASH : []);
      for (const p of iso.pieces) {
        if (p.status !== status) continue;
        stroke(ctx, [P(p.a), P(p.b)], ISO_DIFF_COLORS[status], status === 'both' ? 4 : 6, status === 'lost' ? 'butt' : 'round');
      }
    }
    ctx.setLineDash([]);
  } else {
    const n = iso.minutes.length;
    for (let band = n - 1; band >= 0; band--) {
      const color = ISO_COLORS[Math.min(band, ISO_COLORS.length - 1)];
      for (const p of iso.pieces) {
        if (p.band !== band) continue;
        stroke(ctx, [P(p.a), P(p.b)], color, 6, 'round');
      }
    }
  }
  ctx.restore();
}

/** Weitere Routenpaare: dünnere Linien und nummerierte Marker; das gerade zu setzende Paar zeigt nur seinen Start. */
function drawRoutePairs(ctx, P, pairsDef, results, routeDraft, routeTarget) {
  const marker = (ll, label, fill) => {
    const c = P(ll);
    circle(ctx, c, 9, { stroke: '#fff', width: 2, fill });
    text(ctx, label, c.x, c.y + 0.5, { font: 'bold 10px system-ui, sans-serif', color: '#fff', align: 'center', baseline: 'middle' });
  };
  pairsDef.forEach((pair, i) => {
    const res = results ? results.find((r) => r.id === pair.id) : null;
    if (res) {
      for (const [r, color, dash] of [[res.current, '#1b6ac9', []], [res.proposed, '#2a9d3f', ROUTE_DASH]]) {
        if (!r || r.error || !r.path) continue;
        const pts = r.path.map(P);
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([]);
        stroke(ctx, pts, '#ffffff', 6);
        ctx.setLineDash(dash);
        stroke(ctx, pts, color, 3);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
    const n = String(i + 1);
    if (pair.from) marker(pair.from, n, '#4a5568');
    if (pair.to) marker(pair.to, n, '#1f2933');
  });
  if (routeDraft && routeDraft.pairId) {
    const i = pairsDef.findIndex((p) => p.id === routeDraft.pairId);
    marker(routeDraft.from, String(i + 1), '#4a5568');
  }
}

function drawZone(ctx, P, f, layerColor, zoom) {
  const kind = zoneKind(f);
  const color = kind.color || layerColor;
  const pts = f.nodes.map(P);
  if (pts.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = f.kind === 'parking' ? 0.3 : 0.18;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.restore();
  if (zoom >= 15) {
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    const label = f.name ? `${f.name} · ${kind.label}` : kind.label;
    text(ctx, label, cx, cy, { font: '600 11px system-ui, sans-serif', color: '#1f2933', halo: 'rgba(255,255,255,0.9)', align: 'center', baseline: 'middle' });
  }
}

function drawComments(ctx, P, comments, activeId, draft) {
  const marker = (ll, color, index, active) => {
    const c = P(ll);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x - 8, c.y - 12);
    ctx.arc(c.x, c.y - 14, 10, Math.PI * 0.85, Math.PI * 2.15);
    ctx.lineTo(c.x + 8, c.y - 12);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = active ? '#1f2933' : '#fff';
    ctx.lineWidth = active ? 3 : 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (index !== null) text(ctx, String(index), c.x, c.y - 13.5, { font: 'bold 10px system-ui, sans-serif', color: '#fff', align: 'center', baseline: 'middle' });
  };
  comments.filter((c) => !c.parentId).forEach((c, i) => marker([c.lat, c.lng], c.resolved ? COMMENT_RESOLVED_COLOR : COMMENT_COLOR, i + 1, c.id === activeId));
  if (draft && draft.latlng) marker(draft.latlng, '#1b6ac9', null, true);
}

function drawSelectionHalo(ctx, P, f, selection, mpp, lineScale) {
  ctx.save();
  ctx.globalAlpha = 0.75;
  if (f.type === 'road') {
    const w = Math.min(200, Math.max(KIND_WIDTH[f.kind] * lineScale, roadWidthMeters(f) / mpp));
    stroke(ctx, f.nodes.map(P), '#ffd600', w + 10);
    if (selection.segIndex !== null && selection.segIndex !== undefined && f.segments[selection.segIndex]) {
      const i = selection.segIndex;
      ctx.globalAlpha = 0.6;
      stroke(ctx, [P(f.nodes[i]), P(f.nodes[i + 1])], '#ff6d00', w + 14, 'butt');
    }
  } else if (f.type === 'junction') {
    circle(ctx, P(f.at), 15, { fill: 'rgba(255,214,0,0.8)' });
  } else if (f.type === 'roundabout') {
    circle(ctx, P(f.center), Math.max(2, f.radius / mpp), { stroke: 'rgba(255,214,0,0.8)', width: 16 });
  } else if (f.type === 'zone') {
    const pts = f.nodes.map(P);
    ctx.lineJoin = 'round';
    stroke(ctx, [...pts, pts[0]], '#ffd600', 12);
  }
  ctx.restore();
}

function drawHandles(ctx, P, f, r = 6) {
  for (const h of handlePoints(f)) {
    const c = P(h.latlng);
    if (h.kind === 'vertex') circle(ctx, c, r, { stroke: '#1a1a1a', width: 2, fill: '#fff' });
    else circle(ctx, c, Math.max(3, r - 2), { stroke: '#1a1a1a', width: 1, fill: 'rgba(255,255,255,0.75)' });
  }
}

const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m >= 100 ? Math.round(m) : m.toFixed(1)} m`);
const fmtArea = (m2) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`);

/** Messung: gestrichelte Linie, Länge je Abschnitt, Summe am Ende, Fläche in der Mitte. */
function drawMeasure(ctx, P, m) {
  const pts = m.cursor ? [...m.points, m.cursor] : m.points;
  if (!pts.length) return;
  const px = pts.map(P);
  ctx.save();
  if (pts.length >= 3) {
    ctx.beginPath();
    px.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,109,0,0.12)';
    ctx.fill();
  }
  ctx.setLineDash([8, 6]);
  stroke(ctx, px, '#ff6d00', 3);
  ctx.setLineDash([]);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    total += d;
    const mid = { x: (px[i - 1].x + px[i].x) / 2, y: (px[i - 1].y + px[i].y) / 2 };
    text(ctx, fmtLen(d), mid.x, mid.y - 6, { font: 'bold 11px system-ui, sans-serif', color: '#bf360c', halo: 'rgba(255,255,255,0.9)', align: 'center', baseline: 'bottom' });
  }
  for (const p of px) circle(ctx, p, 4, { stroke: '#fff', width: 2, fill: '#ff6d00' });
  if (pts.length >= 2) {
    const last = px[px.length - 1];
    text(ctx, `Σ ${fmtLen(total)}`, last.x + 10, last.y + 4, { font: 'bold 12px system-ui, sans-serif', color: '#bf360c', halo: 'rgba(255,255,255,0.95)', align: 'left', baseline: 'middle' });
  }
  if (pts.length >= 3) {
    const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
    const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
    text(ctx, fmtArea(ringAreaM2(pts)), cx, cy, { font: 'bold 12px system-ui, sans-serif', color: '#bf360c', halo: 'rgba(255,255,255,0.95)', align: 'center', baseline: 'middle' });
  }
  ctx.restore();
}

function drawPreview(ctx, P, preview, mpp) {
  const color = preview.color || '#333';
  if (preview.measure) return drawMeasure(ctx, P, preview.measure);
  if (preview.box) {
    const [a, b] = preview.box;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#1b6ac9';
    ctx.fillStyle = 'rgba(27,106,201,0.08)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
    return;
  }
  if (preview.shapes) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([6, 4]);
    for (const sh of preview.shapes) {
      if (sh.circle) circle(ctx, P(sh.circle.center), Math.max(2, sh.circle.radius / mpp), { stroke: color, width: 3 });
      else if (sh.point) circle(ctx, P(sh.point), 9, { stroke: color, width: 3, fill: 'rgba(255,255,255,0.6)' });
      else {
        const pts = sh.points.map(P);
        stroke(ctx, sh.closed ? [...pts, pts[0]] : pts, color, 4);
      }
    }
    ctx.restore();
    return;
  }
  if (preview.circle) {
    const c = P(preview.circle.center);
    circle(ctx, c, Math.max(2, preview.circle.radius / mpp), { stroke: color, width: 4, fill: 'rgba(0,0,0,0.08)' });
    circle(ctx, c, 4, { fill: color });
    return;
  }
  const pts = (preview.points || []).map(P);
  if (preview.closed && pts.length >= 3) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (preview.cursor) {
      const c = P(preview.cursor);
      ctx.lineTo(c.x, c.y);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.restore();
  }
  if (pts.length >= 2) stroke(ctx, pts, color, 5);
  if (pts.length && preview.cursor) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.globalAlpha = 0.7;
    stroke(ctx, [pts[pts.length - 1], P(preview.cursor)], color, 4);
    ctx.restore();
  }
  for (const p of pts) circle(ctx, p, 4, { stroke: '#fff', width: 2, fill: color });
}
