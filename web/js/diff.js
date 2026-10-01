// Vergleich zweier Entwurfsstände (Versionen): hinzugefügte, entfernte und
// geänderte Elemente samt Beschreibung der Änderung. Reine Funktionen.

import { featureLabel } from './model.js';
import { t } from './i18n.js';

/** JSON mit sortierten Schlüsseln, damit die Reihenfolge keinen Unterschied vortäuscht. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

const FIELD_LABELS = {
  name: 'Name', kind: 'Typ', status: 'Status', oneway: 'Einbahn', maxspeed: 'Tempolimit', width: 'Breite', section: 'Querschnitt',
  layerId: 'Ebene', note: 'Notiz', radius: 'Radius', turns: 'Abbiegeregeln', profile: 'Höhenprofil', parcels: 'Parzellen',
};

/** Beschreibt, was sich an einem Element geändert hat (Liste kurzer Texte). */
export function describeChange(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === 'id' || k === 'type') continue;
    const a = before[k];
    const b = after[k];
    if (canonical(a) === canonical(b)) continue;
    if (k === 'nodes' || k === 'at' || k === 'center') {
      const na = Array.isArray(a) ? a.length : 1;
      const nb = Array.isArray(b) ? b.length : 1;
      out.push(na !== nb ? t('Geometrie ({a} → {b} Punkte)', { a: na, b: nb }) : t('Geometrie verschoben'));
    } else if (k === 'segments') {
      const la = (a || []).map((s) => s.level).join(',');
      const lb = (b || []).map((s) => s.level).join(',');
      const ma = (a || []).map((s) => s.maxspeed ?? '').join(',');
      const mb = (b || []).map((s) => s.maxspeed ?? '').join(',');
      if (la !== lb) out.push(t('Führung der Abschnitte'));
      if (ma !== mb) out.push(t('Abschnitts-Tempolimit'));
      if (la === lb && ma === mb) out.push(t('Abschnitte'));
    } else {
      const label = t(FIELD_LABELS[k] || k);
      const show = (v) => (v === null || v === undefined || v === '' ? '–' : typeof v === 'object' ? '…' : String(v));
      out.push(`${label}: ${show(a)} → ${show(b)}`);
    }
  }
  return out;
}

/**
 * Vergleicht zwei Entwürfe. Liefert { added, removed, changed: [{ before, after, changes }], layers, counts }.
 * Ebenen werden nach ID verglichen (umbenannt, hinzugefügt, entfernt, Sichtbarkeit zählt nicht).
 */
export function diffDocuments(a, b) {
  const byId = (doc) => new Map((doc.features || []).map((f) => [f.id, f]));
  const A = byId(a);
  const B = byId(b);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, f] of B) {
    const prev = A.get(id);
    if (!prev) added.push(f);
    else if (canonical(prev) !== canonical(f)) changed.push({ before: prev, after: f, changes: describeChange(prev, f) });
  }
  for (const [id, f] of A) if (!B.has(id)) removed.push(f);
  const layers = { added: [], removed: [], renamed: [] };
  const LA = new Map((a.layers || []).map((l) => [l.id, l]));
  const LB = new Map((b.layers || []).map((l) => [l.id, l]));
  for (const [id, l] of LB) {
    if (!LA.has(id)) layers.added.push(l);
    else if (LA.get(id).name !== l.name) layers.renamed.push({ from: LA.get(id).name, to: l.name });
  }
  for (const [id, l] of LA) if (!LB.has(id)) layers.removed.push(l);
  const nameChanged = a.name !== b.name;
  return {
    added,
    removed,
    changed,
    layers,
    nameChanged,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    empty: !added.length && !removed.length && !changed.length && !layers.added.length && !layers.removed.length && !layers.renamed.length && !nameChanged,
  };
}

/** Kurzbeschreibung eines Elements für Listen. */
export function featureTitle(f) {
  const type = t({ road: 'Strasse', junction: 'Punkt', roundabout: 'Kreisel', zone: 'Fläche' }[f.type] || f.type);
  return `${type} „${t(featureLabel(f))}“`;
}
