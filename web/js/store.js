// Zustand des aktuellen Entwurfs mit Undo/Redo auf Basis von Schnappschüssen.
// Entwürfe sind klein, darum ist ein vollständiger Schnappschuss pro Änderung
// einfacher und robuster als ein Kommando-Muster.

export class Store {
  constructor(doc, { maxUndo = 100 } = {}) {
    this.doc = doc;
    this.maxUndo = maxUndo;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(this.doc, event);
  }

  /** Alles, was Undo/Redo abdeckt: Name, Ebenen, Elemente und Routenanfrage (nicht der Kartenausschnitt). */
  snapshot() {
    return JSON.stringify({ name: this.doc.name, layers: this.doc.layers, features: this.doc.features, route: this.doc.route || null });
  }

  restore(snap) {
    const s = JSON.parse(snap);
    this.doc.name = s.name;
    this.doc.layers = s.layers;
    this.doc.features = s.features;
    this.doc.route = s.route || null;
  }

  /** Führt fn(doc) aus und legt bei einer tatsächlichen Änderung einen Undo-Eintrag an. */
  commit(label, fn) {
    const before = this.snapshot();
    const result = fn(this.doc);
    const after = this.snapshot();
    if (after === before) return result;
    this.undoStack.push({ label, snap: before });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
    this.doc.updatedAt = new Date().toISOString();
    this.emit({ type: 'change', label });
    return result;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ label: entry.label, snap: this.snapshot() });
    this.restore(entry.snap);
    this.doc.updatedAt = new Date().toISOString();
    this.emit({ type: 'undo', label: entry.label });
    return entry.label;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ label: entry.label, snap: this.snapshot() });
    this.restore(entry.snap);
    this.doc.updatedAt = new Date().toISOString();
    this.emit({ type: 'redo', label: entry.label });
    return entry.label;
  }

  /** Ersetzt den Entwurf komplett (Öffnen, Import); leert die Undo-Historie. */
  load(doc) {
    this.doc = doc;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit({ type: 'load' });
  }

  /** Metadaten (Name, Kartenausschnitt) ohne Undo-Eintrag anpassen. */
  setMeta(patch) {
    Object.assign(this.doc, patch);
    this.emit({ type: 'meta' });
  }
}
