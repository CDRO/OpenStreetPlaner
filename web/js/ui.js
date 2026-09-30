// Seitenleiste, Kopfzeile, Statuszeile, Dialoge. Reine DOM-Arbeit; die Logik
// steckt in app.js (actions) und den Modulen.

import { JUNCTION_KINDS, LEVELS, ROAD_KINDS, STATUSES, docStats, featureLabel, getFeature, roadSpeed } from './model.js';
import { pathLength } from './geometry.js';
import { TOOLS } from './tools.js';
import { formatDuration } from './routing.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
};
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const options = (list, value) => list.map((o) => `<option value="${o.id}"${o.id === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

export class UI {
  constructor(ctx) {
    this.ctx = ctx; // { store, local, settings, tools, actions, map }
    this.$ = (id) => document.getElementById(id);
    this.wireStatic();
  }

  wireStatic() {
    const { actions } = this.ctx;
    document.querySelectorAll('.tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.showTab(btn.dataset.tab));
    });
    this.$('sidebar-toggle').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-hidden');
      setTimeout(() => this.ctx.map.invalidateSize(), 250);
    });
    this.$('draft-name').addEventListener('change', (e) => actions.rename(e.target.value));
    this.$('btn-undo').addEventListener('click', () => actions.undo());
    this.$('btn-redo').addEventListener('click', () => actions.redo());
    this.$('btn-save').addEventListener('click', () => actions.saveDraft());
    this.$('btn-share').addEventListener('click', () => actions.share());
    this.$('btn-locate').addEventListener('click', () => actions.locate());
    this.$('btn-add-layer').addEventListener('click', () => actions.addLayer());
    this.$('import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) actions.importFile(file);
      e.target.value = '';
    });
    this.$('modal').addEventListener('click', (e) => {
      if (e.target === this.$('modal') || e.target.closest('[data-close]')) this.closeModal();
    });
    this.$('pin-close').addEventListener('click', () => this.setPin(null));
    this.wireSearch();
  }

  showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
    if (name === 'history') this.refreshHistory();
    if (name === 'route') {
      this.refreshRoute();
      if (this.ctx.tools.tool !== 'route') this.ctx.tools.setTool('route');
    }
  }

  // --- Suche ---------------------------------------------------------------------

  wireSearch() {
    const input = this.$('search-input');
    const list = this.$('search-results');
    let timer = null;
    const run = () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) return;
      const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
      if (coord) {
        const lat = parseFloat(coord[1]);
        const lng = parseFloat(coord[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          this.renderSearchResults([{ label: `Koordinate ${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, bbox: null }]);
          return;
        }
      }
      this.ctx.actions.search(q).then((results) => this.renderSearchResults(results)).catch((err) => {
        list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
        list.hidden = false;
      });
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      if (input.value.trim().length < 3) {
        list.hidden = true;
        return;
      }
      timer = setTimeout(run, 700);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      } else if (e.key === 'Escape') {
        list.hidden = true;
        input.blur();
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search')) list.hidden = true;
    });
  }

  renderSearchResults(results) {
    const list = this.$('search-results');
    if (!results.length) {
      list.innerHTML = '<li class="muted">Nichts gefunden.</li>';
      list.hidden = false;
      return;
    }
    list.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.label)}</button></li>`).join('');
    list.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        this.ctx.actions.goTo(results[Number(b.dataset.i)]);
        list.hidden = true;
      });
    });
    list.hidden = false;
  }

  /** Markierung für ein Suchergebnis (DOM-Element, folgt der Karte). */
  setPin(pin) {
    const el = this.$('pin');
    this.pin = pin;
    if (!pin) {
      el.hidden = true;
      if (this.unPin) this.unPin();
      this.unPin = null;
      return;
    }
    this.$('pin-label').textContent = pin.label;
    el.hidden = false;
    const place = () => {
      const p = this.ctx.map.project(pin.latlng);
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    };
    place();
    if (this.unPin) this.unPin();
    this.unPin = this.ctx.map.on('render', place);
  }

  // --- Sammel-Refresh ------------------------------------------------------------

  refreshAll() {
    this.refreshHeader();
    this.refreshTools();
    this.refreshProperties();
    this.refreshLayers();
    this.refreshDrafts();
    this.refreshHistory();
    this.refreshRoute();
  }

  refreshHeader() {
    const { store, actions } = this.ctx;
    const nameEl = this.$('draft-name');
    if (document.activeElement !== nameEl) nameEl.value = store.doc.name;
    nameEl.readOnly = !actions.canEdit();
    this.$('dirty-indicator').hidden = !actions.isDirty();
    this.$('readonly-indicator').hidden = actions.canEdit();
    this.$('btn-undo').disabled = !store.canUndo() || !actions.canEdit();
    this.$('btn-redo').disabled = !store.canRedo() || !actions.canEdit();
    this.$('btn-save').textContent = actions.canEdit() ? 'Speichern' : 'Eigene Kopie';
    document.title = `${store.doc.name} – Stadtplaner`;
  }

  // --- Werkzeuge -----------------------------------------------------------------

  refreshTools() {
    const { store, tools, settings, actions } = this.ctx;
    const grid = this.$('tool-buttons');
    const editable = actions.canEdit();
    grid.innerHTML = TOOLS.map((t) => `<button type="button" class="tool${tools.tool === t.id ? ' active' : ''}" data-tool="${t.id}" title="${esc(t.hint)} (Taste ${t.key})" ${!editable && t.id !== 'select' ? 'disabled' : ''}><span class="tool-key">${t.key}</span>${esc(t.label)}</button>`).join('');
    grid.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));

    const layerSel = this.$('active-layer');
    layerSel.innerHTML = store.doc.layers.map((l) => `<option value="${l.id}"${l.id === actions.activeLayerId() ? ' selected' : ''}>${esc(l.name)}${l.visible === false ? ' (ausgeblendet)' : ''}</option>`).join('');
    layerSel.onchange = () => actions.setActiveLayer(layerSel.value);

    const kindSel = this.$('default-kind');
    kindSel.innerHTML = options(ROAD_KINDS, actions.defaultRoadKind());
    kindSel.onchange = () => actions.setDefaultRoadKind(kindSel.value);

    const snap = this.$('snap-settings');
    snap.innerHTML = `
      <label class="check"><input type="checkbox" id="set-snap" ${settings.snapEnabled ? 'checked' : ''}> Einrasten aktiv</label>
      <label class="field">Taste zum Aussetzen für die aktuelle Aktion
        <select id="set-modifier">
          <option value="Shift"${settings.snapModifier === 'Shift' ? ' selected' : ''}>Shift</option>
          <option value="Control"${settings.snapModifier === 'Control' ? ' selected' : ''}>Ctrl / Strg</option>
          <option value="Alt"${settings.snapModifier === 'Alt' ? ' selected' : ''}>Alt</option>
        </select></label>
      <label class="check"><input type="checkbox" id="set-snap-osm" ${settings.snapOsm ? 'checked' : ''}> An bestehende OSM-Strassen einrasten</label>
      <label class="check"><input type="checkbox" id="set-show-osm" ${settings.showOsm ? 'checked' : ''}> Geladene OSM-Strassen anzeigen</label>
      <label class="field">Toleranz: <span id="set-tol-val">${settings.snapTolerance}</span> px
        <input type="range" id="set-tol" min="4" max="40" value="${settings.snapTolerance}"></label>`;
    this.$('set-snap').onchange = (e) => actions.updateSettings({ snapEnabled: e.target.checked });
    this.$('set-modifier').onchange = (e) => actions.updateSettings({ snapModifier: e.target.value });
    this.$('set-snap-osm').onchange = (e) => actions.updateSettings({ snapOsm: e.target.checked });
    this.$('set-show-osm').onchange = (e) => actions.updateSettings({ showOsm: e.target.checked });
    this.$('set-tol').oninput = (e) => { this.$('set-tol-val').textContent = e.target.value; };
    this.$('set-tol').onchange = (e) => actions.updateSettings({ snapTolerance: Number(e.target.value) });
  }

  // --- Eigenschaften ---------------------------------------------------------------

  refreshProperties() {
    const { store, tools, actions } = this.ctx;
    const box = this.$('properties');
    const sel = tools.selection;
    const f = sel ? getFeature(store.doc, sel.featureId) : null;
    if (!f) {
      box.innerHTML = '<h3>Eigenschaften</h3><p class="muted">Kein Element ausgewählt. Mit dem Werkzeug „Auswählen“ ein Element anklicken.</p>';
      return;
    }
    const editable = actions.canEdit();
    const dis = editable ? '' : 'disabled';
    const layerOpts = store.doc.layers.map((l) => ({ id: l.id, label: l.name }));
    let specific = '';
    if (f.type === 'road') {
      const segIndex = Math.min(sel.segIndex ?? 0, f.segments.length - 1);
      const seg = f.segments[segIndex];
      const chips = f.segments.map((s, i) => `<button type="button" class="seg seg-${s.level}${i === segIndex ? ' active' : ''}" data-seg="${i}" title="Abschnitt ${i + 1}: ${esc(LEVELS.find((l) => l.id === s.level).label)}">${i + 1}</button>`).join('');
      specific = `
        <label class="field">Strassentyp<select id="prop-kind" ${dis}>${options(ROAD_KINDS, f.kind)}</select></label>
        <label class="field">Status<select id="prop-status" ${dis}>${options(STATUSES, f.status)}</select></label>
        <label class="check"><input type="checkbox" id="prop-oneway"${f.oneway ? ' checked' : ''} ${dis}> Einbahn (in Zeichenrichtung)</label>
        <label class="field">Tempolimit (km/h)
          <div class="speed-row">
            <input type="number" id="prop-maxspeed" min="5" max="200" step="5" value="${f.maxspeed ?? ''}" placeholder="Standard ${roadSpeed({ ...f, maxspeed: null }) || '–'}" ${dis}>
            ${[20, 30, 50, 80].map((v) => `<button type="button" class="speed${f.maxspeed === v ? ' active' : ''}" data-speed="${v}" ${dis}>${v}</button>`).join('')}
            <button type="button" class="speed${f.maxspeed ? '' : ' active'}" data-speed="" title="Standard je Strassentyp" ${dis}>Std.</button>
          </div>
        </label>
        <div class="segments">
          <div class="seg-head">Abschnitte <span class="muted">(${f.segments.length}, ${fmtLen(pathLength(f.nodes))})</span></div>
          <div class="seg-chips">${chips}</div>
          <div class="seg-nav">
            <button type="button" id="seg-prev" ${segIndex === 0 ? 'disabled' : ''}>◀</button>
            <span>Abschnitt ${segIndex + 1} von ${f.segments.length}</span>
            <button type="button" id="seg-next" ${segIndex >= f.segments.length - 1 ? 'disabled' : ''}>▶</button>
          </div>
          <div class="radio-row">
            ${LEVELS.map((l) => `<label class="radio"><input type="radio" name="seg-level" value="${l.id}"${seg.level === l.id ? ' checked' : ''} ${dis}> ${esc(l.label)}</label>`).join('')}
          </div>
          <button type="button" id="seg-apply-all" class="btn small" ${dis}>Diese Führung auf alle Abschnitte anwenden</button>
        </div>`;
    } else if (f.type === 'junction') {
      specific = `<label class="field">Art<select id="prop-jkind" ${dis}>${options(JUNCTION_KINDS, f.kind)}</select></label>`;
    } else if (f.type === 'roundabout') {
      specific = `<label class="field">Radius (m)<input type="number" id="prop-radius" min="4" max="200" step="0.5" value="${f.radius}" ${dis}></label>`;
    }
    box.innerHTML = `
      <h3>${{ road: 'Strasse', junction: 'Kreuzung', roundabout: 'Kreisel' }[f.type]} <span class="muted">${esc(featureLabel(f))}</span></h3>
      <label class="field">Name<input type="text" id="prop-name" value="${esc(f.name)}" placeholder="z. B. Hauptstrasse neu" ${dis}></label>
      <label class="field">Ebene<select id="prop-layer" ${dis}>${options(layerOpts, f.layerId)}</select></label>
      ${specific}
      <label class="field">Notiz<textarea id="prop-note" rows="2" placeholder="Begründung, Hinweise…" ${dis}>${esc(f.note)}</textarea></label>
      <div class="btn-row">
        <button type="button" id="prop-zoom" class="btn small">Hinzoomen</button>
        <button type="button" id="prop-delete" class="btn small danger" ${dis}>Löschen (Entf)</button>
      </div>`;
    const patch = (label, fn) => actions.patchFeature(f.id, label, fn);
    this.$('prop-name').onchange = (e) => patch('Name ändern', (x) => { x.name = e.target.value.trim(); });
    this.$('prop-layer').onchange = (e) => patch('Ebene wechseln', (x) => { x.layerId = e.target.value; });
    this.$('prop-note').onchange = (e) => patch('Notiz ändern', (x) => { x.note = e.target.value; });
    this.$('prop-delete').onclick = () => tools.deleteSelection();
    this.$('prop-zoom').onclick = () => actions.zoomToFeature(f.id);
    if (f.type === 'road') {
      const segIndex = Math.min(sel.segIndex ?? 0, f.segments.length - 1);
      this.$('prop-kind').onchange = (e) => patch('Strassentyp ändern', (x) => { x.kind = e.target.value; });
      this.$('prop-status').onchange = (e) => patch('Status ändern', (x) => { x.status = e.target.value; });
      this.$('prop-oneway').onchange = (e) => patch('Einbahn ändern', (x) => { x.oneway = e.target.checked; });
      const setSpeed = (v) => patch('Tempolimit ändern', (x) => { x.maxspeed = v === '' || v === null ? null : Math.max(5, Math.min(200, Math.round(Number(v) / 5) * 5)); });
      this.$('prop-maxspeed').onchange = (e) => setSpeed(e.target.value === '' ? null : e.target.value);
      box.querySelectorAll('.speed').forEach((b) => { b.onclick = () => setSpeed(b.dataset.speed === '' ? null : b.dataset.speed); });
      box.querySelectorAll('.seg').forEach((b) => { b.onclick = () => tools.setSelection({ featureId: f.id, segIndex: Number(b.dataset.seg) }); });
      this.$('seg-prev').onclick = () => tools.setSelection({ featureId: f.id, segIndex: segIndex - 1 });
      this.$('seg-next').onclick = () => tools.setSelection({ featureId: f.id, segIndex: segIndex + 1 });
      box.querySelectorAll('input[name="seg-level"]').forEach((r) => {
        r.onchange = () => patch('Führung ändern', (x) => { x.segments[segIndex].level = r.value; });
      });
      this.$('seg-apply-all').onclick = () => {
        const level = f.segments[segIndex].level;
        patch('Führung auf alle Abschnitte', (x) => x.segments.forEach((s) => { s.level = level; }));
      };
    } else if (f.type === 'junction') {
      this.$('prop-jkind').onchange = (e) => patch('Art ändern', (x) => { x.kind = e.target.value; });
    } else if (f.type === 'roundabout') {
      this.$('prop-radius').onchange = (e) => {
        const r = Math.max(4, Math.min(200, Number(e.target.value) || 15));
        patch('Radius ändern', (x) => { x.radius = Math.round(r * 10) / 10; });
      };
    }
  }

  // --- Ebenen ------------------------------------------------------------------------

  refreshLayers() {
    const { store, actions } = this.ctx;
    const list = this.$('layer-list');
    const editable = actions.canEdit();
    const counts = {};
    for (const f of store.doc.features) counts[f.layerId] = (counts[f.layerId] || 0) + 1;
    list.innerHTML = store.doc.layers.map((l, i) => `
      <div class="layer-row${l.id === actions.activeLayerId() ? ' active' : ''}" data-id="${l.id}">
        <input type="radio" name="layer-active" title="Aktive Ebene (neue Elemente landen hier)" ${l.id === actions.activeLayerId() ? 'checked' : ''}>
        <input type="checkbox" class="layer-visible" title="Ein-/ausblenden" ${l.visible !== false ? 'checked' : ''}>
        <input type="color" class="layer-color" title="Farbe" value="${esc(l.color)}" ${editable ? '' : 'disabled'}>
        <input type="text" class="layer-name" value="${esc(l.name)}" title="Name der Ebene" ${editable ? '' : 'readonly'}>
        <span class="muted count" title="Elemente">${counts[l.id] || 0}</span>
        <button type="button" class="icon-btn layer-up" title="Nach oben" ${i === 0 || !editable ? 'disabled' : ''}>▲</button>
        <button type="button" class="icon-btn layer-down" title="Nach unten" ${i === store.doc.layers.length - 1 || !editable ? 'disabled' : ''}>▼</button>
        <button type="button" class="icon-btn layer-delete" title="Ebene löschen" ${store.doc.layers.length === 1 || !editable ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    this.$('btn-add-layer').disabled = !editable;
    list.querySelectorAll('.layer-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('input[type="radio"]').onchange = () => actions.setActiveLayer(id);
      row.querySelector('.layer-visible').onchange = (e) => this.toggleLayer(id, e.target.checked);
      row.querySelector('.layer-color').onchange = (e) => actions.patchLayer(id, 'Ebenenfarbe ändern', (l) => { l.color = e.target.value; });
      row.querySelector('.layer-name').onchange = (e) => actions.patchLayer(id, 'Ebene umbenennen', (l) => { l.name = e.target.value.trim() || l.name; });
      row.querySelector('.layer-up').onclick = () => actions.moveLayer(id, -1);
      row.querySelector('.layer-down').onclick = () => actions.moveLayer(id, 1);
      row.querySelector('.layer-delete').onclick = () => actions.deleteLayer(id);
    });
  }

  /** Sichtbarkeit ist auch im Nur-Ansicht-Modus erlaubt (lokal, ohne Undo-Eintrag im Nur-Lesen-Fall). */
  toggleLayer(id, visible) {
    const { store, actions, map } = this.ctx;
    if (actions.canEdit()) {
      actions.patchLayer(id, visible ? 'Ebene einblenden' : 'Ebene ausblenden', (l) => { l.visible = visible; });
    } else {
      const l = store.doc.layers.find((x) => x.id === id);
      if (l) l.visible = visible;
      map.requestRender();
      this.refreshTools();
    }
  }

  // --- Entwürfe ------------------------------------------------------------------------

  refreshDrafts() {
    const { store, local, actions } = this.ctx;
    const s = docStats(store.doc);
    const dirty = actions.isDirty();
    const saved = actions.isSaved();
    const editable = actions.canEdit();
    let badge = '<span class="badge warn">nicht gespeichert</span>';
    if (saved && !editable) badge = '<span class="badge muted">nur Ansicht</span>';
    else if (saved && !dirty) badge = '<span class="badge ok">gespeichert</span>';
    else if (saved) badge = '<span class="badge warn">ungespeicherte Änderungen</span>';
    this.$('draft-current').innerHTML = `
      <h3>${esc(store.doc.name)} ${badge}</h3>
      <p class="muted">${s.roads} Strassen (${fmtLen(s.lengthMeters)}), ${s.junctions} Kreuzungen, ${s.roundabouts} Kreisel${s.bridges ? `, ${s.bridges} Brückenabschnitte` : ''}${s.tunnels ? `, ${s.tunnels} Tunnelabschnitte` : ''}</p>
      ${saved ? `<p class="muted small">Link: <code>${esc(location.origin)}/d/${esc(actions.draftId())}</code></p>` : ''}
      <div class="btn-row">
        <button type="button" id="d-new" class="btn small">Neu</button>
        ${editable ? '<button type="button" id="d-save" class="btn small primary">Speichern</button>' : '<button type="button" id="d-own" class="btn small primary">Eigene Kopie anlegen</button>'}
        <button type="button" id="d-copy" class="btn small">Als neuen Entwurf speichern</button>
      </div>
      <div class="btn-row">
        <button type="button" id="d-share" class="btn small">Teilen…</button>
        <button type="button" id="d-export" class="btn small">JSON exportieren</button>
        <button type="button" id="d-geojson" class="btn small">GeoJSON exportieren</button>
        <button type="button" id="d-import" class="btn small">JSON importieren</button>
      </div>
      <div class="btn-row">
        <button type="button" id="d-png" class="btn small">Karte als PNG</button>
        <button type="button" id="d-pdf" class="btn small">Karte als PDF</button>
      </div>`;
    this.$('d-new').onclick = () => actions.newDraft();
    if (this.$('d-save')) this.$('d-save').onclick = () => actions.saveDraft();
    if (this.$('d-own')) this.$('d-own').onclick = () => actions.makeOwnCopy();
    this.$('d-copy').onclick = () => actions.saveCopy();
    this.$('d-share').onclick = () => actions.share();
    this.$('d-export').onclick = () => actions.exportJson();
    this.$('d-geojson').onclick = () => actions.exportGeoJson();
    this.$('d-import').onclick = () => this.$('import-file').click();
    this.$('d-png').onclick = () => actions.exportPng();
    this.$('d-pdf').onclick = () => actions.exportPdf();

    const drafts = local.listDrafts();
    const list = this.$('draft-list');
    if (!drafts.length) {
      list.innerHTML = '<p class="muted">Noch keine Entwürfe in diesem Browser. Speichern legt den ersten an.</p>';
    } else {
      list.innerHTML = drafts.map((d) => `
        <div class="list-row${d.id === actions.draftId() ? ' active' : ''}" data-id="${d.id}">
          <div class="grow"><div class="title">${esc(d.name)} ${d.token ? '' : '<span class="badge muted">nur Ansicht</span>'}</div><div class="muted">${fmtDate(d.updatedAt)}</div></div>
          <button type="button" class="btn small d-open" ${d.id === actions.draftId() ? 'disabled' : ''}>Öffnen</button>
          <button type="button" class="icon-btn d-delete" title="Löschen / entfernen">✕</button>
        </div>`).join('');
      list.querySelectorAll('.list-row').forEach((row) => {
        row.querySelector('.d-open').onclick = () => actions.openDraft(row.dataset.id);
        row.querySelector('.d-delete').onclick = () => actions.deleteDraft(row.dataset.id);
      });
    }
    const open = this.$('open-link');
    open.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        actions.openByLink(open.value);
      }
    };
    this.$('open-link-btn').onclick = () => actions.openByLink(open.value);
  }

  // --- Verlauf ---------------------------------------------------------------------------

  refreshHistory() {
    const { store, actions } = this.ctx;
    const undoLabel = store.undoStack.length ? store.undoStack[store.undoStack.length - 1].label : '–';
    const redoLabel = store.redoStack.length ? store.redoStack[store.redoStack.length - 1].label : '–';
    const recent = store.undoStack.slice(-8).reverse();
    this.$('history-undo').innerHTML = `
      <h3>Änderungen in dieser Sitzung</h3>
      <div class="btn-row">
        <button type="button" id="h-undo" class="btn small" ${store.canUndo() && actions.canEdit() ? '' : 'disabled'}>↶ Rückgängig: ${esc(undoLabel)}</button>
        <button type="button" id="h-redo" class="btn small" ${store.canRedo() && actions.canEdit() ? '' : 'disabled'}>↷ Wiederholen: ${esc(redoLabel)}</button>
      </div>
      ${recent.length ? `<ol class="undo-list">${recent.map((e) => `<li>${esc(e.label)}</li>`).join('')}</ol>` : '<p class="muted">Noch keine Änderungen.</p>'}`;
    this.$('h-undo').onclick = () => actions.undo();
    this.$('h-redo').onclick = () => actions.redo();

    const list = this.$('version-list');
    if (!actions.isSaved()) {
      list.innerHTML = '<h3>Gespeicherte Versionen</h3><p class="muted">Jedes Speichern legt auf dem Server eine Version ab, die hier wiederhergestellt werden kann.</p>';
      return;
    }
    const token = ++this.historyToken || (this.historyToken = 1);
    actions.listVersions().then((versions) => {
      if (token !== this.historyToken) return;
      if (!versions.length) {
        list.innerHTML = '<h3>Gespeicherte Versionen</h3><p class="muted">Noch keine Versionen.</p>';
        return;
      }
      list.innerHTML = '<h3>Gespeicherte Versionen</h3>' + versions.map((v) => `
        <div class="list-row" data-n="${v.n}">
          <div class="grow"><div class="title">${esc(v.label)} <span class="muted">#${v.n}</span></div>
            <div class="muted">${fmtDate(v.at)} · ${v.stats.roads} Strassen, ${v.stats.junctions} Kreuzungen, ${v.stats.roundabouts} Kreisel</div></div>
          <button type="button" class="btn small v-restore" ${actions.canEdit() ? '' : 'disabled'}>Wiederherstellen</button>
        </div>`).join('');
      list.querySelectorAll('.v-restore').forEach((b) => {
        b.onclick = () => actions.restoreVersion(Number(b.closest('.list-row').dataset.n));
      });
    });
  }

  // --- Status, Tooltip, Banner, Toasts, Modal ----------------------------------------

  setStatus(text) {
    this.$('status-hint').textContent = text || '';
  }

  setCoords(latlng, zoom) {
    this.$('status-coords').textContent = latlng ? `${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)} · Zoom ${zoom.toFixed(1)}` : `Zoom ${zoom.toFixed(1)}`;
  }

  setOsmStatus(text, kind = '') {
    const el = this.$('status-osm');
    el.textContent = text;
    el.className = kind;
  }

  setTooltip(t) {
    const el = this.$('tooltip');
    if (!t || !t.text) {
      el.hidden = true;
      return;
    }
    el.textContent = t.text;
    el.hidden = false;
    el.style.transform = `translate(${Math.round(t.point.x + 14)}px, ${Math.round(t.point.y + 16)}px)`;
  }

  showBanner(text, actionLabel, onAction) {
    const el = this.$('banner');
    if (!text) {
      el.hidden = true;
      return;
    }
    el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button" class="btn small primary" id="banner-action">${esc(actionLabel)}</button>` : ''}<button type="button" class="icon-btn" id="banner-close" title="Schliessen">✕</button>`;
    el.hidden = false;
    if (onAction) this.$('banner-action').onclick = onAction;
    this.$('banner-close').onclick = () => { el.hidden = true; };
  }

  toast(text, kind = 'info', ms = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.$('toasts').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }

  openModal(html) {
    const modal = this.$('modal');
    modal.querySelector('.modal-body').innerHTML = html;
    modal.hidden = false;
  }

  closeModal() {
    this.$('modal').hidden = true;
  }

  openShare({ viewUrl, editUrl, doc }) {
    const subject = encodeURIComponent(`Planungsvorschlag: ${doc.name}`);
    const body = encodeURIComponent(`Hallo\n\nHier ist mein Planungsvorschlag „${doc.name}“, erstellt mit dem Stadtplaner:\n\n${viewUrl}\n\nDer Link öffnet den Entwurf direkt im Browser.\n`);
    this.openModal(`
      <h2>Entwurf teilen</h2>
      <p>Der <strong>Ansichtslink</strong> zeigt den Vorschlag; wer ihn öffnet, kann eine eigene Kopie weiterbearbeiten, dein Original bleibt unverändert.</p>
      <div class="link-row"><input type="text" id="share-url" readonly value="${esc(viewUrl)}"><button type="button" class="btn primary" data-copy="share-url">Kopieren</button></div>
      ${editUrl ? `
      <p><strong>Bearbeitungslink</strong> – nur an Personen geben, die den Entwurf direkt mitbearbeiten sollen. Wer ihn hat, kann alles ändern und löschen.</p>
      <div class="link-row"><input type="text" id="share-edit-url" readonly value="${esc(editUrl)}"><button type="button" class="btn" data-copy="share-edit-url">Kopieren</button></div>` : ''}
      <div class="btn-row">
        <a class="btn" href="mailto:?subject=${subject}&body=${body}">Per E-Mail senden</a>
        <button type="button" id="share-json" class="btn">JSON herunterladen</button>
        <button type="button" id="share-geojson" class="btn">GeoJSON herunterladen</button>
        <button type="button" id="share-png" class="btn">Karte als PNG</button>
        <button type="button" id="share-pdf" class="btn">Karte als PDF</button>
        <button type="button" class="btn" data-close>Schliessen</button>
      </div>`);
    document.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        const input = this.$(b.dataset.copy);
        try {
          await navigator.clipboard.writeText(input.value);
          this.toast('Link kopiert.', 'ok');
        } catch {
          input.select();
          this.toast('Link markiert – mit Ctrl+C kopieren.');
        }
      };
    });
    this.$('share-json').onclick = () => this.ctx.actions.exportJson();
    this.$('share-geojson').onclick = () => this.ctx.actions.exportGeoJson();
    this.$('share-png').onclick = () => this.ctx.actions.exportPng();
    this.$('share-pdf').onclick = () => this.ctx.actions.exportPdf();
  }

  // --- Routen-Rechner --------------------------------------------------------------

  refreshRoute() {
    const { store, actions, tools } = this.ctx;
    const el = this.$('route-panel');
    if (!el) return;
    const q = store.doc.route;
    const routes = actions.routes();
    const net = actions.routeNetworkStatus();
    const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
    const diff = (a, b, fmt, unit) => {
      if (!a || !b) return '–';
      const d = b - a;
      const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
      return `${sign}${fmt(Math.abs(d))}${unit || ''}`;
    };
    const cur = routes && routes.current && !routes.current.error ? routes.current : null;
    const neu = routes && routes.proposed && !routes.proposed.error ? routes.proposed : null;
    let body = '';
    if (!q) {
      body = `<p class="muted">${tools.routeDraft ? 'Start gesetzt – jetzt das Ziel auf der Karte anklicken.' : 'Start und Ziel auf der Karte anklicken (Werkzeug „Route“, Taste T).'}</p>`;
    } else if (!routes) {
      body = '<p class="muted">Berechne…</p>';
    } else {
      body = `
        <table class="route-table">
          <thead><tr><th></th><th><span class="dot" style="background:#1b6ac9"></span>Heute</th><th><span class="dot" style="background:#2a9d3f"></span>Neu</th><th>Differenz</th></tr></thead>
          <tbody>
            <tr><td>Distanz</td><td>${cur ? fmtKm(cur.dist) : '–'}</td><td>${neu ? fmtKm(neu.dist) : '–'}</td><td>${diff(cur && cur.dist, neu && neu.dist, fmtKm)}</td></tr>
            <tr><td>Fahrzeit</td><td>${cur ? formatDuration(cur.time) : '–'}</td><td>${neu ? formatDuration(neu.time) : '–'}</td><td>${diff(cur && cur.time, neu && neu.time, formatDuration)}</td></tr>
          </tbody>
        </table>
        ${routes.current && routes.current.error ? `<p class="muted small">Heute: ${esc(routes.current.error)}</p>` : ''}
        ${routes.proposed && routes.proposed.error ? `<p class="muted small">Neu: ${esc(routes.proposed.error)}</p>` : ''}`;
    }
    el.innerHTML = `
      <p class="muted small">Schnellste Fahrroute im heutigen Strassennetz (OpenStreetMap) verglichen mit dem Netz inklusive deiner Änderungen: neue Strassen kommen dazu, Rückbau fällt weg, übernommene Strassen zählen mit ihren Änderungen. Fahrzeit aus Tempolimits (OSM maxspeed oder Standard je Strassentyp); gezeichnete Ampeln +20 s, Stop +8 s, Vortritt +3 s.</p>
      ${body}
      <div class="btn-row">
        <button type="button" id="route-tool" class="btn small ${tools.tool === 'route' ? 'primary' : ''}">Punkte setzen</button>
        <button type="button" id="route-swap" class="btn small" ${q ? '' : 'disabled'}>A ↔ B</button>
        <button type="button" id="route-clear" class="btn small" ${q || tools.routeDraft ? '' : 'disabled'}>Löschen</button>
        <button type="button" id="route-load" class="btn small">Netz für Ansicht laden</button>
      </div>
      <p class="muted small" id="route-net">${esc(net)}</p>`;
    this.$('route-tool').onclick = () => tools.setTool('route');
    this.$('route-swap').onclick = () => actions.swapRoute();
    this.$('route-clear').onclick = () => actions.clearRoute();
    this.$('route-load').onclick = () => actions.loadRouteNetwork();
  }
}
