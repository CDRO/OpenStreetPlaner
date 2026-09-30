// Export der Karte als PNG oder PDF – ohne Bibliothek. Das Bild wird aus dem
// Karten-Canvas plus Titel, Legende, Massstab und OSM-Attribution zusammengesetzt;
// das PDF bettet dieses Bild als JPEG (DCTDecode) in eine A4-Seite ein.

import { LEVELS, ZONE_KINDS } from './model.js';
import { formatDuration } from './routing.js';

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

/** Baut ein einseitiges PDF mit dem JPEG als Bild. Liefert die PDF-Bytes. */
export function pdfFromJpeg(jpeg, widthPx, heightPx, { title = 'Stadtplaner', pageWmm = null, pageHmm = null } = {}) {
  const landscape = widthPx >= heightPx;
  const pageW = pageWmm ? pageWmm * PT_PER_MM : (landscape ? A4.w : A4.h);
  const pageH = pageHmm ? pageHmm * PT_PER_MM : (landscape ? A4.h : A4.w);
  const margin = pageWmm ? MARGIN_MM * PT_PER_MM : 24;
  const scale = Math.min((pageW - 2 * margin) / widthPx, (pageH - 2 * margin) / heightPx);
  const iw = widthPx * scale;
  const ih = heightPx * scale;
  const ix = (pageW - iw) / 2;
  const iy = (pageH - ih) / 2;
  const content = `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im1 Do Q\n`;
  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const push = (bytes) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const pushStr = (s) => push(enc.encode(s));
  const offsets = [];
  const obj = (n, body) => {
    offsets[n] = offset;
    pushStr(`${n} 0 obj\n${body}\nendobj\n`);
  };
  pushStr('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = offset;
  pushStr(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  pushStr('\nendstream\nendobj\n');
  const contentBytes = enc.encode(content);
  offsets[5] = offset;
  pushStr(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  pushStr('endstream\nendobj\n');
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `D:${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
  obj(6, `<< /Title ${pdfTextString(title)} /Producer (Stadtplaner) /Creator (Stadtplaner) /CreationDate (${date}) >>`);
  const xref = offset;
  let table = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  table += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  pushStr(table);
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
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
