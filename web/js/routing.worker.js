// Web Worker: rechnet Routen, Paare, Erreichbarkeit und Buslinien abseits des Hauptfadens.
// Nachricht { id, job: { osmWays, doc, model } } -> { id, result } oder { id, error }.
import { computeAll } from './routing.js';

self.onmessage = (e) => {
  const { id, job } = e.data || {};
  try {
    self.postMessage({ id, result: computeAll(job) });
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
