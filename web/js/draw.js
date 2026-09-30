// Zeichnet den Entwurf und alle Hilfsgrafiken auf das Karten-Canvas.
// Reihenfolge (unten nach oben): OSM-Strassen, Auswahl-Halo, Tunnel,
// ebenerdige Abschnitte, Brücken, Kreisel, Kreuzungen, Pfeile, Beschriftung,
// Bearbeitungsgriffe, Zeichenvorschau, Einrast-Markierung.

import { ROAD_KINDS, getLayer, zoneKind } from './model.js';

const KIND_WIDTH = Object.fromEntries(ROAD_KINDS.map((k) => [k.id, k.width]));

export function drawScene(ctx, map, s) {
  const { doc, selection, osmWays = [], showOsm = false, preview = null, snap = null, showHandles = false, routes = null, routeDraft = null, comments = [], activeCommentId = null, commentDraft = null } = s;
  const zoom = map.getZoom();
  const P = (ll) => map.project(ll);
  const mpp = map.metersPerPixel();
  const lineScale = zoom >= 15 ? 1 : zoom >= 13 ? 0.7 : 0.45;
  const visible = doc.features.filter((f) => {
    const l = getLayer(doc, f.layerId);
    return l && l.visible !== false;
  });
  const colorOf = (f) => (getLayer(doc, f.layerId) || {}).color || '#333';

  if (showOsm && osmWays.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(61,90,254,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 5]);
    for (const w of osmWays) strokePath(ctx, w.geometry.map(P));
    ctx.restore();
  }

  // Zonen (Flächen) unter allem anderen
  for (const f of visible) {
    if (f.type !== 'zone') continue;
    drawZone(ctx, P, f, colorOf(f), zoom);
  }

  const selected = selection ? visible.find((f) => f.id === selection.featureId) : null;
  if (selected) drawSelectionHalo(ctx, P, selected, selection, mpp, lineScale);

  const roads = visible.filter((f) => f.type === 'road');
  // Tunnel
  for (const f of roads) {
    const w = KIND_WIDTH[f.kind] * lineScale;
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
    const w = KIND_WIDTH[f.kind] * lineScale;
    ctx.save();
    ctx.globalAlpha = f.status === 'existing' ? 0.6 : 0.85;
    eachSegment(f, 'ground', (a, b) => stroke(ctx, [P(a), P(b)], '#2b2b2b', w + 2, 'round'));
    ctx.restore();
  }
  for (const f of roads) {
    const w = KIND_WIDTH[f.kind] * lineScale;
    ctx.save();
    if (f.status === 'existing') ctx.globalAlpha = 0.7;
    if (f.status === 'remove') ctx.setLineDash([6, 6]);
    eachSegment(f, 'ground', (a, b) => stroke(ctx, [P(a), P(b)], roadColor(f, colorOf(f)), w, f.status === 'remove' ? 'butt' : 'round'));
    ctx.restore();
  }
  // Brücken: dunkle Einfassung, weisser Rand, Füllung
  for (const f of roads) {
    const w = KIND_WIDTH[f.kind] * lineScale;
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
    const glyph = { plain: '', signals: 'A', priority: 'V', stop: 'S', crossing: '≡', busstop: 'H' }[f.kind] || '';
    const fill = f.kind === 'busstop' ? '#ffe600' : '#fff';
    circle(ctx, c, 9, { stroke: colorOf(f), width: 3, fill });
    if (glyph) text(ctx, glyph, c.x, c.y + 0.5, { font: 'bold 11px system-ui, sans-serif', color: '#222', align: 'center', baseline: 'middle' });
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
      if (f.name) label(ctx, P, f, KIND_WIDTH[f.kind] * lineScale);
      if (f.maxspeed) speedSign(ctx, P, f);
    }
  }
  drawRoutes(ctx, P, doc.route, routes, routeDraft);
  drawComments(ctx, P, comments, activeCommentId, commentDraft);
  if (showHandles && selected) drawHandles(ctx, P, selected);
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

function speedSign(ctx, P, road) {
  const seg = longestSegment(P, road);
  if (!seg || seg.len < 70) return;
  const c = { x: seg.a.x + (seg.b.x - seg.a.x) * 0.3, y: seg.a.y + (seg.b.y - seg.a.y) * 0.3 };
  circle(ctx, c, 10, { stroke: '#c62828', width: 3, fill: '#fff' });
  text(ctx, String(road.maxspeed), c.x, c.y + 0.5, { font: 'bold 9px system-ui, sans-serif', color: '#111', align: 'center', baseline: 'middle' });
}

function drawRoutes(ctx, P, query, routes, routeDraft) {
  const marker = (ll, letter) => {
    const c = P(ll);
    circle(ctx, c, 11, { stroke: '#fff', width: 2, fill: '#1f2933' });
    text(ctx, letter, c.x, c.y + 0.5, { font: 'bold 12px system-ui, sans-serif', color: '#fff', align: 'center', baseline: 'middle' });
  };
  if (routes) {
    const paths = [
      { r: routes.current, color: '#1b6ac9' },
      { r: routes.proposed, color: '#2a9d3f' },
    ];
    for (const { r, color } of paths) {
      if (!r || r.error || !r.path) continue;
      const pts = r.path.map(P);
      ctx.save();
      ctx.globalAlpha = 0.9;
      stroke(ctx, pts, '#ffffff', 9);
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
  comments.forEach((c, i) => marker([c.lat, c.lng], c.resolved ? COMMENT_RESOLVED_COLOR : COMMENT_COLOR, i + 1, c.id === activeId));
  if (draft && draft.latlng) marker(draft.latlng, '#1b6ac9', null, true);
}

function drawSelectionHalo(ctx, P, f, selection, mpp, lineScale) {
  ctx.save();
  ctx.globalAlpha = 0.75;
  if (f.type === 'road') {
    const w = KIND_WIDTH[f.kind] * lineScale;
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

function drawHandles(ctx, P, f) {
  for (const h of handlePoints(f)) {
    const c = P(h.latlng);
    if (h.kind === 'vertex') circle(ctx, c, 6, { stroke: '#1a1a1a', width: 2, fill: '#fff' });
    else circle(ctx, c, 4, { stroke: '#1a1a1a', width: 1, fill: 'rgba(255,255,255,0.75)' });
  }
}

function drawPreview(ctx, P, preview, mpp) {
  const color = preview.color || '#333';
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
