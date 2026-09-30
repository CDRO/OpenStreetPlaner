// Export der Karte als PNG oder PDF – ohne Bibliothek. Das Bild wird aus dem
// Karten-Canvas plus Titel, Legende, Massstab und OSM-Attribution zusammengesetzt;
// das PDF bettet dieses Bild als JPEG (DCTDecode) in eine A4-Seite ein.

import { LEVELS, ZONE_KINDS } from './model.js';
import { formatDuration } from './routing.js';
import { haversine } from './geometry.js';

/** Papierformate in Millimetern (Querformat). */
export const PAPER = {
  a4: { label: 'A4', w: 297, h: 210 },
  a3: { label: 'A3', w: 420, h: 297 },
};
export const DPI = [96, 150, 300];
const MARGIN_MM = 10;

/** Grösse des Exportbilds für Papier, Ausrichtung und Auflösung (CSS-Pixel und Pixelfaktor). */
export function exportSize({ paper = 'a4', orientation = 'landscape', dpi = 150 } = {}) {
  const p = PAPER[paper] || PAPER.a4;
  const wMm = (orientation === 'portrait' ? p.h : p.w) - 2 * MARGIN_MM;
  const hMm = (orientation === 'portrait' ? p.w : p.h) - 2 * MARGIN_MM;
  const pixelRatio = dpi / 96;
  const width = Math.round((wMm / 25.4) * 96);
  const height = Math.round((hMm / 25.4) * 96);
  return { width, height, pixelRatio, pageWmm: wMm + 2 * MARGIN_MM, pageHmm: hMm + 2 * MARGIN_MM };
}

/** Bereich aller sichtbaren Elemente (und der Route) des Entwurfs, oder null. */
export function documentBounds(doc) {
  const lats = [];
  const lngs = [];
  const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
  const add = (ll) => { lats.push(ll[0]); lngs.push(ll[1]); };
  for (const f of doc.features) {
    if (hidden.has(f.layerId)) continue;
    if (f.nodes) f.nodes.forEach(add);
    if (f.at) add(f.at);
    if (f.center) {
      const d = f.radius / 111320;
      add([f.center[0] - d, f.center[1] - d]);
      add([f.center[0] + d, f.center[1] + d]);
    }
  }
  if (doc.route) {
    add(doc.route.from);
    add(doc.route.to);
  }
  if (!lats.length) return null;
  const b = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
  const padLat = Math.max((b.north - b.south) * 0.08, 0.0008);
  const padLng = Math.max((b.east - b.west) * 0.08, 0.0012);
  return { south: b.south - padLat, north: b.north + padLat, west: b.west - padLng, east: b.east + padLng };
}

/**
 * Rendert die Karte offscreen in Druckqualität und setzt das Exportbild zusammen.
 * opts: { mode: 'view'|'all', paper, orientation, dpi, routes, link }
 */
export async function renderExport(map, doc, opts = {}) {
  const size = exportSize(opts);
  const headerCss = 70;
  const legendRows = 1 + (opts.routes && (opts.routes.current || opts.routes.proposed) ? 1 : 0);
  const footerCss = 16 + 30 * legendRows + 8;
  const mapCss = { width: size.width, height: Math.max(200, size.height - headerCss - footerCss) };
  let view;
  if (opts.mode === 'all') {
    const b = documentBounds(doc);
    view = b ? map.viewForBounds(b, mapCss.width, mapCss.height, { padding: 30, maxZoom: 19 }) : { center: map.getCenter(), zoom: map.getZoom() };
  } else {
    view = { center: map.getCenter(), zoom: map.getZoom() };
  }
  const full = { ...view, width: mapCss.width, height: mapCss.height, pixelRatio: size.pixelRatio };
  await map.prefetchTiles(full);
  const rendered = map.renderOffscreen(full);
  const mpp = map.withView(full, () => map.metersPerPixel());
  return { canvas: composeExport(rendered, { dpr: size.pixelRatio, mpp, doc, routes: opts.routes, link: opts.link }), size };
}

/** Baut das Exportbild aus einer gerenderten Karte. Liefert ein Canvas in Gerätepixeln. */
export function composeExport(src, { dpr = 1, mpp = 1, doc, routes = null, link = '' }) {
  const W = src.width;
  const mapH = src.height;
  const header = Math.round(70 * dpr);
  const legendRows = 1 + (routes && (routes.current || routes.proposed) ? 1 : 0);
  const footer = Math.round((16 + 30 * legendRows + 8) * dpr);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = header + mapH + footer;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  // Kopf
  const pad = 16 * dpr;
  ctx.fillStyle = '#1f2933';
  ctx.font = `700 ${22 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(doc.name, pad, 30 * dpr);
  ctx.fillStyle = '#6b7480';
  ctx.font = `${12 * dpr}px system-ui, sans-serif`;
  const date = new Date().toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
  ctx.fillText(`Stadtplaner · ${date}${link ? ` · ${link}` : ''}`, pad, 52 * dpr);

  // Karte
  ctx.drawImage(src, 0, header);
  ctx.strokeStyle = '#d9dde3';
  ctx.lineWidth = dpr;
  ctx.strokeRect(0.5, header + 0.5, W - 1, mapH - 1);

  // Attribution und Massstab auf der Karte
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  const attr = '© OpenStreetMap-Mitwirkende';
  const aw = ctx.measureText(attr).width + 12 * dpr;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(W - aw, header + mapH - 18 * dpr, aw, 18 * dpr);
  ctx.fillStyle = '#333';
  ctx.fillText(attr, W - aw + 6 * dpr, header + mapH - 5 * dpr);
  drawScaleBar(ctx, mpp, dpr, pad, header + mapH - 12 * dpr);

  // Legende
  let y = header + mapH + 26 * dpr;
  let x = pad;
  const item = (label, drawSample) => {
    const w = ctx.measureText(label).width;
    if (x + 44 * dpr + w > W - pad) {
      x = pad;
      y += 22 * dpr;
    }
    drawSample(x, y - 4 * dpr);
    ctx.fillStyle = '#1f2933';
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.fillText(label, x + 40 * dpr, y);
    x += 40 * dpr + w + 22 * dpr;
  };
  const line = (color, width, dash = [], casing = null) => (sx, sy) => {
    ctx.save();
    if (casing) {
      ctx.strokeStyle = casing;
      ctx.lineWidth = (width + 5) * dpr;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 32 * dpr, sy);
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = (width + 2) * dpr;
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.setLineDash(dash.map((d) => d * dpr));
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 32 * dpr, sy);
    ctx.stroke();
    ctx.restore();
  };
  for (const l of doc.layers) {
    if (l.visible === false) continue;
    item(l.name, line(l.color, 4));
  }
  item(LEVELS[1].label, line('#d7263d', 4, [], '#1a1a1a'));
  item(LEVELS[2].label, line('rgba(215,38,61,0.55)', 4, [8, 6]));
  item('Rückbau', line('#c62828', 4, [5, 5]));
  const zoneKinds = new Set(doc.features.filter((f) => f.type === 'zone').map((f) => f.kind));
  for (const k of ZONE_KINDS) {
    if (!zoneKinds.has(k.id)) continue;
    const color = k.color || '#d7263d';
    item(k.label, (sx, sy) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(sx, sy - 6 * dpr, 32 * dpr, 12 * dpr);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeRect(sx, sy - 6 * dpr, 32 * dpr, 12 * dpr);
      ctx.restore();
    });
  }
  if (routes && (routes.current || routes.proposed)) {
    y += 30 * dpr;
    x = pad;
    const cur = routes.current && !routes.current.error ? routes.current : null;
    const neu = routes.proposed && !routes.proposed.error ? routes.proposed : null;
    item(cur ? `Route heute: ${(cur.dist / 1000).toFixed(2)} km, ${formatDuration(cur.time)}` : 'Route heute: keine Verbindung', line('#1b6ac9', 5));
    item(neu ? `Route neu: ${(neu.dist / 1000).toFixed(2)} km, ${formatDuration(neu.time)}` : 'Route neu: keine Verbindung', line('#2a9d3f', 5));
  }
  return out;
}

function drawScaleBar(ctx, mpp, dpr, x, y) {
  const maxMeters = 120 * mpp;
  const pow = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  let nice = pow;
  for (const m of [5, 2, 1]) {
    if (pow * m <= maxMeters) {
      nice = pow * m;
      break;
    }
  }
  const px = (nice / mpp) * dpr;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 4 * dpr, y - 16 * dpr, px + 60 * dpr, 22 * dpr);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, y - 8 * dpr);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 8 * dpr);
  ctx.stroke();
  ctx.fillStyle = '#222';
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + px + 6 * dpr, y);
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, quality);
  });
}

const A4 = { w: 841.89, h: 595.28 };
const PT_PER_MM = 72 / 25.4;

// Helvetica-Zeichenbreiten (1/1000 em) für den Zeilenumbruch; Umlaute wie ihre Grundbuchstaben.
const HELVETICA = { ' ': 278, '!': 278, '"': 355, '#': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '=': 584, '?': 556, '@': 1015, '[': 278, ']': 278, '_': 556, '`': 333, '{': 334, '|': 260, '}': 334, '~': 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 };
const CP1252 = { '€': 0x80, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '«': 0xab, '»': 0xbb, '°': 0xb0, '²': 0xb2, '³': 0xb3, '×': 0xd7, '÷': 0xf7, '·': 0xb7 };

export function textWidth(text, sizePt) {
  let w = 0;
  for (const ch of text) {
    const base = ch.normalize('NFD')[0];
    w += HELVETICA[ch] ?? HELVETICA[base] ?? (/\d/.test(ch) ? 556 : 556);
  }
  return (w / 1000) * sizePt;
}

/** Bricht Text in Zeilen um, die in maxWidth Punkt passen. */
export function wrapText(text, sizePt, maxWidth) {
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, sizePt) <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Text als PDF-String in WinAnsi (cp1252); unbekannte Zeichen werden zu '?'. */
export function pdfWinAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    let code = ch.codePointAt(0);
    if (code > 0xff) {
      code = CP1252[ch] ?? 0x3f;
    } else if (code >= 0x80 && code <= 0x9f) {
      code = 0x3f;
    }
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\' + String.fromCharCode(code);
    else if (code < 0x20) out += ' ';
    else out += String.fromCharCode(code);
  }
  return out;
}

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Baut ein mehrseitiges PDF. pages: [{ image: { jpeg, width, height } } | { blocks: [{ text, size?, bold?, gap? }] }].
 * Seitengrösse in Millimetern; Text in Helvetica (Standardschrift, keine Einbettung nötig).
 */
export function buildPdf({ pages, pageWmm, pageHmm, title = 'Stadtplaner' }) {
  const pageW = pageWmm * PT_PER_MM;
  const pageH = pageHmm * PT_PER_MM;
  const margin = MARGIN_MM * PT_PER_MM;
  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const push = (bytes) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const pushStr = (s) => push(enc.encode(s));
  const offsets = [];
  let nextId = 1;
  const alloc = () => nextId++;
  const writeObj = (n, body) => {
    offsets[n] = offset;
    pushStr(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const writeStream = (n, dict, bytes) => {
    offsets[n] = offset;
    pushStr(`${n} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    pushStr('\nendstream\nendobj\n');
  };
  pushStr('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  const fontBoldId = alloc();
  const infoId = alloc();
  const pageIds = [];
  const pending = []; // [id, body] oder [id, dict, bytes]
  for (const page of pages) {
    const pageId = alloc();
    const contentId = alloc();
    pageIds.push(pageId);
    if (page.image) {
      const imgId = alloc();
      const { jpeg, width, height } = page.image;
      const scale = Math.min((pageW - 2 * margin) / width, (pageH - 2 * margin) / height);
      const iw = width * scale;
      const ih = height * scale;
      const content = enc.encode(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${((pageW - iw) / 2).toFixed(2)} ${((pageH - ih) / 2).toFixed(2)} cm /Im${imgId} Do Q\n`);
      pending.push({ id: pageId, body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << /Im${imgId} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>` });
      pending.push({ id: imgId, dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, bytes: jpeg });
      pending.push({ id: contentId, dict: '', bytes: content });
    } else {
      let y = pageH - margin;
      let text = '';
      for (const block of page.blocks || []) {
        const size = block.size || 10.5;
        const font = block.bold ? 'F2' : 'F1';
        const lines = wrapText(block.text, size, pageW - 2 * margin);
        for (const line of lines) {
          y -= size * 1.35;
          if (y < margin) break;
          text += `BT /${font} ${size} Tf 1 0 0 1 ${margin.toFixed(2)} ${y.toFixed(2)} Tm (${pdfWinAnsi(line)}) Tj ET\n`;
        }
        y -= block.gap ?? size * 0.5;
      }
      pending.push({ id: pageId, body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>` });
      pending.push({ id: contentId, dict: '', bytes: latin1Bytes(text) });
    }
  }
  writeObj(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  writeObj(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  writeObj(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  writeObj(fontBoldId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `D:${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
  writeObj(infoId, `<< /Title ${pdfTextString(title)} /Producer (Stadtplaner) /Creator (Stadtplaner) /CreationDate (${date}) >>`);
  for (const p of pending) {
    if (p.bytes) writeStream(p.id, p.dict, p.bytes);
    else writeObj(p.id, p.body);
  }
  const total = nextId;
  const xref = offset;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  table += `trailer\n<< /Size ${total} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  pushStr(table);
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Einseitiges PDF mit einem JPEG (Rückwärtskompatibilität, Tests). */
export function pdfFromJpeg(jpeg, widthPx, heightPx, { title = 'Stadtplaner', pageWmm = null, pageHmm = null } = {}) {
  const landscape = widthPx >= heightPx;
  const wmm = pageWmm || (landscape ? A4.w : A4.h) / PT_PER_MM;
  const hmm = pageHmm || (landscape ? A4.h : A4.w) / PT_PER_MM;
  return buildPdf({ pages: [{ image: { jpeg, width: widthPx, height: heightPx } }], pageWmm: wmm, pageHmm: hmm, title });
}

/** Text als UTF-16BE-Hex-String mit BOM (Umlaute im PDF-Info-Dictionary). */
function pdfTextString(s) {
  let hex = 'FEFF';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

const ROAD_KINDS_LABELS = [
  { id: 'motorway', label: 'Autobahn' }, { id: 'trunk', label: 'Autostrasse' }, { id: 'main', label: 'Hauptstrasse' }, { id: 'secondary', label: 'Nebenstrasse' },
  { id: 'residential', label: 'Quartierstrasse' }, { id: 'service', label: 'Zufahrt' }, { id: 'path', label: 'Fuss-/Veloweg' }, { id: 'other', label: 'Sonstiges' },
];
const STATUS_LABELS = { new: 'neu', existing: 'bestehend', remove: 'Rückbau' };
const JUNCTION_LABELS = [
  { id: 'plain', label: 'Kreuzung' }, { id: 'signals', label: 'Ampel' }, { id: 'priority', label: 'Vortritt' }, { id: 'stop', label: 'Stop' },
  { id: 'crossing', label: 'Fussgängerstreifen' }, { id: 'busstop', label: 'Bushaltestelle' }, { id: 'interchange', label: 'Anschluss' },
];

/** Textseiten des Berichts: Massnahmen, Routenvergleich, Kommentare. */
export function reportBlocks(doc, { routes = null, comments = [], link = '' } = {}) {
  const blocks = [];
  const date = new Date().toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
  blocks.push({ text: doc.name, size: 18, bold: true });
  blocks.push({ text: `Planungsvorschlag · ${date}${link ? ` · ${link}` : ''}`, size: 9.5, gap: 10 });
  const layerName = (id) => (doc.layers.find((l) => l.id === id) || {}).name || '';
  const kindLabel = (list, id) => (list.find((k) => k.id === id) || {}).label || id;
  const roads = doc.features.filter((f) => f.type === 'road');
  const zones = doc.features.filter((f) => f.type === 'zone');
  const points = doc.features.filter((f) => f.type === 'junction' || f.type === 'roundabout');
  blocks.push({ text: 'Massnahmen', size: 13, bold: true });
  if (!roads.length && !zones.length && !points.length) blocks.push({ text: 'Keine Elemente.' });
  roads.forEach((r, i) => {
    const len = Math.round(pathLengthLL(r.nodes));
    const parts = [`${i + 1}. ${r.name || 'Strasse'} (${kindLabel(ROAD_KINDS_LABELS, r.kind)}, ${STATUS_LABELS[r.status] || r.status})`, `${len} m`];
    if (r.maxspeed) parts.push(`Tempo ${r.maxspeed}`);
    const special = r.segments.filter((s) => s.level !== 'ground').length;
    if (special) parts.push(`${special} Abschnitt(e) Brücke/Tunnel`);
    if (r.oneway) parts.push('Einbahn');
    parts.push(`Ebene ${layerName(r.layerId)}`);
    blocks.push({ text: parts.join(' · ') + (r.note ? ` – ${r.note}` : ''), gap: 2 });
  });
  zones.forEach((z) => blocks.push({ text: `Fläche: ${z.name ? z.name + ' – ' : ''}${kindLabel(ZONE_KINDS, z.kind)} (${z.nodes.length} Eckpunkte)${z.note ? ` – ${z.note}` : ''}`, gap: 2 }));
  points.forEach((p) => blocks.push({ text: p.type === 'roundabout' ? `Kreisel${p.name ? ' ' + p.name : ''}, Radius ${p.radius} m` : `${kindLabel(JUNCTION_LABELS, p.kind)}${p.name ? ' ' + p.name : ''}`, gap: 2 }));
  const cur = routes && routes.current && !routes.current.error ? routes.current : null;
  const neu = routes && routes.proposed && !routes.proposed.error ? routes.proposed : null;
  if (cur || neu) {
    blocks.push({ text: 'Routenvergleich', size: 13, bold: true, gap: 4 });
    const fmt = (r) => (r ? `${(r.dist / 1000).toFixed(2)} km, ${formatDuration(r.time)}${r.sd > 0 ? ` (P15–P85 ${formatDuration(r.p15)} – ${formatDuration(r.p85)})` : ''}` : 'keine Verbindung');
    blocks.push({ text: `Heute: ${fmt(cur)}`, gap: 2 });
    blocks.push({ text: `Neu: ${fmt(neu)}`, gap: 2 });
    if (cur && neu) blocks.push({ text: `Differenz: ${neu.dist - cur.dist >= 0 ? '+' : '−'}${(Math.abs(neu.dist - cur.dist) / 1000).toFixed(2)} km, ${neu.time - cur.time >= 0 ? '+' : '−'}${formatDuration(Math.abs(neu.time - cur.time))}` });
  }
  const tops = comments.filter((c) => !c.parentId);
  if (tops.length) {
    blocks.push({ text: `Kommentare (${tops.length})`, size: 13, bold: true, gap: 4 });
    tops.forEach((c, i) => {
      const when = new Date(c.at).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
      blocks.push({ text: `${i + 1}. ${c.author}, ${when}${c.resolved ? ' (erledigt)' : ''}: ${c.text}`, gap: 1 });
      comments.filter((r) => r.parentId === c.id).forEach((r) => blocks.push({ text: `    ↳ ${r.author}: ${r.text}`, gap: 1 }));
    });
  }
  return blocks;
}


function pathLengthLL(nodes) {
  let m = 0;
  for (let i = 1; i < nodes.length; i++) m += haversine(nodes[i - 1], nodes[i]);
  return m;
}

/** Bericht: Kartenseite plus Textseiten (automatisch auf mehrere Seiten verteilt). */
export async function exportReport(map, doc, opts = {}) {
  const { canvas, size } = await renderExport(map, doc, opts);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const pages = [{ image: { jpeg, width: canvas.width, height: canvas.height } }];
  const blocks = reportBlocks(doc, opts);
  // Textseiten füllen: grob nach Zeilenzahl aufteilen
  const pageH = size.pageHmm * PT_PER_MM - 2 * MARGIN_MM * PT_PER_MM;
  const pageW = size.pageWmm * PT_PER_MM - 2 * MARGIN_MM * PT_PER_MM;
  let current = [];
  let used = 0;
  for (const b of blocks) {
    const sizePt = b.size || 10.5;
    const h = wrapText(b.text, sizePt, pageW).length * sizePt * 1.35 + (b.gap ?? sizePt * 0.5);
    if (used + h > pageH && current.length) {
      pages.push({ blocks: current });
      current = [];
      used = 0;
    }
    current.push(b);
    used += h;
  }
  if (current.length) pages.push({ blocks: current });
  return new Blob([buildPdf({ pages, pageWmm: size.pageWmm, pageHmm: size.pageHmm, title: doc.name })], { type: 'application/pdf' });
}

export async function exportPng(map, doc, opts = {}) {
  const { canvas } = await renderExport(map, doc, opts);
  return canvasToBlob(canvas, 'image/png');
}

export async function exportPdf(map, doc, opts = {}) {
  const { canvas, size } = await renderExport(map, doc, opts);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const pdf = pdfFromJpeg(jpeg, canvas.width, canvas.height, { title: doc.name, pageWmm: size.pageWmm, pageHmm: size.pageHmm });
  return new Blob([pdf], { type: 'application/pdf' });
}
