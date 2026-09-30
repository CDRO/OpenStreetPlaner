// Einstiegspunkt: verdrahtet Karte, Zustand, Werkzeuge, Server-API und UI.

import { SlippyMap } from './map.js';
import { drawScene } from './draw.js';
import { Store } from './store.js';
import { LocalState } from './local.js';
import { api } from './api.js';
import {
  cloneDocument, createDocument, createLayer, deserialize, getFeature, getLayer, moveLayer, removeLayer, toGeoJSON,
} from './model.js';
import { buildSnapIndex } from './snap.js';
import { OSM_MIN_ZOOM, OSM_MAX_SPAN, OsmRoadCache, routeBounds } from './osm.js';
import { ToolController, TOOLS } from './tools.js';
import { UI } from './ui.js';
import { computeRoutes } from './routing.js';
import { exportPdf, exportPng } from './export.js';

const contentKey = (doc) => JSON.stringify({ name: doc.name, layers: doc.layers, features: doc.features });

function download(filename, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFilename = (name) => (name || 'entwurf').replace(/[^\wäöüÄÖÜ.-]+/g, '_').slice(0, 60);

function parseLocation() {
  const m = /^\/d\/([0-9a-z]{6,32})\/?$/.exec(location.pathname);
  const id = m ? m[1] : null;
  const t = /(?:^#|&)edit=([0-9a-f]{16,128})/.exec(location.hash);
  return { id, token: t ? t[1] : null };
}

async function main() {
  const local = new LocalState();
  const settings = local.loadSettings();
  const state = {
    id: null,
    token: null,
    savedKey: null,
    serverUpdatedAt: null,
    activeLayerId: null,
    defaultRoadKind: 'main',
    snapIndex: null,
    pickIndex: null,
    snapDirty: true,
    searchMarker: null,
    routes: null,
    routeTimer: null,
  };

  // --- Entwurf bestimmen: Link (/d/<id>) > Arbeitskopie > neuer Entwurf --------
  let doc = null;
  let openedFromLink = false;
  let loadError = null;
  const loc = parseLocation();
  if (loc.id) {
    try {
      const res = await api.getDraft(loc.id);
      doc = deserialize(JSON.stringify(res.doc));
      state.id = loc.id;
      state.serverUpdatedAt = res.updatedAt;
      if (loc.token) {
        try {
          await api.authDraft(loc.id, loc.token);
          local.rememberDraft({ id: loc.id, name: doc.name, token: loc.token, updatedAt: res.updatedAt });
        } catch {
          loadError = 'Der Bearbeitungs-Link ist ungültig; der Entwurf wird nur angezeigt.';
        }
        history.replaceState(null, '', `/d/${loc.id}`);
      }
      state.token = local.tokenFor(loc.id);
      state.savedKey = contentKey(doc);
      openedFromLink = true;
    } catch (e) {
      loadError = `Entwurf ${loc.id} konnte nicht geladen werden: ${e.message}`;
      history.replaceState(null, '', '/');
    }
  }
  if (!doc) {
    const working = local.loadWorking();
    if (working && working.doc) {
      try {
        doc = deserialize(JSON.stringify(working.doc));
        state.id = working.id || null;
        state.token = state.id ? local.tokenFor(state.id) : null;
        state.savedKey = working.savedKey || null;
        if (state.id) history.replaceState(null, '', `/d/${state.id}`);
      } catch {
        doc = null;
      }
    }
  }
  if (!doc) doc = createDocument();
  state.activeLayerId = doc.layers[0].id;

  const store = new Store(doc);
  const map = new SlippyMap(document.getElementById('map'), {
    center: doc.view.center,
    zoom: doc.view.zoom,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
  });
  const osm = new OsmRoadCache((b) => api.roads(b));

  const canEdit = () => !state.id || !!state.token;

  const getSnapIndex = () => {
    if (state.snapDirty || !state.snapIndex) {
      state.snapIndex = buildSnapIndex(store.doc, { osmWays: osm.list(), includeOsm: settings.snapOsm });
      state.pickIndex = buildSnapIndex(store.doc, { includeOsm: false });
      state.snapDirty = false;
    }
    return state.snapIndex;
  };
  const getPickIndex = () => {
    getSnapIndex();
    return state.pickIndex;
  };

  let ui = null;
  const tools = new ToolController({
    map,
    store,
    getSnapIndex,
    getPickIndex,
    getSettings: () => settings,
    getActiveLayerId: () => state.activeLayerId,
    getDefaultRoadKind: () => state.defaultRoadKind,
    getOsmWay: (id) => osm.get(id),
    canEdit,
    onSelectionChange: (sel) => {
      if (!ui) return;
      ui.refreshProperties();
      if (sel) ui.showTab('draw'); // Eigenschaften liegen im Zeichnen-Tab
    },
    onToolChange: () => ui && ui.refreshTools(),
    onStatus: (text) => ui && ui.setStatus(text),
    onSceneChange: () => map.requestRender(),
    onHoverChange: (h) => ui && ui.setTooltip(h ? { text: hoverText(h), point: h.point } : null),
    toast: (text) => ui && ui.toast(text),
  });

  function hoverText(h) {
    const f = getFeature(store.doc, h.featureId);
    if (!f) return '';
    const base = f.name || { road: 'Strasse', junction: 'Kreuzung', roundabout: 'Kreisel' }[f.type];
    if (f.type === 'road' && h.segIndex !== null) {
      const level = f.segments[h.segIndex] && f.segments[h.segIndex].level;
      return level && level !== 'ground' ? `${base} · ${level === 'bridge' ? 'Brücke' : 'Tunnel'}` : base;
    }
    if (f.type === 'roundabout') return `${base} · r = ${f.radius} m`;
    return base;
  }

  map.setOverlay((ctx) => drawScene(ctx, map, {
    doc: store.doc,
    selection: tools.selection,
    osmWays: osm.list(),
    showOsm: settings.showOsm,
    preview: tools.preview,
    snap: tools.snapPoint,
    showHandles: tools.tool === 'select' && canEdit(),
    routes: store.doc.route ? state.routes : null,
    routeDraft: tools.routeDraft,
  }));

  // --- Routen-Rechner ----------------------------------------------------------
  function recomputeRoutes() {
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => {
      const q = store.doc.route;
      if (!q) {
        state.routes = null;
      } else {
        try {
          state.routes = computeRoutes({ osmWays: osm.list(), doc: store.doc, from: q.from, to: q.to });
        } catch (e) {
          state.routes = { current: { error: e.message }, proposed: { error: e.message } };
        }
      }
      map.requestRender();
      if (ui) ui.refreshRoute();
    }, 120);
  }

  function ensureRouteNetwork() {
    const q = store.doc.route;
    if (!q) return;
    const b = routeBounds(q.from, q.to);
    if (b.tooLarge) {
      ui.toast(`Start und Ziel liegen zu weit auseinander (max. ${OSM_MAX_SPAN}° pro Abfrage). Näher zusammenliegende Punkte wählen.`, 'error', 6000);
      return;
    }
    osm.ensureArea(b);
  }

  // --- Aktionen für die Oberfläche ---------------------------------------------
  const actions = {
    activeLayerId: () => state.activeLayerId,
    defaultRoadKind: () => state.defaultRoadKind,
    draftId: () => state.id,
    canEdit,
    isDirty: () => contentKey(store.doc) !== state.savedKey,
    isSaved: () => !!state.id,
    setActiveLayer(id) {
      if (!getLayer(store.doc, id)) return;
      state.activeLayerId = id;
      ui.refreshTools();
      ui.refreshLayers();
    },
    setDefaultRoadKind(kind) {
      state.defaultRoadKind = kind;
    },
    updateSettings(patch) {
      Object.assign(settings, patch);
      local.saveSettings(settings);
      state.snapDirty = true;
      if ('showOsm' in patch || 'snapOsm' in patch) ensureOsm();
      map.requestRender();
      ui.refreshTools();
      updateOsmStatus();
    },
    requireEdit() {
      if (canEdit()) return true;
      ui.toast('Nur Ansicht: Lege zuerst eine eigene Kopie an.');
      return false;
    },
    rename(name) {
      const clean = name.trim();
      if (!clean || clean === store.doc.name) return ui.refreshHeader();
      if (!actions.requireEdit()) return ui.refreshHeader();
      store.commit('Entwurf umbenennen', (d) => { d.name = clean; });
    },
    undo() {
      if (!actions.requireEdit()) return;
      const label = store.undo();
      if (label) ui.toast(`Rückgängig: ${label}`);
    },
    redo() {
      if (!actions.requireEdit()) return;
      const label = store.redo();
      if (label) ui.toast(`Wiederholt: ${label}`);
    },
    patchFeature(id, label, fn) {
      if (!actions.requireEdit()) return;
      store.commit(label, (d) => {
        const f = getFeature(d, id);
        if (f) fn(f);
      });
    },
    patchLayer(id, label, fn) {
      if (!actions.requireEdit()) return;
      store.commit(label, (d) => {
        const l = getLayer(d, id);
        if (l) fn(l);
      });
    },
    addLayer() {
      if (!actions.requireEdit()) return;
      const name = prompt('Name der neuen Ebene:', `Ebene ${store.doc.layers.length + 1}`);
      if (name === null) return;
      let id = null;
      store.commit('Ebene hinzufügen', (d) => { id = createLayer(d, name.trim() || undefined).id; });
      if (id) actions.setActiveLayer(id);
    },
    moveLayer(id, delta) {
      if (!actions.requireEdit()) return;
      store.commit('Ebene verschieben', (d) => moveLayer(d, id, delta));
    },
    deleteLayer(id) {
      if (!actions.requireEdit() || store.doc.layers.length <= 1) return;
      const count = store.doc.features.filter((f) => f.layerId === id).length;
      const layer = getLayer(store.doc, id);
      if (count && !confirm(`Ebene „${layer.name}“ mit ${count} Element(en) löschen?`)) return;
      store.commit('Ebene löschen', (d) => removeLayer(d, id));
    },
    zoomToFeature(id) {
      const f = getFeature(store.doc, id);
      if (!f) return;
      if (f.type === 'road') {
        const lats = f.nodes.map((n) => n[0]);
        const lngs = f.nodes.map((n) => n[1]);
        map.fitBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) }, { padding: 60, maxZoom: 18 });
      } else if (f.type === 'junction') {
        map.flyTo(f.at, Math.max(map.getZoom(), 17));
      } else if (f.type === 'roundabout') {
        map.flyTo(f.center, 18);
      }
    },
    confirmDiscard() {
      return !actions.isDirty() || store.doc.features.length === 0 || confirm('Der aktuelle Entwurf hat ungespeicherte Änderungen. Trotzdem fortfahren?');
    },
    newDraft() {
      if (!actions.confirmDiscard()) return;
      bind(null, null);
      loadDocument(createDocument({ center: map.getCenter(), zoom: map.getZoom() }), { keepView: true });
      history.replaceState(null, '', '/');
      ui.toast('Neuer Entwurf angelegt.');
    },
    async saveDraft(label) {
      store.doc.view = currentView();
      try {
        if (state.id && state.token) {
          if (label === undefined) {
            label = prompt('Kurze Beschreibung dieser Version (optional):', '') ?? '';
          }
          const res = await api.saveDraft(state.id, state.token, store.doc, label || 'Gespeichert');
          state.serverUpdatedAt = res.updatedAt;
        } else if (state.id && !state.token) {
          return actions.makeOwnCopy();
        } else {
          const res = await api.createDraft(store.doc, label || 'Erste Version');
          bind(res.id, res.editToken);
          history.replaceState(null, '', `/d/${res.id}`);
          state.serverUpdatedAt = res.updatedAt;
        }
        state.savedKey = contentKey(store.doc);
        local.rememberDraft({ id: state.id, name: store.doc.name, token: state.token, updatedAt: state.serverUpdatedAt });
        saveWorking();
        ui.refreshAll();
        ui.toast(`„${store.doc.name}“ gespeichert.`, 'ok');
      } catch (e) {
        ui.toast(`Speichern fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    async makeOwnCopy() {
      if (!state.id) return actions.saveDraft();
      try {
        const name = prompt('Name deiner Kopie:', `${store.doc.name} (Kopie)`);
        if (name === null) return;
        const res = await api.forkDraft(state.id, name.trim());
        const copy = deserialize(JSON.stringify(res.doc));
        bind(res.id, res.editToken);
        loadDocument(copy, { keepView: true });
        state.savedKey = contentKey(copy);
        local.rememberDraft({ id: res.id, name: copy.name, token: res.editToken });
        history.replaceState(null, '', `/d/${res.id}`);
        saveWorking();
        ui.showBanner(null);
        ui.refreshAll();
        ui.toast('Eigene Kopie angelegt – du kannst jetzt bearbeiten.', 'ok');
      } catch (e) {
        ui.toast(`Kopie fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    async saveCopy() {
      if (!state.id) return actions.saveDraft();
      const name = prompt('Name der Kopie:', `${store.doc.name} (Kopie)`);
      if (name === null) return;
      const copy = cloneDocument(store.doc);
      copy.name = name.trim() || copy.name;
      try {
        const res = await api.createDraft(copy, 'Kopie angelegt');
        bind(res.id, res.editToken);
        loadDocument(deserialize(JSON.stringify(res.doc)), { keepView: true });
        state.savedKey = contentKey(store.doc);
        local.rememberDraft({ id: res.id, name: copy.name, token: res.editToken, updatedAt: res.updatedAt });
        history.replaceState(null, '', `/d/${res.id}`);
        saveWorking();
        ui.refreshAll();
        ui.toast(`Kopie „${copy.name}“ gespeichert.`, 'ok');
      } catch (e) {
        ui.toast(`Kopie fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    openDraft(id) {
      if (!actions.confirmDiscard()) return;
      saveWorking();
      location.href = `/d/${id}`;
    },
    openByLink(text) {
      const m = /([0-9a-z]{6,32})(?:\/?(?:#.*)?)?$/.exec(text.trim());
      if (!m) return ui.toast('Das sieht nicht nach einem Entwurfs-Link aus.', 'error');
      const hash = /#(edit=[0-9a-f]+)/.exec(text);
      if (!actions.confirmDiscard()) return;
      location.href = `/d/${m[1]}${hash ? '#' + hash[1] : ''}`;
    },
    async deleteDraft(id) {
      const entry = local.getDraft(id);
      if (!entry) return;
      const own = !!entry.token;
      const msg = own
        ? `Entwurf „${entry.name}“ auf dem Server samt Versionen endgültig löschen?`
        : `„${entry.name}“ aus deiner Liste entfernen? (Der Entwurf bleibt auf dem Server, du hast kein Bearbeitungsrecht.)`;
      if (!confirm(msg)) return;
      try {
        if (own) await api.deleteDraft(id, entry.token);
      } catch (e) {
        if (e.status !== 404) return ui.toast(`Löschen fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
      local.forgetDraft(id);
      if (id === state.id) {
        bind(null, null);
        state.savedKey = null;
        history.replaceState(null, '', '/');
      }
      ui.refreshAll();
    },
    async listVersions() {
      if (!state.id) return [];
      try {
        return await api.versions(state.id);
      } catch {
        return [];
      }
    },
    async restoreVersion(n) {
      if (!actions.requireEdit() || !state.id) return;
      try {
        const v = await api.version(state.id, n);
        const restored = deserialize(JSON.stringify(v.doc));
        store.commit(`Version ${n} wiederherstellen`, (d) => {
          d.layers = restored.layers;
          d.features = restored.features;
        });
        ui.toast('Version wiederhergestellt (mit Rückgängig widerrufbar).');
      } catch (e) {
        ui.toast(`Version konnte nicht geladen werden: ${e.message}`, 'error');
      }
    },
    exportJson() {
      store.doc.view = currentView();
      download(`${safeFilename(store.doc.name)}.stadtplaner.json`, JSON.stringify(store.doc, null, 2));
    },
    exportGeoJson() {
      download(`${safeFilename(store.doc.name)}.geojson`, JSON.stringify(toGeoJSON(store.doc), null, 2), 'application/geo+json');
    },
    async importFile(file) {
      try {
        const d = deserialize(await file.text());
        if (!actions.confirmDiscard()) return;
        bind(null, null);
        loadDocument(d);
        history.replaceState(null, '', '/');
        ui.toast(`„${d.name}“ importiert – speichern, um ihn auf dem Server abzulegen.`);
      } catch (e) {
        ui.toast(`Import fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    async share() {
      if (!state.id || actions.isDirty()) {
        if (!canEdit()) return ui.openShare({ viewUrl: `${location.origin}/d/${state.id}`, editUrl: null, doc: store.doc });
        await actions.saveDraft(state.id ? 'Vor dem Teilen gespeichert' : undefined);
        if (!state.id) return;
      }
      ui.openShare({
        viewUrl: `${location.origin}/d/${state.id}`,
        editUrl: state.token ? `${location.origin}/d/${state.id}#edit=${state.token}` : null,
        doc: store.doc,
      });
    },
    routes: () => (store.doc.route ? state.routes : null),
    routeNetworkStatus() {
      if (osm.pending) return 'Strassennetz wird geladen…';
      if (osm.lastError) return `Strassennetz: ${osm.lastError.message}`;
      return osm.ways.size ? `${osm.ways.size} OSM-Strassen im Speicher.` : 'Noch kein Strassennetz geladen – Start und Ziel setzen oder „Netz für Ansicht laden“.';
    },
    swapRoute() {
      const q = store.doc.route;
      if (!q) return;
      store.commit('Route umkehren', (d) => { d.route = { from: q.to, to: q.from }; });
    },
    clearRoute() {
      tools.routeDraft = null;
      if (store.doc.route) store.commit('Route löschen', (d) => { d.route = null; });
      else {
        map.requestRender();
        ui.refreshRoute();
      }
    },
    loadRouteNetwork() {
      const b = map.getBounds();
      if (b.north - b.south > OSM_MAX_SPAN || b.east - b.west > OSM_MAX_SPAN) {
        ui.toast(`Ansicht zu gross (max. ${OSM_MAX_SPAN}° pro Abfrage) – näher heranzoomen.`, 'error', 5000);
        return;
      }
      osm.ensureArea(b);
      ui.refreshRoute();
    },
    async exportPng() {
      try {
        const blob = await exportPng(map, store.doc, { routes: actions.routes(), link: state.id ? `${location.origin}/d/${state.id}` : '' });
        download(`${safeFilename(store.doc.name)}.png`, blob);
      } catch (e) {
        ui.toast(`PNG-Export fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    async exportPdf() {
      try {
        const blob = await exportPdf(map, store.doc, { routes: actions.routes(), link: state.id ? `${location.origin}/d/${state.id}` : '' });
        download(`${safeFilename(store.doc.name)}.pdf`, blob);
      } catch (e) {
        ui.toast(`PDF-Export fehlgeschlagen: ${e.message}`, 'error', 6000);
      }
    },
    search: (q) => api.search(q),
    goTo(result) {
      if (result.bbox) {
        map.fitBounds({ south: result.bbox[0], north: result.bbox[1], west: result.bbox[2], east: result.bbox[3] }, { maxZoom: 17 });
      } else {
        map.flyTo([result.lat, result.lng], 17);
      }
      ui.setPin({ latlng: [result.lat, result.lng], label: result.label });
    },
    locate() {
      if (!navigator.geolocation) return ui.toast('Standortbestimmung nicht verfügbar.', 'error');
      navigator.geolocation.getCurrentPosition(
        (pos) => map.flyTo([pos.coords.latitude, pos.coords.longitude], 16),
        () => ui.toast('Standort konnte nicht bestimmt werden.', 'error'),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    },
  };

  function bind(id, token) {
    state.id = id;
    state.token = token;
    state.serverUpdatedAt = null;
  }

  function currentView() {
    const c = map.getCenter();
    return { center: [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6], zoom: Math.round(map.getZoom() * 100) / 100 };
  }

  function loadDocument(d, { keepView = false } = {}) {
    tools.cancel();
    tools.setSelection(null);
    store.load(d);
    state.activeLayerId = d.layers[0].id;
    state.savedKey = null;
    if (!keepView && d.view) map.setView(d.view.center, d.view.zoom);
  }

  function saveWorking() {
    store.doc.view = currentView();
    local.saveWorking({ doc: store.doc, id: state.id, savedKey: state.savedKey });
  }

  function ensureOsm() {
    if (!settings.snapOsm && !settings.showOsm) return;
    osm.ensure(map.getBounds(), map.getZoom());
  }

  function updateOsmStatus(info) {
    const zoom = map.getZoom();
    if (!settings.snapOsm && !settings.showOsm) return ui.setOsmStatus('');
    if (zoom < OSM_MIN_ZOOM) return ui.setOsmStatus(`OSM-Strassen ab Zoom ${OSM_MIN_ZOOM}`, 'muted');
    if (info && info.status === 'loading') return ui.setOsmStatus('Lade OSM-Strassen…', 'muted');
    if (info && info.status === 'error') return ui.setOsmStatus(`OSM-Strassen: ${info.error.message}`, 'error');
    ui.setOsmStatus(`${osm.ways.size} OSM-Strassen geladen`, 'ok');
  }

  ui = new UI({ store, local, settings, tools, actions, map });

  // --- Reaktionen auf Änderungen ------------------------------------------------
  let autosaveTimer = null;
  const scheduleAutosave = () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveWorking, 400);
  };

  store.subscribe((d, event) => {
    if (event.type !== 'meta') {
      state.snapDirty = true;
      if (tools.selection && !getFeature(d, tools.selection.featureId)) tools.selection = null;
      if (tools.hover && !getFeature(d, tools.hover.featureId)) tools.setHover(null);
      if (!getLayer(d, state.activeLayerId)) state.activeLayerId = d.layers[0].id;
      map.requestRender();
      ui.refreshAll();
      if (d.route) ensureRouteNetwork();
      recomputeRoutes();
    }
    scheduleAutosave();
  });

  osm.subscribe((info) => {
    state.snapDirty = true;
    map.requestRender();
    updateOsmStatus(info);
    if (info.status !== 'loading') recomputeRoutes();
    ui.refreshRoute();
  });

  map.on('moveend', () => {
    scheduleAutosave();
    ensureOsm();
    updateOsmStatus();
    ui.setCoords(null, map.getZoom());
  });
  map.on('pointermove', (e) => ui.setCoords(e.latlng, map.getZoom()));
  map.on('zoom', () => ui.setCoords(null, map.getZoom()));

  // --- Tastatur -----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (!ui.$('modal').hidden) return ui.closeModal();
      if (typing) return target.blur();
      if (tools.cancel()) return undefined;
      if (tools.tool === 'route' && store.doc.route) return actions.clearRoute();
      return undefined;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (typing) target.blur();
      return actions.saveDraft();
    }
    if (typing) return;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? actions.redo() : actions.undo();
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return actions.redo();
    }
    if (ctrl) return;
    if (e.key === 'Enter') return tools.finish();
    if (e.key === 'Backspace') {
      if (tools.popVertex()) e.preventDefault();
      return;
    }
    if (e.key === 'Delete') return tools.deleteSelection();
    const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
    if (tool && !e.altKey) tools.setTool(tool.id);
  });

  window.addEventListener('beforeunload', saveWorking);

  // --- Start ----------------------------------------------------------------------
  window.stadtplaner = { map, store, tools, local, osm, settings, actions, api, routes: () => state.routes };
  ui.refreshAll();
  if (store.doc.route) {
    ensureRouteNetwork();
    recomputeRoutes();
  }
  ui.setStatus(TOOLS[0].hint);
  ui.setCoords(null, map.getZoom());
  ensureOsm();
  updateOsmStatus();
  if (loadError) ui.toast(loadError, 'error', 8000);
  if (openedFromLink && !canEdit()) {
    ui.showBanner('Nur Ansicht: Dieser Entwurf wurde mit dir geteilt. Lege eine eigene Kopie an, um ihn zu bearbeiten.', 'Eigene Kopie anlegen', () => actions.makeOwnCopy());
  } else if (openedFromLink) {
    ui.showTab('drafts');
  }
}

main().catch((e) => {
  console.error(e);
  alert(`Der Stadtplaner konnte nicht starten: ${e.message}`);
});
