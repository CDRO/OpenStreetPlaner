// Werkzeuge: Auswählen/Bearbeiten, Strasse, Kreuzung, Kreisel, OSM übernehmen.
// Arbeitet auf den Ereignissen der SlippyMap und hält Zeichen-/Einrastzustand,
// den draw.js auf das Canvas bringt.

import {
  applySnapSplits, createJunction, createRoad, createRoundabout, createZone, extendRoad, featureLabel, getFeature, getLayer,
  insertZoneNode, moveFeatureNode, pointInPolygon, removeFeature, removeRoadNode, removeZoneNode, ringArea,
  splitRoadSegment, roundCoord, shiftLatLng, translateFeatures, featuresInBounds,
  expandGroups,
} from './model.js';
import { snapLatLng, excludeFeature } from './snap.js';
import { haversine, pathLength, project as mercator } from './geometry.js';
import { ringAreaM2 } from './costs.js';
import { roadKindFromHighway } from './osm.js';
import { hitComment, hitHandle } from './draw.js';
import { parseMaxspeed } from './routing.js';
import { t, tn } from './i18n.js';

export const TOOLS = [
  { id: 'select', label: 'Auswählen', key: 'V', hint: 'Element anklicken zum Auswählen. Griffe ziehen zum Verschieben, Rechtsklick auf einen Griff löscht den Punkt, Klick auf einen Zwischenpunkt fügt einen ein.' },
  { id: 'road', label: 'Strasse', key: 'S', hint: 'Klicken setzt Punkte. Doppelklick, Enter oder Rechtsklick beendet, Esc bricht ab, Backspace entfernt den letzten Punkt. Erster Klick auf einen Strassen-Endpunkt verlängert diese Strasse.' },
  { id: 'junction', label: 'Kreuzung / Punkt', key: 'K', hint: 'Klicken platziert eine Kreuzung oder Punkt-Massnahme (Ampel, Stop, Fussgängerstreifen, Bushaltestelle), am besten auf einen Strassenpunkt.' },
  { id: 'zone', label: 'Zone / Fläche', key: 'F', hint: 'Klicken setzt Eckpunkte. Doppelklick, Enter oder Rechtsklick schliesst die Fläche (mindestens drei Punkte), Esc bricht ab.' },
  { id: 'roundabout', label: 'Kreisel', key: 'R', hint: 'Klicken setzt das Zentrum, Maus bewegen wählt den Radius, erneut klicken bestätigt.' },
  { id: 'adopt', label: 'OSM übernehmen', key: 'O', hint: 'Bestehende OSM-Strasse anklicken: sie wird als bearbeitbare Kopie in die aktive Ebene übernommen (ab Zoom 16, OSM-Strassen werden eingeblendet). Shift+Klick übernimmt sie als Rückbau.' },
  { id: 'route', label: 'Route', key: 'T', hint: 'Klicken setzt den Start (A), ein zweiter Klick das Ziel (B). Weitere Klicks beginnen neu, Esc löscht die Route.' },
  { id: 'measure', label: 'Messen', key: 'M', hint: 'Klicken setzt Messpunkte: Länge je Abschnitt und gesamt, ab drei Punkten auch die Fläche. Doppelklick oder Enter beendet, Esc löscht die Messung.' },
  { id: 'comment', label: 'Kommentar', key: 'C', hint: 'Auf die Karte klicken, um dort einen Kommentar zu hinterlassen. Geht auch ohne Bearbeitungsrecht.' },
];

/** Werkzeuge, die auch ohne Bearbeitungsrecht erlaubt sind. */
const VIEW_TOOLS = new Set(['select', 'route', 'comment', 'measure']);

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
    this.routeDraft = null; // Start gesetzt, Ziel fehlt noch
    this.routeTarget = null; // null = Hauptroute, sonst { pairId }, { isochrone: true } oder { busLine: id }
    this.commentDraft = null; // Position für einen neuen Kommentar
    this.modifiers = { Shift: false, Control: false, Alt: false };
    this.multi = new Set(); // Mehrfachauswahl (enthält bei mehr als einem Element auch das primäre)
    this.multiMode = false; // Schalter für Touch: jeder Klick ergänzt die Auswahl
    this.measure = null; // { points, cursor, done }
    this.box = null; // Rahmenauswahl: { start, end } in Pixeln
    this.groupDrag = null; // ganze Auswahl verschieben: { ids, start, startPx, dx, dy, moved }
    this.adoptStatus = 'existing'; // Werkzeug „OSM übernehmen“: Status der Kopie (existing | remove)
    this.osmHover = null; // OSM-Strasse unter dem Zeiger im Werkzeug „OSM übernehmen“: { way }
    this.touch = false; // letzter Zeiger war Finger/Stift: grössere Griffe

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
    if (!VIEW_TOOLS.has(id) && !this.canEdit()) {
      this.toast(t('Nur Ansicht: Lege zuerst eine eigene Kopie an, um zu zeichnen.'));
      return;
    }
    this.cancel();
    this.tool = id;
    if (id !== 'select') this.setSelection(null);
    this.setOsmHover(null);
    this.applyCursor();
    this.onToolChange(id);
    this.onStatus(this.toolInfo().hint);
    this.onSceneChange();
  }

  applyCursor() {
    this.map.setCursor(this.tool === 'select' ? '' : 'crosshair');
  }

  setSelection(sel, { keepMulti = false } = {}) {
    if (!keepMulti) {
      this.multi.clear();
      // Gruppen: ein Mitglied auswählen heisst, die ganze Gruppe auswählen (zusammen verschieben, löschen)
      if (sel) {
        const members = expandGroups(this.store.doc, [sel.featureId]);
        if (members.length > 1) this.multi = new Set(members);
      }
    }
    this.selection = sel;
    this.onSelectionChange(sel);
    this.onSceneChange();
  }

  /** Besteht die Mehrfachauswahl genau aus der Gruppe des primären Elements? Dann zeigt die Oberfläche dessen Eigenschaften. */
  isGroupSelection() {
    if (!this.selection || this.multi.size < 2) return false;
    const f = getFeature(this.store.doc, this.selection.featureId);
    if (!f || !f.group) return false;
    const members = new Set(expandGroups(this.store.doc, [f.id]));
    if (members.size !== this.multi.size) return false;
    for (const id of this.multi) if (!members.has(id)) return false;
    return true;
  }

  selectedFeature() {
    return this.selection ? getFeature(this.store.doc, this.selection.featureId) : null;
  }

  /** Alle ausgewählten IDs: Mehrfachauswahl oder das eine ausgewählte Element. */
  selectedIds() {
    if (this.multi.size) return Array.from(this.multi);
    return this.selection ? [this.selection.featureId] : [];
  }

  isSelected(id) {
    return this.multi.has(id) || !!(this.selection && this.selection.featureId === id);
  }

  /** Mehrfachauswahl: Shift gedrückt oder Schalter aktiv. */
  isMultiModifier(e) {
    return this.multiMode || !!(e && e.originalEvent && e.originalEvent.shiftKey) || this.modifiers.Shift;
  }

  /** Element zur Mehrfachauswahl hinzufügen oder entfernen. */
  toggleSelected(hit) {
    if (!this.multi.size && this.selection) this.multi.add(this.selection.featureId);
    const members = expandGroups(this.store.doc, [hit.featureId]); // Gruppen wandern als Ganzes
    if (this.multi.has(hit.featureId)) {
      for (const id of members) this.multi.delete(id);
      const next = this.multi.size ? { featureId: Array.from(this.multi)[0], segIndex: null } : null;
      if (this.multi.size === 1) this.multi.clear();
      this.setSelection(next, { keepMulti: true });
      return;
    }
    for (const id of members) this.multi.add(id);
    if (this.multi.size === 1) this.multi.clear();
    this.setSelection(hit, { keepMulti: true });
  }

  /** Alle Elemente sichtbarer Ebenen auswählen. */
  selectAll() {
    if (this.tool !== 'select') this.setTool('select');
    const doc = this.store.doc;
    const hidden = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
    const ids = doc.features.filter((f) => !hidden.has(f.layerId)).map((f) => f.id);
    if (!ids.length) return;
    this.multi = new Set(ids.length > 1 ? ids : []);
    this.setSelection({ featureId: ids[0], segIndex: null }, { keepMulti: true });
  }

  /** Griff-Toleranz in Pixeln: mit dem Finger grösser. */
  handleTol() {
    return this.touch ? 16 : 9;
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
    if (r.snap) {
      const ref = r.snap.ref;
      const f = getFeature(this.store.doc, ref.featureId);
      if (f) {
        let segIndex = null;
        if (f.type === 'road') segIndex = r.snap.kind === 'segment' ? ref.index : Math.min(ref.index, f.segments.length - 1);
        return { featureId: f.id, segIndex };
      }
    }
    // Zonen: Klick ins Innere trifft die kleinste umschliessende Fläche
    const doc = this.store.doc;
    let best = null;
    for (const f of doc.features) {
      if (f.type !== 'zone') continue;
      const layer = getLayer(doc, f.layerId);
      if (!layer || layer.visible === false || !pointInPolygon(e.latlng, f.nodes)) continue;
      const area = ringArea(f.nodes);
      if (!best || area < best.area) best = { featureId: f.id, segIndex: null, area };
    }
    return best ? { featureId: best.featureId, segIndex: null } : null;
  }

  // --- Ereignisse --------------------------------------------------------------

  onClick(e) {
    switch (this.tool) {
      case 'road': return this.roadClick(e);
      case 'junction': return this.junctionClick(e);
      case 'roundabout': return this.roundaboutClick(e);
      case 'adopt': return this.adoptClick(e);
      case 'route': return this.routeClick(e);
      case 'zone': return this.zoneClick(e);
      case 'comment': return this.commentClick(e);
      case 'measure': return this.measureClick(e);
      default: return this.selectClick(e);
    }
  }

  onDblClick(e) {
    if ((this.tool === 'road' || this.tool === 'zone') && this.draft) {
      e.consume();
      const v = this.draft.vertices;
      if (v.length >= 2) {
        const a = this.map.project(v[v.length - 1].latlng);
        const b = this.map.project(v[v.length - 2].latlng);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 3) v.pop();
      }
      if (this.tool === 'road') this.finishRoad();
      else this.finishZone();
    } else if (this.tool === 'measure') {
      e.consume();
      this.measureFinish();
    } else if (this.tool !== 'select') {
      e.consume();
    }
  }

  onPointerMove(e) {
    if (this.drag) return this.dragMove(e);
    if (this.groupDrag) return this.groupDragMove(e);
    if (this.box) return this.boxMove(e);
    switch (this.tool) {
      case 'measure': {
        const r = this.snap(e);
        this.setSnap(r);
        if (this.measure && !this.measure.done) this.measureUpdate(r.latlng);
        break;
      }
      case 'road':
      case 'zone': {
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
          this.onStatus(t('Radius: {r} m – klicken zum Bestätigen, Esc bricht ab.', { r: this.draft.radius.toFixed(1) }));
          this.setSnap(null);
        } else {
          this.setSnap(this.snap(e));
        }
        break;
      case 'adopt': {
        const r = this.snap(e, (ref) => ref.source === 'osm');
        this.setSnap(r);
        const way = r && r.snap && r.snap.ref ? this.getOsmWay(r.snap.ref.wayId) : null;
        this.setOsmHover(way ? { way } : null);
        break;
      }
      default:
        this.selectHover(e);
    }
  }

  onPointerDown(e) {
    const type = e.originalEvent && e.originalEvent.pointerType;
    this.touch = !!type && type !== 'mouse';
    if (this.tool !== 'select' || !this.canEdit()) return;
    const f = this.selectedFeature();
    const hit = f ? hitHandle(this.map, f, e.point, this.handleTol()) : null;
    if (hit && hit.kind === 'vertex') {
      e.consume();
      this.map.setDragEnabled(false);
      this.drag = { featureId: f.id, index: hit.index, latlng: null, moved: false };
      return;
    }
    if (hit) return;
    const picked = this.pick(e);
    if (picked && this.isSelected(picked.featureId)) {
      // Ziehen auf einem ausgewählten Element verschiebt die ganze Auswahl
      e.consume();
      this.map.setDragEnabled(false);
      this.groupDrag = { ids: this.selectedIds(), start: e.latlng, startPx: e.point, dx: 0, dy: 0, moved: false };
      return;
    }
    if (!picked && this.isMultiModifier(e)) {
      e.consume();
      this.map.setDragEnabled(false);
      this.box = { start: e.point, end: e.point };
    }
  }

  onPointerUp(e) {
    if (this.drag) this.dragEnd();
    if (this.groupDrag) this.groupDragEnd();
    if (this.box) this.boxEnd(e);
  }

  groupDragMove(e) {
    const g = this.groupDrag;
    const a = mercator(g.start);
    const b = mercator(e.latlng);
    g.dx = b.x - a.x;
    g.dy = b.y - a.y;
    g.moved = g.moved || Math.hypot(e.point.x - g.startPx.x, e.point.y - g.startPx.y) > 3;
    if (!g.moved) return;
    const doc = this.store.doc;
    const shapes = [];
    for (const id of g.ids) {
      const f = getFeature(doc, id);
      if (!f) continue;
      if (f.type === 'road') shapes.push({ points: f.nodes.map((n) => shiftLatLng(n, g.dx, g.dy)) });
      else if (f.type === 'zone') shapes.push({ points: f.nodes.map((n) => shiftLatLng(n, g.dx, g.dy)), closed: true });
      else if (f.type === 'junction') shapes.push({ point: shiftLatLng(f.at, g.dx, g.dy) });
      else if (f.type === 'roundabout') shapes.push({ circle: { center: shiftLatLng(f.center, g.dx, g.dy), radius: f.radius } });
    }
    this.setPreview({ shapes, color: '#ff6d00' });
    this.onStatus(t('Auswahl verschieben – loslassen setzt ab, Esc bricht ab.'));
  }

  groupDragEnd() {
    const g = this.groupDrag;
    this.groupDrag = null;
    this.map.setDragEnabled(true);
    this.setPreview(null);
    if (!g || !g.moved) return;
    this.store.commit(g.ids.length > 1 ? 'Auswahl verschieben' : 'Element verschieben', (doc) => translateFeatures(doc, g.ids, g.dx, g.dy));
    this.onStatus(this.toolInfo().hint);
  }

  boxMove(e) {
    this.box.end = e.point;
    this.setPreview({ box: [this.box.start, this.box.end] });
  }

  boxEnd(e) {
    const box = this.box;
    this.box = null;
    this.map.setDragEnabled(true);
    this.setPreview(null);
    const end = e && e.point ? e.point : box.end;
    if (Math.abs(end.x - box.start.x) < 4 || Math.abs(end.y - box.start.y) < 4) return;
    const a = this.map.unproject(box.start);
    const b = this.map.unproject(end);
    const ids = expandGroups(this.store.doc, featuresInBounds(this.store.doc, { south: a[0], north: b[0], west: a[1], east: b[1] }));
    if (!ids.length) return;
    const all = new Set([...this.selectedIds(), ...ids]);
    this.multi = new Set(all.size > 1 ? all : []);
    this.setSelection({ featureId: ids[0], segIndex: null }, { keepMulti: true });
    this.onStatus(tn(all.size, '{n} Element ausgewählt', '{n} Elemente ausgewählt'));
  }

  onContextMenu(e) {
    if (this.tool === 'road' && this.draft) return this.finishRoad();
    if (this.tool === 'zone' && this.draft) return this.finishZone();
    if (this.tool === 'measure') return this.measureFinish();
    if (this.tool !== 'select') return undefined;
    const f = this.selectedFeature();
    const hit = f && this.canEdit() ? hitHandle(this.map, f, e.point, this.handleTol()) : null;
    if (hit && hit.kind === 'vertex') return this.deleteVertex(hit.index);
    const picked = this.pick(e);
    if (!picked) {
      // Keine eigene Strasse getroffen: OSM-Strasse unter dem Zeiger anbieten (übernehmen / Rückbau)
      const way = this.osmWayAt(e);
      if (way && this.onMenu) this.onMenu({ point: e.point, latlng: e.latlng, featureId: null, segIndex: null, ids: [], osmWay: way });
      return undefined;
    }
    if (!this.isSelected(picked.featureId)) this.setSelection(picked);
    else if (!this.selection || this.selection.featureId !== picked.featureId) this.setSelection(picked, { keepMulti: true });
    else if (picked.segIndex !== null && this.selection.segIndex !== picked.segIndex) this.setSelection(picked, { keepMulti: true });
    if (this.onMenu) this.onMenu({ point: e.point, latlng: e.latlng, featureId: picked.featureId, segIndex: picked.segIndex, ids: this.selectedIds() });
    return undefined;
  }

  // --- Tastatur (von app.js aufgerufen) ---------------------------------------

  cancel() {
    if (this.groupDrag) {
      this.groupDrag = null;
      this.map.setDragEnabled(true);
      this.setPreview(null);
      return true;
    }
    if (this.measure) {
      this.measure = null;
      this.setPreview(null);
      this.setSnap(null);
      this.onStatus(this.toolInfo().hint);
      return true;
    }
    // Ein Werkzeugwechsel verwirft nur den halb gesetzten Start; die fertige Route bleibt (Löschen via Esc im Routen-Werkzeug oder Button).
    if (this.routeDraft || this.routeTarget) {
      this.routeDraft = null;
      this.routeTarget = null;
      this.onStatus(this.toolInfo().hint);
      this.onSceneChange();
      return true;
    }
    if (this.commentDraft) {
      this.commentDraft = null;
      if (this.onCommentPlace) this.onCommentPlace(null);
      this.onSceneChange();
      return true;
    }
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
    if (this.tool === 'zone' && this.draft) this.finishZone();
    if (this.tool === 'measure') this.measureFinish();
  }

  popVertex() {
    if ((this.tool === 'road' || this.tool === 'zone') && this.draft && this.draft.vertices.length) {
      this.draft.vertices.pop();
      if (!this.draft.vertices.length) return this.cancel();
      this.previewRoad(null);
      return true;
    }
    return false;
  }

  deleteSelection() {
    const ids = this.selectedIds().filter((id) => getFeature(this.store.doc, id));
    if (!ids.length || !this.canEdit()) return false;
    this.store.commit(ids.length > 1 ? 'Elemente löschen' : 'Element löschen', (doc) => ids.forEach((id) => removeFeature(doc, id)));
    this.setSelection(null);
    this.setHover(null);
    return true;
  }

  // --- Messen -----------------------------------------------------------------

  measureClick(e) {
    const r = this.snap(e);
    if (!this.measure || this.measure.done) this.measure = { points: [], cursor: null, done: false };
    const pts = this.measure.points;
    if (pts.length) {
      const a = this.map.project(pts[pts.length - 1]);
      const b = this.map.project(r.latlng);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
    }
    pts.push(roundCoord(r.latlng));
    this.measureUpdate(r.latlng);
  }

  measureUpdate(cursor) {
    if (!this.measure) return;
    const pts = this.measure.points;
    const last = pts[pts.length - 1];
    // Der Zeiger zählt erst als weiterer Punkt, wenn er den letzten gesetzten Punkt verlassen hat
    this.measure.cursor = this.measure.done || !cursor || (last && haversine(last, cursor) < 0.5) ? null : cursor;
    this.setPreview({ measure: this.measure });
    this.onStatus(this.measureText());
  }

  measureFinish() {
    if (!this.measure || !this.measure.points.length) return;
    this.measure.done = true;
    this.measure.cursor = null;
    this.setPreview({ measure: this.measure });
    this.onStatus(this.measureText());
  }

  /** Länge, ab drei Punkten auch Fläche (als geschlossener Ring), mit Hinweis zur Bedienung. */
  measureText() {
    const m = this.measure;
    if (!m) return '';
    const pts = m.cursor ? [...m.points, m.cursor] : m.points;
    const len = pathLength(pts);
    const parts = [t('Länge {len}', { len: formatLength(len) })];
    if (pts.length >= 3) parts.push(t('Fläche {area}', { area: formatArea(ringAreaM2(pts)) }));
    const hint = m.done ? t('Esc löscht die Messung, Klick beginnt eine neue.') : t('Doppelklick oder Enter beendet, Esc löscht.');
    return `${parts.join(' · ')} – ${hint}`;
  }

  // --- Auswahl-Werkzeug -------------------------------------------------------

  selectHover(e) {
    const f = this.selectedFeature();
    const handle = f && this.canEdit() ? hitHandle(this.map, f, e.point, this.handleTol()) : null;
    if (handle) {
      this.map.setCursor(handle.kind === 'vertex' ? 'move' : 'copy');
      this.setHover(null);
      return;
    }
    const commentId = this.getComments ? hitComment(this.map, this.getComments(), e.point) : null;
    if (commentId) {
      this.map.setCursor('pointer');
      this.setHover({ commentId, point: e.point });
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
    const commentId = this.getComments ? hitComment(this.map, this.getComments(), e.point) : null;
    if (commentId) {
      if (this.onCommentSelect) this.onCommentSelect(commentId);
      return;
    }
    const f = this.selectedFeature();
    const multi = this.isMultiModifier(e);
    if (f && this.canEdit() && !multi) {
      // Griffe des primären Elements: Zwischenpunkt einfügen; mit Shift zählt der Klick zur Auswahl
      const hit = hitHandle(this.map, f, e.point, this.handleTol());
      if (hit && hit.kind === 'midpoint' && (f.type === 'road' || f.type === 'zone')) return this.insertVertex(hit.index);
      if (hit && hit.kind === 'vertex') return;
    }
    const hit = this.pick(e);
    if (multi) {
      if (hit) this.toggleSelected(hit);
      return;
    }
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
    } else if (f.type === 'zone') {
      const n = f.nodes.length;
      const i = this.drag.index;
      this.setPreview({ points: [f.nodes[(i - 1 + n) % n], this.drag.latlng, f.nodes[(i + 1) % n]], color });
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
      if (f.type === 'road' || f.type === 'zone') moveFeatureNode(doc, f.id, drag.index, drag.latlng);
      else if (f.type === 'junction') getFeature(doc, f.id).at = drag.latlng;
      else if (f.type === 'roundabout') getFeature(doc, f.id).center = drag.latlng;
    });
  }

  deleteVertex(index) {
    const f = this.selectedFeature();
    if (!f) return;
    if (f.type === 'zone') {
      if (f.nodes.length <= 3) return this.toast(t('Eine Fläche braucht mindestens drei Punkte.'));
      this.store.commit('Punkt löschen', (doc) => removeZoneNode(doc, f.id, index));
      return;
    }
    if (f.type !== 'road') return;
    if (f.nodes.length <= 2) {
      this.toast(t('Eine Strasse braucht mindestens zwei Punkte. Lösche stattdessen die Strasse.'));
      return;
    }
    this.store.commit('Punkt löschen', (doc) => removeRoadNode(doc, f.id, index));
    if (this.selection && this.selection.segIndex !== null && this.selection.segIndex >= f.segments.length) {
      this.setSelection({ featureId: f.id, segIndex: f.segments.length - 1 });
    }
  }

  insertVertex(index) {
    const f = this.selectedFeature();
    if (!f) return;
    if (f.type === 'zone') {
      const a = f.nodes[index];
      const b = f.nodes[(index + 1) % f.nodes.length];
      this.store.commit('Punkt einfügen', (doc) => insertZoneNode(doc, f.id, index, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
      return;
    }
    if (f.type !== 'road') return;
    const a = f.nodes[index];
    const b = f.nodes[index + 1];
    this.store.commit('Punkt einfügen', (doc) => splitRoadSegment(doc, f.id, index, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
  }

  // --- Strasse ----------------------------------------------------------------

  activeColor() {
    const layer = this.store.doc.layers.find((l) => l.id === this.getActiveLayerId());
    return layer ? layer.color : '#333';
  }

  roadClick(e, type = 'road') {
    const r = this.snap(e);
    if (!this.draft) {
      this.draft = { type, vertices: [] };
      // Erster Klick auf den Endpunkt einer eigenen Strasse: diese Strasse verlängern.
      const ref = r.snap && r.snap.kind === 'node' ? r.snap.ref : null;
      if (type === 'road' && ref && ref.source === 'draft' && ref.type === 'road') {
        const road = getFeature(this.store.doc, ref.featureId);
        if (road && (ref.index === 0 || ref.index === road.nodes.length - 1)) {
          this.draft.extend = { roadId: road.id, atEnd: ref.index === road.nodes.length - 1, from: road.nodes[ref.index] };
          this.previewRoad(r.latlng);
          this.onStatus(t('Verlängere „{name}“ – weitere Punkte setzen, Enter oder Doppelklick beendet.', { name: t(featureLabel(road)) }));
          return;
        }
      }
    }
    const v = this.draft.vertices;
    const lastPoint = v.length ? v[v.length - 1].latlng : (this.draft.extend ? this.draft.extend.from : null);
    if (lastPoint) {
      const a = this.map.project(lastPoint);
      const b = this.map.project(r.latlng);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
    }
    v.push({ latlng: roundCoord(r.latlng), snap: r.snap });
    this.previewRoad(r.latlng);
    this.onStatus(`${tn(v.length, '{n} Punkt gesetzt', '{n} Punkte gesetzt')} – ${type === 'zone' ? t('Doppelklick, Enter oder Rechtsklick schliesst die Fläche.') : t('Doppelklick, Enter oder Rechtsklick beendet die Strasse.')}`);
  }

  // --- Zone / Fläche ---------------------------------------------------------

  zoneClick(e) {
    this.roadClick(e, 'zone');
  }

  finishZone() {
    const draft = this.draft;
    this.draft = null;
    this.setPreview(null);
    this.setSnap(null);
    if (!draft || draft.vertices.length < 3) {
      this.onStatus(t('Fläche verworfen (mindestens drei Punkte nötig).'));
      return;
    }
    const layerId = this.getActiveLayerId();
    const kind = this.getDefaultZoneKind ? this.getDefaultZoneKind() : 'tempo30';
    this.store.commit('Fläche zeichnen', (doc) => doc.features.push(createZone({ layerId, nodes: draft.vertices.map((v) => v.latlng), kind })));
    this.onStatus(this.toolInfo().hint);
  }

  // --- Kommentar ----------------------------------------------------------------

  commentClick(e) {
    this.commentDraft = { latlng: roundCoord(e.latlng) };
    if (this.onCommentPlace) this.onCommentPlace(this.commentDraft.latlng);
    this.onStatus(t('Kommentar in der Seitenleiste eingeben und senden. Esc bricht ab.'));
    this.onSceneChange();
  }

  clearCommentDraft() {
    this.commentDraft = null;
    this.onSceneChange();
  }

  previewRoad(cursor) {
    if (!this.draft) return;
    const points = this.draft.vertices.map((v) => v.latlng);
    if (this.draft.extend) points.unshift(this.draft.extend.from);
    this.setPreview({ points, cursor, color: this.activeColor(), closed: this.draft.type === 'zone' });
  }

  finishRoad() {
    const draft = this.draft;
    this.draft = null;
    this.setPreview(null);
    this.setSnap(null);
    if (draft && draft.extend) {
      if (!draft.vertices.length) {
        this.onStatus(t('Verlängerung verworfen (kein neuer Punkt).'));
        return;
      }
      this.store.commit('Strasse verlängern', (doc) => {
        const splits = applySnapSplits(doc, draft.vertices.filter((v) => !(v.snap && v.snap.ref && v.snap.ref.featureId === draft.extend.roadId)));
        const pts = draft.vertices.map((v) => v.latlng);
        extendRoad(doc, draft.extend.roadId, draft.extend.atEnd ? pts : pts.slice().reverse(), draft.extend.atEnd);
        if (splits) this.toast(tn(splits, 'Strasse verlängert, {n} bestehender Abschnitt geteilt.', 'Strasse verlängert, {n} bestehende Abschnitte geteilt.'));
      });
      this.setSelection({ featureId: draft.extend.roadId, segIndex: null });
      this.onStatus(this.toolInfo().hint);
      return;
    }
    if (!draft || draft.vertices.length < 2) {
      this.onStatus(t('Strasse verworfen (mindestens zwei Punkte nötig).'));
      return;
    }
    const layerId = this.getActiveLayerId();
    const kind = this.getDefaultRoadKind();
    this.store.commit('Strasse zeichnen', (doc) => {
      const splits = applySnapSplits(doc, draft.vertices);
      doc.features.push(createRoad({ layerId, nodes: draft.vertices.map((v) => v.latlng), kind }));
      if (splits) this.toast(tn(splits, 'Strasse gezeichnet, {n} bestehender Abschnitt geteilt.', 'Strasse gezeichnet, {n} bestehende Abschnitte geteilt.'));
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
      this.onStatus(t('Maus bewegen wählt den Radius, klicken bestätigt. Esc bricht ab.'));
      return;
    }
    const { center, radius } = this.draft;
    this.draft = null;
    this.setPreview(null);
    const layerId = this.getActiveLayerId();
    this.store.commit('Kreisel setzen', (doc) => doc.features.push(createRoundabout({ layerId, center, radius })));
    this.onStatus(this.toolInfo().hint);
  }

  // --- Route ------------------------------------------------------------------

  routeClick(e) {
    const ll = roundCoord(e.latlng);
    const target = this.routeTarget;
    if (target && target.busLine) return this.busStopClick(e, target.busLine);
    if (target && target.isochrone) {
      this.routeTarget = null;
      this.store.commit('Isochronen-Ursprung setzen', (doc) => {
        const prev = doc.isochrone || {};
        doc.isochrone = { from: ll, minutes: prev.minutes || [5, 10, 15], mode: prev.mode || 'proposed' };
      });
      this.onStatus(this.toolInfo().hint);
      this.onSceneChange();
      return;
    }
    if (!this.routeDraft) {
      this.routeDraft = { from: ll, pairId: target ? target.pairId : null };
      if (!target && this.store.doc.route) this.store.commit('Route neu beginnen', (doc) => { doc.route = null; });
      this.onStatus(target ? t('Start des Paars gesetzt – jetzt das Ziel anklicken.') : t('Start gesetzt – jetzt das Ziel anklicken.'));
      this.onSceneChange();
      return;
    }
    const { from, pairId } = this.routeDraft;
    this.routeDraft = null;
    this.routeTarget = null;
    if (pairId) {
      this.store.commit('Routenpaar setzen', (doc) => {
        const p = (doc.routePairs || []).find((x) => x.id === pairId);
        if (p) {
          p.from = from;
          p.to = ll;
        }
      });
    } else {
      const vehicle = this.getDefaultVehicle ? this.getDefaultVehicle() : 'car';
      this.store.commit('Route setzen', (doc) => { doc.route = { from, to: ll, vehicle }; });
    }
    this.onStatus(this.toolInfo().hint);
  }

  /**
   * Haltestellen einer Buslinie: Klick auf eine bestehende Bushaltestelle hängt sie an die Linie,
   * Klick anderswo setzt eine neue Haltestelle (eingerastet) und hängt sie an. Esc beendet.
   */
  busStopClick(e, lineId) {
    const doc = this.store.doc;
    const line = (doc.busLines || []).find((l) => l.id === lineId);
    if (!line) {
      this.routeTarget = null;
      return;
    }
    // Bestehende Haltestelle unter dem Zeiger hat Vorrang vor Strassenpunkten an derselben Stelle
    const existing = this.nearestBusStop(e.point);
    if (existing) {
      if (line.stops[line.stops.length - 1] === existing.id) return this.toast(t('Diese Haltestelle ist bereits die letzte der Linie.'));
      this.store.commit('Haltestelle an Linie anhängen', (d) => {
        const l = d.busLines.find((x) => x.id === lineId);
        const stop = getFeature(d, existing.id);
        if (!l || !stop) return;
        l.stops.push(stop.id);
        if (l.name && !stop.lines.includes(l.name)) stop.lines.push(l.name);
      });
      this.onStatus(t('Haltestelle {n} angehängt – weitere anklicken oder neue setzen, Esc beendet.', { n: line.stops.length }));
      return;
    }
    const layerId = this.getActiveLayerId();
    const osmStop = this.nearestOsmStop(e.point);
    if (osmStop) {
      this.store.commit('OSM-Haltestelle übernehmen', (d) => {
        const l = d.busLines.find((x) => x.id === lineId);
        let stop = d.features.find((f) => f.type === 'junction' && f.kind === 'busstop' && f.osmId === osmStop.id);
        if (!stop) {
          stop = createJunction({ layerId, at: osmStop.at, kind: 'busstop', name: osmStop.name || '', lines: l && l.name ? [l.name] : [], osmId: osmStop.id });
          d.features.push(stop);
        } else if (l && l.name && !stop.lines.includes(l.name)) {
          stop.lines.push(l.name);
        }
        if (l && l.stops[l.stops.length - 1] !== stop.id) l.stops.push(stop.id);
      });
      this.onStatus(t('OSM-Haltestelle „{name}“ übernommen und angehängt – weitere anklicken oder neue setzen, Esc beendet.', { name: osmStop.name || osmStop.id }));
      return;
    }
    const r = this.snap(e);
    this.store.commit('Haltestelle setzen', (d) => {
      const l = d.busLines.find((x) => x.id === lineId);
      const stop = createJunction({ layerId, at: r.latlng, kind: 'busstop', lines: l && l.name ? [l.name] : [] });
      d.features.push(stop);
      if (l) l.stops.push(stop.id);
    });
    this.onStatus(t('Haltestelle {n} gesetzt – weitere anklicken oder neue setzen, Esc beendet.', { n: line.stops.length }));
  }

  /** Sichtbare Bushaltestelle innerhalb der Klick-Toleranz (Pixel), sonst null. */
  nearestBusStop(point) {
    const doc = this.store.doc;
    let best = null;
    for (const f of doc.features) {
      if (f.type !== 'junction' || f.kind !== 'busstop') continue;
      const layer = getLayer(doc, f.layerId);
      if (!layer || layer.visible === false) continue;
      const p = this.map.project(f.at);
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d <= PICK_TOLERANCE && (!best || d < best.d)) best = { f, d };
    }
    return best ? best.f : null;
  }

  /** Geladene OSM-Haltestelle innerhalb der Klick-Toleranz (Pixel), sonst null. */
  nearestOsmStop(point) {
    const stops = this.getTransitStops ? this.getTransitStops() : [];
    let best = null;
    for (const s of stops) {
      const p = this.map.project(s.at);
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d <= PICK_TOLERANCE + 2 && (!best || d < best.d)) best = { s, d };
    }
    return best ? best.s : null;
  }

  /** Nächste Klicks im Routen-Werkzeug setzen ein Paar (pairId), den Isochronen-Ursprung oder Haltestellen einer Buslinie. */
  captureRoute(target) {
    this.routeTarget = target;
    this.routeDraft = null;
    if (this.tool !== 'route') this.setTool('route');
    if (target && target.busLine) this.onStatus(t('Haltestellen der Linie anklicken oder neue setzen; Esc beendet.'));
    else this.onStatus(target && target.isochrone ? t('Ursprung der Erreichbarkeit auf der Karte anklicken.') : t('Start des Paars auf der Karte anklicken, dann das Ziel.'));
    this.onSceneChange();
  }

  // --- OSM übernehmen ---------------------------------------------------------

  /** Geladene OSM-Strasse innerhalb der Klick-Toleranz (mindestens 16 px), sonst null. */
  osmWayAt(e) {
    const settings = this.getSettings();
    const r = snapLatLng(e.latlng, this.getSnapIndex(), this.map.getZoom(), Math.max(settings.snapTolerance, 16), (ref) => ref.source === 'osm');
    return r.snap && r.snap.ref ? this.getOsmWay(r.snap.ref.wayId) : null;
  }

  setOsmHover(h) {
    const prev = this.osmHover ? this.osmHover.way.id : null;
    const next = h ? h.way.id : null;
    this.osmHover = h;
    if (prev === next) return;
    if (h) {
      const tags = h.way.tags || {};
      const name = tags.name || tags.ref || t('ohne Namen');
      const speed = tags.maxspeed ? ` · ${tags.maxspeed}` : '';
      const status = this.adoptStatus === 'remove' ? t('Rückbau') : t('Bestehend');
      this.onStatus(t('OSM: {name} ({type}{speed}) – Klick übernimmt als {status}, Shift+Klick als Rückbau.', { name, type: tags.highway || 'way', speed, status }));
    } else if (this.tool === 'adopt') {
      this.onStatus(this.toolInfo().hint);
    }
    this.onSceneChange();
  }

  adoptClick(e) {
    const way = this.osmWayAt(e);
    if (!way) {
      this.toast(t('Keine OSM-Strasse in der Nähe. Näher heranzoomen (ab Zoom 16) und auf eine Strasse klicken.'));
      return;
    }
    const shift = !!(e.originalEvent && e.originalEvent.shiftKey) || this.modifiers.Shift;
    this.adoptWay(way, shift ? 'remove' : this.adoptStatus);
  }

  /**
   * OSM-Strasse als Kopie übernehmen: status 'existing' (bearbeiten) oder 'remove' (Rückbau).
   * Ist der Way schon übernommen, wird die Kopie ausgewählt statt verdoppelt (bei Rückbau: Status gesetzt).
   */
  adoptWay(way, status = 'existing') {
    if (!this.canEdit()) return null;
    const tags = way.tags || {};
    const name = tags.name || tags.ref || t('Strasse');
    const existing = this.store.doc.features.find((f) => f.type === 'road' && f.osmId === way.id);
    if (existing) {
      if (status === 'remove' && existing.status !== 'remove') {
        this.store.commit('Status ändern', (doc) => {
          const r = getFeature(doc, existing.id);
          if (r) r.status = 'remove';
        });
        this.toast(t('„{name}“ ist als Rückbau markiert.', { name }));
      } else {
        this.toast(t('„{name}“ ist schon übernommen – ausgewählt.', { name }));
      }
      this.setSelection({ featureId: existing.id, segIndex: null });
      return existing.id;
    }
    const layerId = this.getActiveLayerId();
    const level = tags.tunnel && tags.tunnel !== 'no' ? 'tunnel' : (tags.bridge && tags.bridge !== 'no' ? 'bridge' : 'ground');
    let id = null;
    this.store.commit(status === 'remove' ? 'OSM-Strasse als Rückbau übernehmen' : 'OSM-Strasse übernehmen', (doc) => {
      const road = createRoad({
        layerId,
        nodes: way.geometry,
        kind: roadKindFromHighway(tags.highway),
        name: tags.name || tags.ref || '',
        status,
        level,
        oneway: tags.oneway === 'yes' || tags.oneway === '1',
        maxspeed: parseMaxspeed(tags.maxspeed),
        osmId: way.id,
      });
      road.note = tags.highway ? `OSM highway=${tags.highway}, way ${way.id}` : `OSM way ${way.id}`;
      doc.features.push(road);
      id = road.id;
    });
    this.setSelection({ featureId: id, segIndex: null });
    this.toast(status === 'remove' ? t('„{name}“ als Rückbau übernommen.', { name }) : t('„{name}“ übernommen und ausgewählt – Eigenschaften rechts, weitere Strassen anklicken.', { name }));
    return id;
  }
}

export function formatLength(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m >= 100 ? Math.round(m) : m.toFixed(1)} m`;
}

export function formatArea(m2) {
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`;
}
