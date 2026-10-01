// Grobe Kostenschätzung eines Entwurfs: Einheitskosten je Strassentyp (pro km,
// skaliert mit der Breite), Zuschläge für Brücke und Tunnel (pro m), Pauschalen
// für Kreisel, Kreuzungen und Flächen. Reine Funktionen, in Node testbar.
// Die Werte sind Richtgrössen für Schweizer Verhältnisse und im Entwurf anpassbar.

import { COST_KEYS, getLayer, roadKind, roadWidthMeters, zoneKind } from './model.js';
import { mercatorScale, pathLength, project } from './geometry.js';

/** Einheitskosten: key, Beschriftung, Einheit, Standardwert in CHF. */
export const COST_ITEMS = [
  { key: 'road.motorway', label: 'Autobahn', unit: 'CHF/km', value: 25e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.trunk', label: 'Autostrasse', unit: 'CHF/km', value: 12e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.main', label: 'Hauptstrasse', unit: 'CHF/km', value: 3e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.secondary', label: 'Nebenstrasse', unit: 'CHF/km', value: 2e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.residential', label: 'Quartierstrasse', unit: 'CHF/km', value: 1.2e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.service', label: 'Zufahrt / Erschliessung', unit: 'CHF/km', value: 0.6e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.path', label: 'Fuss- / Veloweg', unit: 'CHF/km', value: 0.3e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'road.other', label: 'Sonstiges', unit: 'CHF/km', value: 1.5e6, group: 'Strassen (neu, pro km; skaliert mit der Breite)' },
  { key: 'bridge', label: 'Brücke (Zuschlag je Meter)', unit: 'CHF/m', value: 60000, group: 'Kunstbauten und Rückbau' },
  { key: 'tunnel', label: 'Tunnel (Zuschlag je Meter)', unit: 'CHF/m', value: 120000, group: 'Kunstbauten und Rückbau' },
  { key: 'remove', label: 'Rückbau', unit: 'CHF/km', value: 300000, group: 'Kunstbauten und Rückbau' },
  { key: 'roundabout', label: 'Kreisel', unit: 'CHF', value: 1.5e6, group: 'Knoten' },
  { key: 'junction.signals', label: 'Ampelanlage', unit: 'CHF', value: 400000, group: 'Knoten' },
  { key: 'junction.interchange', label: 'Anschluss (kreuzungsfrei)', unit: 'CHF', value: 15e6, group: 'Knoten' },
  { key: 'junction.crossing', label: 'Fussgängerstreifen', unit: 'CHF', value: 30000, group: 'Knoten' },
  { key: 'junction.busstop', label: 'Bushaltestelle', unit: 'CHF', value: 150000, group: 'Knoten' },
  { key: 'junction.plain', label: 'Kreuzung, Vortritt, Stop (Signalisation)', unit: 'CHF', value: 20000, group: 'Knoten' },
  { key: 'zone.tempo30', label: 'Tempo-30-Zone', unit: 'CHF', value: 80000, group: 'Flächen' },
  { key: 'zone.tempo20', label: 'Begegnungszone', unit: 'CHF', value: 150000, group: 'Flächen' },
  { key: 'zone.pedestrian', label: 'Fussgängerzone', unit: 'CHF', value: 300000, group: 'Flächen' },
  { key: 'zone.parking', label: 'Parkplatz (je m²)', unit: 'CHF/m²', value: 150, group: 'Flächen' },
];

const ITEM_BY_KEY = Object.fromEntries(COST_ITEMS.map((c) => [c.key, c]));
if (COST_ITEMS.some((c) => !COST_KEYS.includes(c.key))) throw new Error('COST_ITEMS und COST_KEYS passen nicht zusammen');

/** Wirksamer Einheitspreis: Wert im Entwurf, sonst Standard. */
export function costValue(doc, key) {
  const over = doc && doc.costs && Number.isFinite(doc.costs[key]) ? doc.costs[key] : null;
  return over !== null ? over : ITEM_BY_KEY[key].value;
}

/** Fläche eines Rings in m² (Web-Mercator, massstabskorrigiert). */
export function ringAreaM2(nodes) {
  if (!nodes || nodes.length < 3) return 0;
  const lat = nodes.reduce((s, n) => s + n[0], 0) / nodes.length;
  const scale = mercatorScale(lat);
  let a = 0;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
    const p = project(nodes[i]);
    const q = project(nodes[j]);
    a += (q.x + p.x) * (q.y - p.y);
  }
  return Math.abs(a / 2) / (scale * scale);
}

/** Zahl als Franken: „1.2 Mio. CHF“, „450’000 CHF“. */
export function formatChf(n) {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs >= 1e8 ? 0 : 1)} Mio. CHF`;
  const rounded = abs >= 1000 ? Math.round(abs / 1000) * 1000 : Math.round(abs);
  return `${sign}${String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, '’')} CHF`;
}

/**
 * Schätzt die Kosten. Liefert { rows, layers, total }:
 * rows = [{ featureId, layerId, label, detail, amount }], layers = [{ layerId, name, visible, amount }],
 * total = Summe der sichtbaren Ebenen (Varianten per Ein-/Ausblenden).
 */
export function estimateCosts(doc) {
  const rows = [];
  const v = (key) => costValue(doc, key);
  for (const f of doc.features) {
    let amount = 0;
    const detail = [];
    let label = f.name || '';
    if (f.type === 'road') {
      const kind = roadKind(f);
      const len = pathLength(f.nodes);
      label = f.name || kind.label;
      if (f.status === 'remove') {
        amount = (len / 1000) * v('remove');
        detail.push(`Rückbau ${Math.round(len)} m`);
      } else if (f.status === 'existing') {
        detail.push('bestehend, nicht gerechnet');
      } else {
        const widthFactor = roadWidthMeters(f) / kind.widthM;
        const base = (len / 1000) * v(`road.${kind.id}`) * widthFactor;
        amount += base;
        detail.push(`${Math.round(len)} m ${kind.label}${Math.abs(widthFactor - 1) > 0.05 ? ` × ${widthFactor.toFixed(2)} Breite` : ''}`);
        let bridge = 0;
        let tunnel = 0;
        f.segments.forEach((s, i) => {
          const d = i + 1 < f.nodes.length ? segLen(f.nodes[i], f.nodes[i + 1]) : 0;
          if (s.level === 'bridge') bridge += d;
          if (s.level === 'tunnel') tunnel += d;
        });
        if (bridge > 0) {
          amount += bridge * v('bridge');
          detail.push(`Brücke ${Math.round(bridge)} m`);
        }
        if (tunnel > 0) {
          amount += tunnel * v('tunnel');
          detail.push(`Tunnel ${Math.round(tunnel)} m`);
        }
      }
    } else if (f.type === 'roundabout') {
      label = f.name || 'Kreisel';
      amount = v('roundabout');
    } else if (f.type === 'junction') {
      const key = { signals: 'junction.signals', interchange: 'junction.interchange', crossing: 'junction.crossing', busstop: 'junction.busstop' }[f.kind] || 'junction.plain';
      label = f.name || ITEM_BY_KEY[key].label;
      amount = v(key);
    } else if (f.type === 'zone') {
      const k = zoneKind(f);
      label = f.name || k.label;
      if (f.kind === 'parking') {
        const area = ringAreaM2(f.nodes);
        amount = area * v('zone.parking');
        detail.push(`${Math.round(area)} m²`);
      } else if (ITEM_BY_KEY[`zone.${f.kind}`]) {
        amount = v(`zone.${f.kind}`);
      } else {
        detail.push('ohne Ansatz');
      }
    }
    rows.push({ featureId: f.id, layerId: f.layerId, type: f.type, label, detail: detail.join(', '), amount: Math.round(amount) });
  }
  const layers = doc.layers.map((l) => ({
    layerId: l.id,
    name: l.name,
    visible: l.visible !== false,
    amount: rows.filter((r) => r.layerId === l.id).reduce((s, r) => s + r.amount, 0),
  }));
  const total = layers.filter((l) => l.visible).reduce((s, l) => s + l.amount, 0);
  return { rows, layers, total };
}

function segLen(a, b) {
  return pathLength([a, b]);
}

/** Name einer Ebene (für Berichte). */
export function layerName(doc, id) {
  const l = getLayer(doc, id);
  return l ? l.name : '';
}
