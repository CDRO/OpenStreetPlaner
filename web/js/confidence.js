// Zuversicht: drei Stufen (hoch / mittel / tief) mit nachvollziehbaren Gründen.
// Keine Statistik, sondern Transparenz: wie viel eines Ergebnisses beruht auf Annahmen statt auf Daten.
import { t } from './i18n.js';
import { BUS_DWELL_DEFAULT } from './model.js';
import { pathLength } from './geometry.js';

export const CONFIDENCE_LEVELS = [
  { id: 'high', label: 'Zuversicht hoch', rank: 0 },
  { id: 'medium', label: 'Zuversicht mittel', rank: 1 },
  { id: 'low', label: 'Zuversicht tief', rank: 2 },
];

const RANK = { high: 0, medium: 1, low: 2 };
const lower = (a, b) => (RANK[b] > RANK[a] ? b : a);
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

export function confidenceLabel(level) {
  const l = CONFIDENCE_LEVELS.find((x) => x.id === level) || CONFIDENCE_LEVELS[2];
  return t(l.label);
}

/** Gemeinsame Qualität mehrerer Routenergebnisse (heute + neu, Teilstrecken): Distanzen addiert. */
export function mergeQuality(results) {
  const q = { dist: 0, assumedDist: 0, draftDist: 0, noProfileDist: 0, model: null, vehicle: null };
  for (const r of results) {
    if (!r || !r.quality) continue;
    if (!q.vehicle && r.quality.vehicle) q.vehicle = r.quality.vehicle;
    q.dist += r.quality.dist || 0;
    q.assumedDist += r.quality.assumedDist || 0;
    q.draftDist += r.quality.draftDist || 0;
    q.noProfileDist += r.quality.noProfileDist || 0;
    if (!q.model) q.model = r.quality.model;
  }
  return q;
}

/**
 * Fahrzeiten (Route, Paar, Buslinie, Erreichbarkeit). results: ein Ergebnis oder mehrere (heute/neu).
 * networkLoading: Strassennetz noch unvollständig. dwell: Haltezeit einer Buslinie (Standard = Annahme).
 */
export function travelTimeConfidence(results, { networkLoading = false, dwell = null, schedule = null } = {}) {
  const list = (Array.isArray(results) ? results : [results]).filter((r) => r && !r.error && r.quality);
  if (!list.length) return null;
  const q = mergeQuality(list);
  let level = 'high';
  const reasons = [];
  const assumed = pct(q.assumedDist, q.dist);
  if (assumed > 0 && q.vehicle !== 'bike' && q.vehicle !== 'foot') {
    reasons.push(t('{p} % der Strecke mit geschätztem Tempo (kein maxspeed in OSM bzw. kein Tempolimit gesetzt)', { p: assumed }));
    if (assumed > 50) level = lower(level, 'low');
    else if (assumed > 20) level = lower(level, 'medium');
  }
  if (networkLoading) {
    level = lower(level, 'low');
    reasons.push(t('Strassennetz noch nicht vollständig geladen'));
  }
  if (q.vehicle === 'bike' || q.vehicle === 'foot') {
    level = lower(level, 'medium');
    reasons.push(q.vehicle === 'bike' ? t('Velo pauschal mit 17 km/h (Wege langsamer), ohne Steigung und Wartezeiten') : t('Zu Fuss pauschal mit 4.8 km/h, Wartezeit nur an Ampeln'));
  } else if (q.model !== 'geometry') {
    level = lower(level, 'medium');
    reasons.push(t('Tempolimit-Modell: Kurven, Steigung und Wartezeiten nicht berücksichtigt'));
  } else {
    const np = pct(q.noProfileDist, q.dist);
    if (np > 0) {
      reasons.push(t('Steigung unbekannt auf {p} % der Strecke (kein Höhenprofil)', { p: np }));
      if (np > 50) level = lower(level, 'medium');
    }
  }
  const draft = pct(q.draftDist, q.dist);
  if (draft > 0) reasons.push(t('{p} % der Strecke auf gezeichneten Strassen (Geometrie des Entwurfs)', { p: draft }));
  if (dwell !== null && dwell === BUS_DWELL_DEFAULT) reasons.push(t('Haltezeit je Zwischenhalt als Standard ({s} s) angenommen', { s: BUS_DWELL_DEFAULT }));
  reasons.push(t('Ampeln und Vortritt im heutigen Netz (OSM) nicht modelliert'));
  // Fahrplan-Abgleich: eine Messung des heutigen Zustands; nahe am Fahrplan hebt die Modell-Deckelung auf
  if (schedule && schedule.seconds > 0 && schedule.model > 0) {
    const dev = Math.round(((schedule.model - schedule.seconds) / schedule.seconds) * 100);
    const abs = Math.abs(dev);
    reasons.unshift(t('Fahrplan-Abgleich: Modell heute weicht {p} % vom Fahrplan ab ({n} Fahrten)', { p: `${dev > 0 ? '+' : ''}${dev}`, n: schedule.trips || 1 }));
    if (abs <= 15) level = networkLoading ? level : (assumed > 50 ? 'medium' : 'high');
    else if (abs > 30) level = 'low';
    else level = lower(level, 'medium');
  }
  return { level, reasons };
}

/** Bestehende Buslinie aus OSM: Haltepositionen auf der Strasse sind verlässlich, Plattformen weniger, ohne Rollen kaum. */
export function transitRouteConfidence(route) {
  if (!route) return null;
  let level = 'high';
  const reasons = [];
  if (route.source === 'platform') {
    level = 'medium';
    reasons.push(t('Haltestellen aus Plattformen neben der Strasse (keine Haltepositionen in der Relation)'));
  } else if (route.source === 'plain') {
    level = 'low';
    reasons.push(t('Relation ohne Rollen: Reihenfolge und Lage der Haltestellen unsicher'));
  } else {
    reasons.push(t('Haltepositionen auf der Strasse in der Reihenfolge der Relation'));
  }
  if (!route.ref) {
    level = lower(level, 'medium');
    reasons.push(t('Ohne Liniennummer in OSM'));
  }
  if (!route.name) reasons.push(t('Ohne Namen in OSM'));
  return { level, reasons };
}

/** Kostenschätzung: Standard-Ansätze, unbekannte Breiten und Pauschalen für Brücken/Tunnel. band = ± Prozent. */
export function costConfidence(doc) {
  const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
  const roads = doc.features.filter((f) => f.type === 'road' && !hidden.has(f.layerId) && f.status !== 'remove');
  let total = 0;
  let unknownWidth = 0;
  let special = 0;
  for (const r of roads) {
    const len = pathLength(r.nodes);
    total += len;
    if (!r.section && !(r.width > 0)) unknownWidth += len;
    r.segments.forEach((s, i) => {
      if (s.level !== 'ground' && i < r.nodes.length - 1) special += pathLength([r.nodes[i], r.nodes[i + 1]]);
    });
  }
  const overrides = Object.keys(doc.costs || {}).length;
  let level = 'high';
  let band = 25;
  const reasons = [];
  if (!overrides) {
    level = lower(level, 'medium');
    band = 40;
    reasons.push(t('Alle Einheitskosten sind Standardwerte (Richtwerte für Schweizer Verhältnisse)'));
  } else {
    reasons.push(t('{n} Einheitskosten im Entwurf angepasst', { n: overrides }));
  }
  const unknown = pct(unknownWidth, total);
  if (unknown > 0) {
    reasons.push(t('Breite aus Standard je Strassentyp auf {p} % der Strassenlänge', { p: unknown }));
    if (unknown > 50) level = lower(level, 'low');
  }
  if (special > 0) {
    level = lower(level, 'medium');
    band = Math.max(band, 40);
    reasons.push(t('Brücken und Tunnel pauschal pro Meter ({n} m), ohne Bauwerksprojekt', { n: Math.round(special) }));
  }
  reasons.push(t('Keine Kostenberechnung nach SIA, nur zur Einordnung'));
  return { level, reasons, band };
}

/** Feste Einstufungen für Datenquellen und Prüfungen. */
export function staticConfidence(kind) {
  switch (kind) {
    case 'parcels':
      return { level: 'high', reasons: [t('Amtliche Vermessung (geo.admin): Lage der Parzellen verbindlich; Betroffenheit aus der gezeichneten Linie ohne Strassenbreite')] };
    case 'buildings':
      return { level: 'medium', reasons: [t('Gebäude aus OpenStreetMap: Erfassung je Region unterschiedlich vollständig; Umkreis ab der Strassenachse')] };
    case 'checks':
      return { level: 'medium', reasons: [t('Richtwerte nach VSS; Radien aus der gezeichneten Geometrie, nicht aus einem Trassierungsentwurf')] };
    default:
      return null;
  }
}

/** Einzeiler für Bericht und Tooltips. */
export function confidenceText(conf) {
  if (!conf) return '';
  const head = `${confidenceLabel(conf.level)}${conf.band ? ` (±${conf.band} %)` : ''}`;
  return conf.reasons && conf.reasons.length ? `${head}: ${conf.reasons.join('; ')}` : head;
}
