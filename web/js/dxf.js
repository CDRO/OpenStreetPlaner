// DXF-Export (AutoCAD R12, ASCII) in Schweizer Landeskoordinaten LV95 für die Übergabe an CAD.
// Strassen und Flächen als POLYLINE, Punkte als POINT mit TEXT, Kreisel als CIRCLE; eine DXF-Ebene je Entwurfsebene.
import { LEVELS, ROAD_KINDS, getLayer, roadWidthMeters, zoneKind } from './model.js';

/** WGS84 -> LV95 nach den Näherungsformeln von swisstopo (Genauigkeit rund 1 m). */
export function wgs84ToLV95(lat, lon) {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lon * 3600 - 26782.5) / 10000;
  const east = 2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam * lam * lam;
  const north = 1200147.07 + 308807.95 * phi + 3745.25 * lam * lam + 76.63 * phi * phi - 194.56 * lam * lam * phi + 119.79 * phi * phi * phi;
  return [Math.round(east * 100) / 100, Math.round(north * 100) / 100];
}

const ACI = { '#d7263d': 1, '#1b6ac9': 5, '#2a9d3f': 3, '#e08a00': 30, '#7b3fbf': 6, '#0e9aa7': 4, '#c2185b': 221, '#5d4037': 34 };

/** Nächstliegende AutoCAD-Farbnummer zu einer Hex-Farbe (nur grobe Zuordnung). */
export function aciColor(hex) {
  if (ACI[hex]) return ACI[hex];
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 7;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  if (r > 150 && g < 100 && b < 100) return 1;
  if (g > 150 && r < 120 && b < 120) return 3;
  if (b > 150 && r < 120 && g < 150) return 5;
  if (r > 180 && g > 120 && b < 80) return 30;
  if (r > 120 && b > 120 && g < 100) return 6;
  if (g > 120 && b > 120 && r < 100) return 4;
  return 7;
}

/** DXF-Ebenenname: ASCII, ohne Sonderzeichen, höchstens 31 Zeichen. */
export function dxfLayerName(name, fallback = 'EBENE') {
  const s = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 31);
  return s || fallback;
}

const pair = (code, value) => `${code}\n${value}\n`;
const text = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 255);

/** Erzeugt die DXF-Datei (R12) als Text. */
export function toDXF(doc) {
  const layers = doc.layers.map((l, i) => ({ id: l.id, name: dxfLayerName(l.name, `EBENE_${i + 1}`), color: aciColor(l.color) }));
  const seen = new Set();
  for (const l of layers) {
    let base = l.name;
    let n = 2;
    while (seen.has(l.name)) l.name = `${base.slice(0, 28)}_${n++}`;
    seen.add(l.name);
  }
  const layerOf = (f) => (layers.find((l) => l.id === f.layerId) || layers[0] || { name: 'EBENE' }).name;
  const toXY = (ll) => wgs84ToLV95(ll[0], ll[1]);
  let out = '';
  out += pair(0, 'SECTION') + pair(2, 'HEADER') + pair(9, '$ACADVER') + pair(1, 'AC1009') + pair(9, '$INSUNITS') + pair(70, 6) + pair(0, 'ENDSEC');
  out += pair(0, 'SECTION') + pair(2, 'TABLES') + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.length + 1);
  for (const l of [{ name: 'BESCHRIFTUNG', color: 7 }, ...layers]) out += pair(0, 'LAYER') + pair(2, l.name) + pair(70, 0) + pair(62, l.color) + pair(6, 'CONTINUOUS');
  out += pair(0, 'ENDTAB') + pair(0, 'ENDSEC');
  out += pair(0, 'SECTION') + pair(2, 'ENTITIES');
  const polyline = (layer, pts, closed, lineType = 'CONTINUOUS') => {
    let s = pair(0, 'POLYLINE') + pair(8, layer) + pair(6, lineType) + pair(66, 1) + pair(70, closed ? 1 : 0);
    for (const p of pts) s += pair(0, 'VERTEX') + pair(8, layer) + pair(10, p[0].toFixed(2)) + pair(20, p[1].toFixed(2));
    return s + pair(0, 'SEQEND') + pair(8, layer);
  };
  const label = (p, str, height = 2.5) => pair(0, 'TEXT') + pair(8, 'BESCHRIFTUNG') + pair(10, p[0].toFixed(2)) + pair(20, p[1].toFixed(2)) + pair(40, height) + pair(1, text(str));
  const kindLabel = (f) => (ROAD_KINDS.find((k) => k.id === f.kind) || {}).label || f.kind;
  for (const f of doc.features) {
    const layer = layerOf(f);
    if (f.type === 'road') {
      const pts = f.nodes.map(toXY);
      out += polyline(layer, pts, false, f.status === 'remove' ? 'DASHED' : 'CONTINUOUS');
      const special = f.segments.map((s, i) => (s.level !== 'ground' ? `${LEVELS.find((l) => l.id === s.level)?.label || s.level} ${i + 1}` : null)).filter(Boolean);
      out += label(pts[0], `${f.name || kindLabel(f)} (${kindLabel(f)}, ${f.status}, B ${roadWidthMeters(f)} m${special.length ? ', ' + special.join(', ') : ''})`);
    } else if (f.type === 'zone') {
      const pts = f.nodes.map(toXY);
      out += polyline(layer, pts, true);
      out += label(pts[0], `${f.name || zoneKind(f).label} (${zoneKind(f).label})`);
    } else if (f.type === 'junction') {
      const p = toXY(f.at);
      out += pair(0, 'POINT') + pair(8, layer) + pair(10, p[0].toFixed(2)) + pair(20, p[1].toFixed(2));
      out += label([p[0] + 2, p[1] + 2], `${f.name || f.kind}${f.lines && f.lines.length ? ' ' + f.lines.join(' ') : ''}`, 2);
    } else if (f.type === 'roundabout') {
      const p = toXY(f.center);
      out += pair(0, 'CIRCLE') + pair(8, layer) + pair(10, p[0].toFixed(2)) + pair(20, p[1].toFixed(2)) + pair(40, f.radius.toFixed(2));
      out += label([p[0] + f.radius + 2, p[1]], `${f.name || 'Kreisel'} r=${f.radius} m`, 2);
    }
  }
  out += pair(0, 'ENDSEC') + pair(0, 'EOF');
  return out;
}

export function layerNameFor(doc, f) {
  return dxfLayerName((getLayer(doc, f.layerId) || {}).name);
}
