// Normen-Check: prüft einen Entwurf auf typische Mängel (Kurvenradius zum
// Tempo, Steigung, Kreiselgrösse, Fahrstreifenbreite, lose Enden, Tempo in
// Zonen). Reine Funktionen; die Grenzwerte sind Richtwerte nach VSS-Normen.

import { ROAD_KINDS, getLayer, pointInPolygon, roadKind, roadWidthMeters, segmentSpeed, validProfile, zoneKind } from './model.js';
import { polylineRadii } from './smooth.js';
import { segmentGrades } from './speedmodel.js';
import { haversine } from './geometry.js';
import { buildGraph, keyOf } from './routing.js';

/** Mindest-Kurvenradius (m) je Projektierungsgeschwindigkeit (km/h), dazwischen linear. */
export const MIN_RADIUS = [[20, 15], [30, 25], [40, 45], [50, 80], [60, 120], [70, 170], [80, 240], [100, 450], [120, 750]];

export function minRadiusFor(speedKmh) {
  if (!(speedKmh > 0)) return 0;
  if (speedKmh <= MIN_RADIUS[0][0]) return MIN_RADIUS[0][1];
  for (let i = 1; i < MIN_RADIUS.length; i++) {
    const [v1, r1] = MIN_RADIUS[i];
    if (speedKmh <= v1) {
      const [v0, r0] = MIN_RADIUS[i - 1];
      return r0 + ((speedKmh - v0) / (v1 - v0)) * (r1 - r0);
    }
  }
  return MIN_RADIUS[MIN_RADIUS.length - 1][1];
}

/** Mindestbreite eines Fahrstreifens je Strassentyp (m). */
export const MIN_LANE_WIDTH = { motorway: 3.5, trunk: 3.25, main: 2.75, secondary: 2.75, residential: 2.5, service: 2.5, path: 1.5, other: 2.5 };

export const GRADE_WARN = 12;
export const GRADE_INFO = 8;
export const ROUNDABOUT_MIN = 11;
export const ROUNDABOUT_MAX = 25;

/**
 * Prüft den Entwurf. Liefert [{ id, featureId, severity: 'warn'|'info', text, at }],
 * Warnungen zuerst. osmWays dient der Prüfung auf lose Enden.
 */
export function runChecks(doc, { osmWays = [] } = {}) {
  const out = [];
  const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
  const visible = doc.features.filter((f) => !hidden.has(f.layerId));
  const add = (featureId, severity, text, at = null) => out.push({ id: `${featureId}:${out.length}`, featureId, severity, text, at });
  const zones = visible.filter((f) => f.type === 'zone' && zoneKind(f).speed !== null);
  const roads = visible.filter((f) => f.type === 'road' && f.status !== 'remove');
  let graph = null;
  try {
    graph = buildGraph({ osmWays, doc, mode: 'proposed' });
  } catch {
    graph = null;
  }

  for (const r of roads) {
    const kind = roadKind(r);
    const n = r.nodes.length;
    // Kurvenradien gegen das Tempo
    if (n >= 3 && kind.speed > 0) {
      const radii = polylineRadii(r.nodes);
      let worst = null;
      for (let i = 1; i < n - 1; i++) {
        const speed = Math.max(segmentSpeed(r, i - 1), segmentSpeed(r, i));
        const min = minRadiusFor(speed);
        if (!(speed > 0) || radii[i] >= min) continue;
        const ratio = radii[i] / min;
        if (!worst || ratio < worst.ratio) worst = { i, radius: radii[i], min, speed, ratio };
      }
      if (worst) {
        add(r.id, worst.ratio < 0.6 ? 'warn' : 'info', `${label(r)}: Kurvenradius ${Math.round(worst.radius)} m bei Punkt ${worst.i + 1} ist zu klein für ${worst.speed} km/h (Richtwert ≥ ${Math.round(worst.min)} m). Glätten, Tempo senken oder Linienführung anpassen.`, r.nodes[worst.i]);
      }
    }
    // Steigung aus dem Höhenprofil
    const profile = validProfile(r);
    if (profile) {
      const dists = [0];
      for (let i = 1; i < n; i++) dists.push(dists[i - 1] + haversine(r.nodes[i - 1], r.nodes[i]));
      const grades = segmentGrades(dists, profile.points);
      let maxG = 0;
      let maxI = 0;
      grades.forEach((g, i) => {
        if (Math.abs(g) > Math.abs(maxG)) {
          maxG = g;
          maxI = i;
        }
      });
      if (Math.abs(maxG) > GRADE_WARN) add(r.id, 'warn', `${label(r)}: Steigung ${Math.abs(maxG).toFixed(1)} % in Abschnitt ${maxI + 1} übersteigt ${GRADE_WARN} %.`, r.nodes[maxI]);
      else if (Math.abs(maxG) > GRADE_INFO && kind.id !== 'path') add(r.id, 'info', `${label(r)}: Steigung ${Math.abs(maxG).toFixed(1)} % in Abschnitt ${maxI + 1} (über ${GRADE_INFO} %: für Lastwagen und Velos anspruchsvoll).`, r.nodes[maxI]);
    }
    // Fahrstreifen- und Gesamtbreite
    const minLane = MIN_LANE_WIDTH[kind.id] || 2.5;
    if (r.section && r.section.laneWidth < minLane) add(r.id, 'warn', `${label(r)}: Fahrstreifen ${r.section.laneWidth} m schmaler als ${minLane} m (Richtwert für ${kind.label}).`, r.nodes[0]);
    else if (!r.section && Number.isFinite(r.width) && r.width < kind.widthM * 0.7) add(r.id, 'info', `${label(r)}: Breite ${r.width} m deutlich unter dem Standard von ${kind.widthM} m für ${kind.label}.`, r.nodes[0]);
    if (kind.motorOnly && r.section && (r.section.walkLeft || r.section.walkRight || r.section.bikeLeft || r.section.bikeRight)) add(r.id, 'warn', `${label(r)}: Trottoir oder Velostreifen auf ${kind.label} (für Fussgänger und Velos gesperrt).`, r.nodes[0]);
    // Tempo in Zonen
    for (let i = 0; i < r.segments.length; i++) {
      const mid = [(r.nodes[i][0] + r.nodes[i + 1][0]) / 2, (r.nodes[i][1] + r.nodes[i + 1][1]) / 2];
      const speed = segmentSpeed(r, i);
      const z = zones.find((zone) => pointInPolygon(mid, zone.nodes));
      if (!z) continue;
      const cap = zoneKind(z).speed;
      if (cap === 0 && kind.speed > 0 && r.status === 'new') {
        add(r.id, 'info', `${label(r)}: Abschnitt ${i + 1} liegt in einer Fussgängerzone (für Autos gesperrt).`, mid);
        break;
      }
      if (cap > 0 && speed > cap) {
        add(r.id, 'warn', `${label(r)}: Tempo ${speed} in Abschnitt ${i + 1} liegt über der Zone (${z.name || zoneKind(z).label}, ${cap} km/h).`, mid);
        break;
      }
    }
    // Lose Enden: Endpunkt ohne Anschluss an eine andere Strasse
    if (graph) {
      const loose = [];
      for (const end of [r.nodes[0], r.nodes[n - 1]]) {
        const deg = graph.degree.get(keyOf(end)) || 0;
        if (deg <= 1) loose.push(end);
      }
      if (loose.length === 2) add(r.id, 'info', `${label(r)}: beide Enden sind nicht an andere Strassen angeschlossen (Einrasten beim Zeichnen oder Netz laden).`, loose[0]);
      else if (loose.length === 1) add(r.id, 'info', `${label(r)}: ein Ende ist nicht an andere Strassen angeschlossen.`, loose[0]);
    }
  }
  for (const k of visible) {
    if (k.type !== 'roundabout') continue;
    if (k.radius < ROUNDABOUT_MIN) add(k.id, 'warn', `${label(k)}: Radius ${k.radius} m ist für einen Kreisel zu klein (Richtwert Aussenradius ${ROUNDABOUT_MIN}–${ROUNDABOUT_MAX} m; Minikreisel brauchen eine überfahrbare Mitte).`, k.center);
    else if (k.radius > ROUNDABOUT_MAX) add(k.id, 'info', `${label(k)}: Radius ${k.radius} m ist ungewöhnlich gross (Richtwert ${ROUNDABOUT_MIN}–${ROUNDABOUT_MAX} m); grosse Kreisel verleiten zu hohem Tempo.`, k.center);
  }
  for (const j of visible) {
    if (j.type !== 'junction' || !graph) continue;
    const deg = graph.degree.get(keyOf(j.at)) || 0;
    if (deg === 0 && j.kind !== 'busstop' && j.kind !== 'crossing') add(j.id, 'info', `${label(j)}: liegt auf keinem Strassenknoten; Wartezeit und Abbiegeregeln wirken nur auf einem Knoten des Netzes.`, j.at);
  }
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
  return out;
}

function label(f) {
  if (f.name) return f.name;
  if (f.type === 'road') return roadKind(f).label;
  if (f.type === 'roundabout') return 'Kreisel';
  if (f.type === 'junction') return 'Kreuzung';
  return 'Element';
}

export { ROAD_KINDS, getLayer, roadWidthMeters };
