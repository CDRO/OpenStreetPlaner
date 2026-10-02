// Web Worker: rechnet Routen, Paare, Erreichbarkeit und Buslinien abseits des Hauptfadens.
// Nachricht { id, job: { osmWays, doc, model } } -> { id, result } oder { id, error }.
// Mit kind: 'race' rechnet er die Strecke je Verkehrsmittel für die Fahrt-Animation.
import { computeAll, computeRace } from './routing.js';

self.onmessage = (e) => {
  const { id, job, kind } = e.data || {};
  try {
    self.postMessage({ id, kind, result: kind === 'race' ? computeRace(job) : computeAll(job) });
  } catch (err) {
    self.postMessage({ id, kind, error: err && err.message ? err.message : String(err) });
  }
};
