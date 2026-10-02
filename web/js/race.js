// Fahrt-Animation („Rennen“): Fahrzeuge fahren dieselbe Strecke in Echtzeit oder im Zeitraffer ab.
// Reine Rechenhilfen ohne DOM; die Uhr und das Zeichnen liegen in app.js und draw.js.
// Die Positionen folgen der Zeitachse des Routen-Rechners (times je Pfadpunkt), nicht dem realen Verkehr.

export const RACE_SPEEDS = [1, 10, 30, 100];
export const RACE_MODES = ['both', 'current', 'proposed'];
export const RACE_GLYPHS = { car: '🚗', bus: '🚌', bike: '🚲', foot: '🚶' };
export const RACE_COLORS = { car: '#1b6ac9', bus: '#e0b400', bike: '#7b3fbf', foot: '#e07a00' };
export const RACE_LABELS = { car: 'Auto', bus: 'Bus', bike: 'Velo', foot: 'Zu Fuss' };
/** Sekunden Modellzeit, die die Spur hinter einem Fahrzeug zeigt. */
export const TRAIL_SECONDS = 90;

/**
 * Position auf dem Pfad zur Modellzeit t (Sekunden): linear zwischen den Pfadpunkten nach der Zeitachse.
 * Liefert { latlng, index, heading } (heading in Radiant, Bildschirm-Konvention folgt aus den Projektionen in draw.js).
 */
export function positionAt(path, times, t) {
  if (!path || !path.length) return null;
  if (path.length === 1 || t <= times[0]) return { latlng: path[0], index: 0, heading: headingOf(path, 0) };
  const last = path.length - 1;
  if (t >= times[last]) return { latlng: path[last], index: last, heading: headingOf(path, last - 1) };
  // Binäre Suche nach dem Abschnitt, in dem t liegt
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const f = span > 0 ? (t - times[lo]) / span : 1;
  const a = path[lo];
  const b = path[hi];
  return { latlng: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], index: lo, heading: headingOf(path, lo) };
}

function headingOf(path, i) {
  const a = path[Math.max(0, Math.min(i, path.length - 1))];
  const b = path[Math.max(0, Math.min(i + 1, path.length - 1))];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** Pfadpunkte der letzten `seconds` Sekunden vor t (Spur), inklusive interpolierter Enden. */
export function trailAt(path, times, t, seconds = TRAIL_SECONDS) {
  if (!path || path.length < 2) return [];
  const t0 = Math.max(times[0], t - seconds);
  const t1 = Math.min(times[times.length - 1], t);
  if (t1 <= t0) return [];
  const start = positionAt(path, times, t0);
  const end = positionAt(path, times, t1);
  const pts = [start.latlng];
  for (let i = start.index + 1; i <= end.index; i++) pts.push(path[i]);
  pts.push(end.latlng);
  return pts;
}

/**
 * Teilnehmer aus Routen-Ergebnissen: results = { car: { current, proposed }, … } (computeRace)
 * oder für eine Buslinie { bus: { current, proposed } }. mode: 'both' | 'current' | 'proposed'.
 * Liefert [{ id, vehicle, variant, path, times, total, color, glyph, label, dist }], nur fahrbare Teilnehmer.
 */
export function buildRunners(results, { mode = 'both', vehicles = Object.keys(results || {}) } = {}) {
  const variants = mode === 'both' ? ['current', 'proposed'] : [mode === 'current' ? 'current' : 'proposed'];
  const out = [];
  for (const v of vehicles) {
    const res = results && results[v];
    if (!res) continue;
    for (const variant of variants) {
      const r = res[variant];
      if (!r || r.error || !r.path || !r.times || r.path.length < 2) continue;
      out.push({
        id: `${v}:${variant}`,
        vehicle: v,
        variant,
        path: r.path,
        times: r.times,
        total: r.times[r.times.length - 1],
        dist: r.dist,
        color: RACE_COLORS[v] || '#333',
        glyph: RACE_GLYPHS[v] || '•',
        label: RACE_LABELS[v] || v,
      });
    }
  }
  return out;
}

/** Gesamtdauer eines Rennens: die langsamste Fahrt (Sekunden); 0 ohne Teilnehmer. */
export function raceDuration(runners) {
  return runners.reduce((m, r) => Math.max(m, r.total), 0);
}

/**
 * Momentaufnahme zur Modellzeit t: je Teilnehmer Position, Fortschritt (0–1), fertig, Rang nach Ankunft.
 * Nicht fertige Teilnehmer bekommen keinen Rang (null).
 */
export function raceSnapshot(runners, t) {
  const order = runners.map((r, i) => ({ i, total: r.total })).sort((a, b) => a.total - b.total || a.i - b.i);
  const rank = new Map();
  order.forEach((o, k) => rank.set(o.i, k + 1));
  return runners.map((r, i) => {
    const finished = t >= r.total;
    const pos = positionAt(r.path, r.times, t);
    return {
      ...r,
      position: pos ? pos.latlng : null,
      heading: pos ? pos.heading : 0,
      progress: r.total > 0 ? Math.min(1, Math.max(0, t / r.total)) : 1,
      finished,
      rank: finished ? rank.get(i) : null,
      trail: trailAt(r.path, r.times, t),
    };
  });
}

/** Zeitraffer-Faktor passend zur Dauer: so, dass das Rennen etwa 30–60 s dauert; aus RACE_SPEEDS. */
export function suggestedSpeed(durationSeconds) {
  if (!(durationSeconds > 0)) return 10;
  let best = RACE_SPEEDS[0];
  for (const sp of RACE_SPEEDS) {
    best = sp;
    if (durationSeconds / sp <= 60) break;
  }
  return best;
}

/** Uhrzeit-Anzeige der Modellzeit: m:ss, ab einer Stunde h:mm:ss. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}
