// Geschwindigkeitsmodell aus der Strassenführung: Kurvenradius, Steigung und
// Umfeld begrenzen die erwartete Geschwindigkeit; Streuungen ergeben ein
// Zeitband statt einer einzelnen Zahl. Reine Funktionen.

export const MODEL = {
  lateralAccel: 3.0, // m/s², komfortable Querbeschleunigung
  minSpeedKmh: 15,
};

/** Geschwindigkeit, die ein Kurvenradius (Meter) zulässt, in km/h. */
export function curveSpeedKmh(radiusM) {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return Infinity;
  return Math.max(MODEL.minSpeedKmh, Math.sqrt(MODEL.lateralAccel * radiusM) * 3.6);
}

/** Faktor auf die Geschwindigkeit je Steigung in Prozent (positiv = bergauf). */
export function gradeSpeedFactor(gradePercent) {
  if (!Number.isFinite(gradePercent)) return 1;
  const g = Math.abs(gradePercent);
  if (g <= 4) return 1;
  if (gradePercent > 0) return Math.max(0.5, 1 - 0.04 * (g - 4));
  return Math.max(0.7, 1 - 0.02 * (g - 4));
}

/** Variationskoeffizient der freien Fahrgeschwindigkeit je Tempo-Niveau. */
export function covForSpeed(speedKmh) {
  if (speedKmh <= 30) return 0.22;
  if (speedKmh <= 60) return 0.18;
  if (speedKmh <= 90) return 0.14;
  return 0.1;
}

/** Erwartete Geschwindigkeit eines Abschnitts. */
export function expectedSpeedKmh({ limitKmh, radiusStart = Infinity, radiusEnd = Infinity, gradePercent = 0 }) {
  if (!(limitKmh > 0)) return 0;
  const curve = curveSpeedKmh(Math.min(radiusStart, radiusEnd));
  const v = Math.min(limitKmh, curve) * gradeSpeedFactor(gradePercent);
  return Math.max(MODEL.minSpeedKmh, Math.min(limitKmh, v));
}

/** Zeit eines Abschnitts als Erwartungswert und Varianz (Sekunden, Sekunden²). */
export function segmentTime(lengthM, speedKmh) {
  const mean = lengthM / (speedKmh / 3.6);
  const sd = covForSpeed(speedKmh) * mean;
  return { mean, variance: sd * sd };
}

/** Wartezeiten an Knoten (Sekunden): Erwartungswert und Standardabweichung. */
export const NODE_DELAY = {
  plain: { mean: 0, sd: 0 },
  priority: { mean: 3, sd: 3 },
  stop: { mean: 8, sd: 5 },
  signals: { mean: 20, sd: 15 },
  crossing: { mean: 2, sd: 2 },
  busstop: { mean: 0, sd: 0 },
  roundabout: { mean: 5, sd: 4 },
};

/** Fasst Summe und Varianz zu Band (P15–P85, ±1.036 σ) zusammen. */
export function summarize(mean, variance) {
  const sd = Math.sqrt(Math.max(0, variance));
  return { mean, sd, p15: Math.max(0, mean - 1.036 * sd), p85: mean + 1.036 * sd };
}

/** Steigung je Abschnitt (Prozent) aus einem Höhenprofil [[dist, height], …] und den kumulierten Knotenabständen. */
export function segmentGrades(nodeDistances, profile) {
  if (!profile || profile.length < 2) return nodeDistances.slice(1).map(() => 0);
  const heightAt = (d) => {
    if (d <= profile[0][0]) return profile[0][1];
    for (let i = 1; i < profile.length; i++) {
      if (d <= profile[i][0]) {
        const [d0, h0] = profile[i - 1];
        const [d1, h1] = profile[i];
        return d1 === d0 ? h1 : h0 + ((d - d0) / (d1 - d0)) * (h1 - h0);
      }
    }
    return profile[profile.length - 1][1];
  };
  const grades = [];
  for (let i = 1; i < nodeDistances.length; i++) {
    const dd = nodeDistances[i] - nodeDistances[i - 1];
    grades.push(dd > 0 ? ((heightAt(nodeDistances[i]) - heightAt(nodeDistances[i - 1])) / dd) * 100 : 0);
  }
  return grades;
}
