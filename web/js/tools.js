// Werkzeuge: Auswählen/Bearbeiten, Strasse, Kreuzung, Kreisel, OSM übernehmen.
// Arbeitet auf den Ereignissen der SlippyMap und hält Zeichen-/Einrastzustand,
// den draw.js auf das Canvas bringt.

import {
  applySnapSplits, createJunction, createRoad, createRoundabout, getFeature, moveRoadNode,
  removeFeature, removeRoadNode, splitRoadSegment, roundCoord,
} from './model.js';
import { snapLatLng, excludeFeature } from './snap.js';
import { haversine } from './geometry.js';
import { roadKindFromHighway } from './osm.js';
import { hitHandle } from './draw.js';

export const TOOLS = [
  { id: 'select', label: 'Auswählen', key: 'V', hint: 'Element anklicken zum Auswählen. Griffe ziehen zum Verschieben, Rechtsklick auf einen Griff löscht den Punkt, Klick auf einen Zwischenpunkt fügt einen ein.' },
  { id: 'road', label: 'Strasse', key: 'S', hint: 'Klicken setzt Punkte. Doppelklick, Enter oder Rechtsklick beendet, Esc bricht ab, Backspace entfernt den letzten Punkt.' },
  { id: 'junction', label: 'Kreuzung', key: 'K', hint: 'Klicken platziert eine Kreuzung, am besten auf einen Strassenpunkt.' },
  { id: 'roundabout', label: 'Kreisel', key: 'R', hint: 'Klicken setzt das Zentrum, Maus bewegen wählt den Radius, erneut klicken bestätigt.' },
  { id: 'adopt', label: 'OSM übernehmen', key: 'O', hint: 'Bestehende OSM-Strasse anklicken, um sie als bearbeitbare Strasse in die aktive Ebene zu kopieren (ab Zoom 16).' },
];

const MODIFIER_PROP = { Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey' };
const PICK_TOLERANCE = 9;

export class ToolController {
  constructor(opts) {
    Object.assign(this, opts); // map, store, getSnapIndex, getPickIndex, getSettings, getActiveLayerId,
    // getDefaultRoadKind, getOsmWay, canEdit, onSelectionChange, onToolChange, onStatus, onSceneChange, toast
    this.tool = 'select';
    this.selection = null; // { featureId, segIndex }
    this.hover = null;
    this.draft = null; // laufende Zeichnung
    this.drag = null; // Griff-Verschiebung
    this.preview = null;
    this.snapPoint = null;
    this.modifiers = { Shift: false, Control: false, Alt: false };

    const map = this.map;
    map.on('click', (e) => this.onClick(e));
    map.on('dblclick', (e) => this.onDblClick(e));
    map.on('pointermove', (e) => this.onPointerMove(e));
    map.on('pointerdown', (e) => this.onPointerDown(e));
    map.on('pointerup', (e) => this.onPointerUp(e));
    map.on('pointerleave', () => this.setSnap(null));
    map.on('contextmenu', (e) => this.onContextMenu(e));
    window.addEventListener('keydown', (e) => this.trackModifier(e, true));
    window.addEventListener('keyup', (e) => this.trackModifier(e, false));
    window.addEventListener('blur', () => { this.modifiers = { Shift: false, Control: false, Alt: false }; });
    this.applyCursor();
  }

  trackModifier(e, down) {
    if (e.key in this.modifiers) this.modifiers[e.key] = down;
  }

  toolInfo() {
    return TOOLS.find((t) => t.id === this.tool);
  }

  setTool(id) {
    if (!TOOLS.some((t) => t.id === id)) return;
    if (id !== 'select' && !this.canEdit()) {
      this.toast('Nur Ansicht: Lege zuerst eine eigene Kopie an, um zu zeichnen.');
      return;
    }
    this.cancel();
    this.tool = id;
    if (id !== 'select') this.setSelection(null);
    this.applyCursor();
    this.onToolChange(id);
    this.onStatus(this.toolInfo().hint);
    this.onSceneChange();
  }

  applyCursor() {
    this.map.setCursor(this.tool === 'select' ? '' : 'crosshair');
  }

  setSelection(sel) {
    this.selection = sel;
    this.onSelectionChange(sel);
    this.onSceneChange();
  }

  selectedFeature() {
    return this.selection ? getFeature(this.store.doc, this.selection.featureId) : null;
  }

  setPreview(p) {
    this.preview = p;
    this.onSceneChange();
  }

  setSnap(result) {
    const next = result && result.snap ? { latlng: result.latlng, kind: result.snap.kind } : null;
    const changed = !!next !== !!this.snapPoint || (next && (next.latlng[0] !== this.snapPoint.latlng[0] || next.latlng[1] !== this.snapPoint.latlng[1]));
    this.snapPoint = next;
    if (changed) this.onSceneChange();
  }

  // --- Einrasten & Treffer ---------------------------------------------------

  snapSuppressed(e) {
    const settings = this.getSettings();
    if (!settings.snapEnabled) return true;
    const prop = MODIFIER_PROP[settings.snapModifier] || 'shiftKey';
    if (e && e.originalEvent && e.originalEvent[prop]) return true;
    return !!this.modifiers[settings.snapModifier];
  }

  snap(e, filter = null) {
    if (this.snapSuppressed(e)) return { latlng: e.latlng, snap: null };
    const settings = this.getSettings();
    return snapLatLng(e.latlng, this.getSnapIndex(), this.map.getZoom(), settings.snapTolerance, filter);
  }

  /** Element unter dem Mauszeiger (nur Entwurf, keine OSM-Strassen). */
  pick(e) {
    const r = snapLatLng(e.latlng, this.getPickIndex(), this.map.getZoom(), PICK_TOLERANCE);
    if (!r.snap) return null;
    const ref = r.snap.ref;
    const f = getFeature(this.store.doc, ref.featureId);
    if (!f) return null;
    let segIndex = null;
    if (f.type === 'road') {
      segIndex = r.snap.kind === 'segment' ? ref.index : Math.min(ref.index, f.segments.length - 1);
    }
    return { featureId: f.id, segIndex };
  }

  // --- Ereignisse --------------------------------------------------------------

  onClick(e) {
    switch (this.tool) {
      case 'road': return this.roadClick(e);
      case 'junction': return this.junctionClick(e);
      case 'roundabout': return this.roundaboutClick(e);
      case 'adopt': return this.adoptClick(e);
      default: return this.selectClick(e);
    }
  }

  onDblClick(e) {
    if (this.tool === 'road' && this.draft) {
      e.consume();
      const v = this.draft.vertices;
      if (v.length >= 2) {
        const a = this.map.project(v[v.length - 1].latlng);
        const b = this.map.project(v[v.length - 2].latlng);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 3) v.pop();
      }
      this.finishRoad();
    } else if (this.tool !== 'select') {
      e.consume();
    }
  }

  onPointerMove(e) {
    if (this.drag) return this.dragMove(e);
    switch (this.tool) {
      case 'road': {
        const r = this.snap(e);
        this.setSnap(r);
        if (this.draft) this.previewRoad(r.latlng);
        break;
      }
      case 'junction':
        this.setSnap(this.snap(e));
        break;
      case 'roundabout':
        if (this.draft) {
          this.draft.radius = this.clampRadius(haversine(this.draft.center, e.latlng));
          this.setPreview({ circle: { center: this.draft.center, radius: this.draft.radius }, color: this.activeColor() });
          this.onStatus(`Radius: ${this.draft.radius.toFixed(1)} m – klicken zum Bestätigen, Esc bricht ab.`);
          this.setSnap(null);
        } else {
          this.setSnap(this.snap(e));
        }
        break;
      case 'adopt':
        this.setSnap(this.snap(e, (ref) => ref.source === 'osm'));
        break;
      default:
        this.selectHover(e);
    }
  }

  onPointerDown(e) {
    if (this.tool !== 'select' || !this.canEdit()) return;
    const f = this.selectedFeature();
    if (!f) return;
    const hit = hitHandle(this.map, f, e.point);
    if (hit && hit.kind === 'vertex') {
      e.consume();
      this.map.setDragEnabled(false);
      this.drag = { featureId: f.id, index: hit.index, latlng: null, moved: false };
    }
  }

  onPointerUp() {
    if (this.drag) this.dragEnd();
  }

  onContextMenu(e) {
    if (this.tool === 'road' && this.draft) return this.finishRoad();
    if (this.tool === 'select') {
      const f = this.selectedFeature();
      const hit = f && this.canEdit() ? hitHandle(this.map, f, e.point) : null;
      if (hit && hit.kind === 'vertex') this.deleteVertex(hit.index);
    }
  }

  // --- Tastatur (von app.js aufgerufen) ---------------------------------------

  cancel() {
    if (this.draft) {
      this.draft = null;
      this.setPreview(null);
      this.setSnap(null);
      this.onStatus(this.toolInfo().hint);
      return true;
    }
    if (this.selection) {
      this.setSelection(null);
      return true;
    }
    return false;
  }

  finish() {
    if (this.tool === 'road' && this.draft) this.finishRoad();
  }

  popVertex() {
    if (this.tool === 'road' && this.draft && this.draft.vertices.length) {
      this.draft.vertices.pop();
      if (!this.draft.vertices.length) return this.cancel();
      this.previewRoad(null);
      return true;
    }
    return false;
  }

  deleteSelection() {
    const f = this.selectedFeature();
    if (!f || !this.canEdit()) return false;
    this.store.commit('Element löschen', (doc) => removeFeature(doc, f.id));
    this.setSelection(null);
    this.setHover(null);
    return true;
  }

  // --- Auswahl-Werkzeug -------------------------------------------------------

  selectHover(e) {
    const f = this.selectedFeature();
    const handle = f && this.canEdit() ? hitHandle(this.map, f, e.point) : null;
    if (handle) {
      this.map.setCursor(handle.kind === 'vertex' ? 'move' : 'copy');
      this.setHover(null);
      return;
    }
    const hit = this.pick(e);
    this.map.setCursor(hit ? 'pointer' : '');
    this.setHover(hit ? { ...hit, point: e.point } : null);
  }

  setHover(h) {
    const changed = (!!h !== !!this.hover) || (h && (h.featureId !== this.hover.featureId));
    this.hover = h;
    if (h) this.hover.point = h.point;
    if (changed || h) this.onHoverChange && this.onHoverChange(h);
  }

  selectClick(e) {
    if (this.drag) return;
    const f = this.selectedFeature();
    if (f && this.canEdit()) {
      const hit = hitHandle(this.map, f, e.point);
      if (hit && hit.kind === 'midpoint' && f.type === 'road') return this.insertVertex(hit.index);
      if (hit && hit.kind === 'vertex') return;
    }
    const hit = this.pick(e);
    if (hit) {
      this.setSelection(hit);
    } else if (this.selection) {
      this.setSelection(null);
    }
  }

  dragMove(e) {
    const f = this.selectedFeature();
    if (!f || f.id !== this.drag.featureId) return this.dragEnd();
    const r = this.snap(e, excludeFeature(f.id));
    this.drag.latlng = roundCoord(r.latlng);
    this.drag.moved = true;
    this.setSnap(r);
    const color = '#ff6d00';
    if (f.type === 'road') {
      const i = this.drag.index;
      const pts = [];
      if (i > 0) pts.push(f.nodes[i - 1]);
      pts.push(this.drag.latlng);
      if (i < f.nodes.length - 1) pts.push(f.nodes[i + 1]);
      this.setPreview({ points: pts, color });
    } else if (f.type === 'roundabout') {
      this.setPreview({ circle: { center: this.drag.latlng, radius: f.radius }, color });
    } else {
      this.setPreview({ points: [this.drag.latlng], color });
    }
  }

  dragEnd() {
    const drag = this.drag;
    this.drag = null;
    this.map.setDragEnabled(true);
    this.setPreview(null);
    this.setSnap(null);
    if (!drag || !drag.moved || !drag.latlng) return;
    const f = getFeature(this.store.doc, drag.featureId);
    if (!f) return;
    this.store.commit('Punkt verschieben', (doc) => {
      if (f.type === 'road') moveRoadNode(doc, f.id, drag.index, drag.latlng);
      else if (f.type === 'junction') getFeature(doc, f.id).at = drag.latlng;
      else if (f.type === 'roundabout') getFeature(doc, f.id).center = drag.latlng;
    });
  }

  deleteVertex(index) {
    const f = this.selectedFeature();
    if (!f || f.type !== 'road') return;
    if (f.nodes.length <= 2) {
      this.toast('Eine Strasse braucht mindestens zwei Punkte. Lösche stattdessen die Strasse.');
      return;
    }
    this.store.commit('Punkt löschen', (doc) => removeRoadNode(doc, f.id, index));
    if (this.selection && this.selection.segIndex !== null && this.selection.segIndex >= f.segments.length) {
      this.setSelection({ featureId: f.id, segIndex: f.segments.length - 1 });
    }
  }

  insertVertex(index) {
    const f = this.selectedFeature();
    if (!f || f.type !== 'road') return;
    const a = f.nodes[index];
    const b = f.nodes[index + 1];
    this.store.commit('Punkt einfügen', (doc) => splitRoadSegment(doc, f.id, index, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
  }

  // --- Strasse ----------------------------------------------------------------

  activeColor() {
    const layer = this.store.doc.layers.find((l) => l.id === this.getActiveLayerId());
    return layer ? layer.color : '#333';
  }

  roadClick(e) {
    const r = this.snap(e);
    if (!this.draft) this.draft = { type: 'road', vertices: [] };
    const v = this.draft.vertices;
    if (v.length) {
      const a = this.map.project(v[v.length - 1].latlng);
      const b = this.map.project(r.latlng);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
    }
    v.push({ latlng: roundCoord(r.latlng), snap: r.snap });
    this.previewRoad(r.latlng);
    this.onStatus(`${v.length} Punkt${v.length === 1 ? '' : 'e'} gesetzt – Doppelklick, Enter oder Rechtsklick beendet die Strasse.`);
  }

  previewRoad(cursor) {
    if (!this.draft) return;
    this.setPreview({ points: this.draft.vertices.map((v) => v.latlng), cursor, color: this.activeColor() });
  }

  finishRoad() {
    const draft = this.draft;
    this.draft = null;
    this.setPreview(null);
    this.setSnap(null);
    if (!draft || draft.vertices.length < 2) {
      this.onStatus('Strasse verworfen (mindestens zwei Punkte nötig).');
      return;
    }
    const layerId = this.getActiveLayerId();
    const kind = this.getDefaultRoadKind();
    this.store.commit('Strasse zeichnen', (doc) => {
      const splits = applySnapSplits(doc, draft.vertices);
      doc.features.push(createRoad({ layerId, nodes: draft.vertices.map((v) => v.latlng), kind }));
      if (splits) this.toast(`Strasse gezeichnet, ${splits} bestehende${splits === 1 ? 'r' : ''} Abschnitt${splits === 1 ? '' : 'e'} geteilt.`);
    });
    this.onStatus(this.toolInfo().hint);
  }

  // --- Kreuzung ---------------------------------------------------------------

  junctionClick(e) {
    const r = this.snap(e);
    const layerId = this.getActiveLayerId();
    this.store.commit('Kreuzung setzen', (doc) => doc.features.push(createJunction({ layerId, at: r.latlng })));
  }

  // --- Kreisel ----------------------------------------------------------------

  clampRadius(r) {
    return Math.round(Math.max(4, Math.min(200, r)) * 10) / 10;
  }

  roundaboutClick(e) {
    if (!this.draft) {
      const r = this.snap(e);
      this.draft = { type: 'roundabout', center: roundCoord(r.latlng), radius: 15 };
      this.setPreview({ circle: { center: this.draft.center, radius: 15 }, color: this.activeColor() });
      this.onStatus('Maus bewegen wählt den Radius, klicken bestätigt. Esc bricht ab.');
      return;
    }
    const { center, radius } = this.draft;
    this.draft = null;
    this.setPreview(null);
    const layerId = this.getActiveLayerId();
    this.store.commit('Kreisel setzen', (doc) => doc.features.push(createRoundabout({ layerId, center, radius })));
    this.onStatus(this.toolInfo().hint);
  }

  // --- OSM übernehmen ---------------------------------------------------------

  adoptClick(e) {
    const settings = this.getSettings();
    const r = snapLatLng(e.latlng, this.getSnapIndex(), this.map.getZoom(), Math.max(settings.snapTolerance, 16), (ref) => ref.source === 'osm');
    if (!r.snap) {
      this.toast('Keine OSM-Strasse in der Nähe. Näher heranzoomen (ab Zoom 16) und auf eine Strasse klicken.');
      return;
    }
    const way = this.getOsmWay(r.snap.ref.wayId);
    if (!way) return;
    const layerId = this.getActiveLayerId();
    const tags = way.tags || {};
    const level = tags.tunnel && tags.tunnel !== 'no' ? 'tunnel' : (tags.bridge && tags.bridge !== 'no' ? 'bridge' : 'ground');
    this.store.commit('OSM-Strasse übernehmen', (doc) => {
      const road = createRoad({
        layerId,
        nodes: way.geometry,
        kind: roadKindFromHighway(tags.highway),
        name: tags.name || tags.ref || '',
        status: 'existing',
        level,
        oneway: tags.oneway === 'yes' || tags.oneway === '1',
      });
      road.note = tags.highway ? `OSM highway=${tags.highway}, way ${way.id}` : `OSM way ${way.id}`;
      doc.features.push(road);
    });
    this.toast(`„${tags.name || 'Strasse'}“ übernommen. Im Auswahl-Werkzeug bearbeiten.`);
  }
}
