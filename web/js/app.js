// Einstiegspunkt: verdrahtet Karte, Zustand, Werkzeuge, Server-API und UI.

import { SlippyMap } from './map.js';
import { drawScene } from './draw.js';
import { Store } from './store.js';
import { LocalState } from './local.js';
import { api, setClientId } from './api.js';
import {
  cloneDocument, createBusLine, createDocument, createLayer, deserialize, getFeature, getLayer, moveLayer, removeLayer, toGeoJSON, adoptBusRoute, MAX_BUS_LINES, featureLabel, STATUSES, LEVELS, ROAD_ACCESS, docForPhase, createPhase, removePhase, phaseLabel, featureInPhase,
} from './model.js';
import { buildSnapIndex } from './snap.js';
import { MAX_CELLS, OSM_MIN_ZOOM, OsmRoadCache, OsmTransitCache, cellsFor, routeBounds } from './osm.js';
import { ToolController, TOOLS } from './tools.js';
import { UI } from './ui.js';
import { buildGraphs, computeBusLines, computeIsochrone, computeRoutes, routeOnGraph } from './routing.js';
import { smoothRoad, simplifyRoad } from './smooth.js';
import { nodesKey, newId } from './model.js';
import { exportPdf, exportPng, exportReport } from './export.js';
import { estimateCosts } from './costs.js';
import { runChecks } from './checks.js';
import { summarizeParcels, validParcels } from './parcels.js';
import { applyImport, parseImport } from './importer.js';
import { diffDocuments } from './diff.js';
import { applyStatic, detectLanguage, setLanguage, t, tn } from './i18n.js';
import { exposure as computeExposure } from './buildings.js';
import { costConfidence, staticConfidence, travelTimeConfidence } from './confidence.js';
import { parkingBalance } from './parking.js';
import { compareVariants } from './variants.js';
import { currentSubscription, permissionState, pushSupported, registerWorker, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from './push.js';

const POLL_INTERVAL_MS = 45000;

const contentKey = (doc) => JSON.stringify({ name: doc.name, layers: doc.layers, features: doc.features, costs: doc.costs || {}, routePairs: doc.routePairs || [], isochrone: doc.isochrone || null, busLines: doc.busLines || [], phases: doc.phases || [] });

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

// Chromium verwirft Download-Namen mit Nicht-ASCII-Zeichen (dann heisst die Datei „download“), deshalb Umlaute umschreiben.
const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', é: 'e', è: 'e', ê: 'e', à: 'a', â: 'a', ç: 'c' };
const safeFilename = (name) => (name || 'entwurf')
  .replace(/[äöüÄÖÜßéèêàâç]/g, (c) => TRANSLIT[c])
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'entwurf';

function parseLocation() {
  const m = /^\/d\/([0-9a-z]{6,32})\/?$/.exec(location.pathname);
  const id = m ? m[1] : null;
  const t = /(?:^#|&)edit=([0-9a-f]{16,128})/.exec(location.hash);
  const c = /(?:^#|&)comment=([0-9a-z]{6,32})/.exec(location.hash);
  const present = !!id && new URLSearchParams(location.search).get('present') === '1';
  return { id, token: t ? t[1] : null, comment: c ? c[1] : null, present };
}

async function main() {
  const local = new LocalState();
  const settings = local.loadSettings();
  const loc = parseLocation();
  setClientId(local.clientId());
  if (!settings.language) settings.language = detectLanguage();
  setLanguage(settings.language);
  applyStatic();
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
    pairResults: [],
    busResults: [],
    variants: null, // Variantenvergleich (auf Knopfdruck)
    phaseView: null, // Ansicht „bis Etappe“ (ID) oder null = Endzustand
    iso: null,
    routeTimer: null,
    defaultZoneKind: 'tempo30',
    comments: [],
    activeCommentId: null,
    commentsLoadedFor: null,
    knownCommentIds: null,
    replyTo: null,
    pendingComment: loc.comment,
    push: { serverEnabled: false, publicKey: '', subscribed: false, role: null },
    clientId: local.clientId(),
    parcelGeoms: new Map(), // Parzellen-Umringe je EGRID/ID für die Hervorhebung (nur in dieser Sitzung)
    showExposure: false, // betroffene Gebäude auf der Karte hervorheben
    diff: null, // Versionsvergleich { a, b, result }
    showDiff: false,
    present: loc.present, // Präsentationsmodus: nur Karte, Legende und Routenvergleich
    events: null, // EventSource für Live-Änderungen
    remoteUpdate: null, // Serverstand, der neuer ist als unserer
    tileSources: [{ id: 'osm', label: 'OpenStreetMap', attribution: '© OpenStreetMap-Mitwirkende', maxZoom: 19, minZoom: 0, overlay: false }],
  };

  // --- Entwurf bestimmen: Link (/d/<id>) > Arbeitskopie > neuer Entwurf --------
  let doc = null;
  let openedFromLink = false;
  let loadError = null;
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
          loadError = t('Der Bearbeitungs-Link ist ungültig; der Entwurf wird nur angezeigt.');
        }
        history.replaceState(null, '', `/d/${loc.id}${loc.present ? '?present=1' : ''}`);
      } else if (loc.comment) {
        history.replaceState(null, '', `/d/${loc.id}${loc.present ? '?present=1' : ''}`);
      }
      state.token = local.tokenFor(loc.id);
      state.savedKey = contentKey(doc);
      openedFromLink = true;
    } catch (e) {
      loadError = t('Entwurf {id} konnte nicht geladen werden: {error}', { id: loc.id, error: e.message });
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
  // Darstellung: hell, dunkel oder wie das System; Kacheln folgen invertiert (nur am Bildschirm)
  const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => settings.theme === 'dark' || (settings.theme !== 'light' && !!(darkMedia && darkMedia.matches));
  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
    else delete root.dataset.theme;
    map.setDarkTiles(isDark());
  }
  applyTheme();
  if (darkMedia && darkMedia.addEventListener) darkMedia.addEventListener('change', () => applyTheme());
  const osm = new OsmRoadCache((b) => api.roads(b));
  const buildings = new OsmRoadCache((b) => api.buildings(b)); // gleiche Zellen-Logik, andere Daten
  const transit = new OsmTransitCache((b) => api.transit(b)); // Haltestellen und Buslinien aus OSM
  const parking = new OsmRoadCache((b) => api.parking(b)); // Parkplätze aus OSM (amenity=parking)

  const canEdit = () => !state.present && (!state.id || !!state.token);

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
    getTransitStops: () => transit.stopList(),
    getDefaultZoneKind: () => state.defaultZoneKind,
    getComments: () => (settings.showComments ? state.comments : []),
    canEdit,
    onSelectionChange: (sel) => {
      if (!ui) return;
      ui.refreshProperties();
      if (sel) ui.showTab('draw'); // Eigenschaften liegen im Zeichnen-Tab
    },
    onToolChange: () => {
      if (!ui) return;
      ui.refreshTools();
      ui.refreshDrawActions();
    },
    onStatus: (text) => ui && ui.setStatus(text),
    onSceneChange: () => {
      map.requestRender();
      if (ui) ui.refreshDrawActions();
    },
    onHoverChange: (h) => ui && ui.setTooltip(h ? { text: hoverText(h), point: h.point } : null),
    onCommentPlace: (latlng) => {
      if (!ui) return;
      if (latlng && !state.id) {
        tools.clearCommentDraft();
        ui.toast(t('Kommentare brauchen einen gespeicherten Entwurf. Zuerst speichern.'), 'error', 5000);
        return;
      }
      ui.showTab('comments');
      ui.refreshComments();
    },
    toast: (text) => ui && ui.toast(text),
    onMenu: (info) => ui && showMenuFor(info),
  });

  function hoverText(h) {
    if (h.commentId) {
      const c = state.comments.find((x) => x.id === h.commentId);
      return c ? `${c.author}: ${c.text.length > 80 ? c.text.slice(0, 80) + '…' : c.text}` : '';
    }
    const f = getFeature(store.doc, h.featureId);
    if (!f) return '';
    const base = f.name || t({ road: 'Strasse', junction: 'Kreuzung', roundabout: 'Kreisel', zone: 'Fläche' }[f.type]);
    if (f.type === 'road' && h.segIndex !== null) {
      const level = f.segments[h.segIndex] && f.segments[h.segIndex].level;
      return level && level !== 'ground' ? `${base} · ${level === 'bridge' ? t('Brücke') : t('Tunnel')}` : base;
    }
    if (f.type === 'roundabout') return `${base} · r = ${f.radius} m`;
    if (f.type === 'zone') return f.name ? `${f.name} · ${base}` : base;
    return base;
  }

  map.setOverlay((ctx) => drawScene(ctx, map, {
    doc: store.doc,
    selection: tools.selection,
    multiIds: tools.multi,
    handleRadius: tools.touch ? 9 : 6,
    ghostIds: state.phaseView ? new Set(store.doc.features.filter((f) => !featureInPhase(store.doc, f, state.phaseView)).map((f) => f.id)) : null,
    osmWays: osm.list(),
    showOsm: settings.showOsm,
    preview: tools.preview,
    snap: tools.snapPoint,
    showHandles: tools.tool === 'select' && canEdit(),
    routes: store.doc.route ? state.routes : null,
    pairs: state.pairResults,
    busLines: (store.doc.busLines || []).map((l) => {
      const r = state.busResults.find((x) => x.id === l.id);
      return { id: l.id, name: l.name, color: l.color, path: r && r.proposed ? r.proposed.path : null };
    }),
    isochrone: store.doc.isochrone ? state.iso : null,
    transit: transit.stops.size ? { stops: transit.stopList(), adopted: new Set(store.doc.features.filter((f) => f.type === 'junction' && f.osmId).map((f) => f.osmId)) } : null,
    routeTarget: tools.routeTarget,
    parcels: selectedParcelPolygons(),
    buildings: state.showExposure ? exposureForDrawing() : null,
    diff: state.showDiff && state.diff ? state.diff.result : null,
    routeDraft: tools.routeDraft,
    comments: settings.showComments ? state.comments : [],
    activeCommentId: state.activeCommentId,
    commentDraft: tools.commentDraft,
  }));

  // --- Parzellen und Gebäude -------------------------------------------------------
  function selectedParcelPolygons() {
    if (!tools.selection) return null;
    const f = getFeature(store.doc, tools.selection.featureId);
    if (!f || f.type !== 'road') return null;
    const info = validParcels(f);
    if (!info) return null;
    const polys = [];
    for (const it of info.items) {
      const g = state.parcelGeoms.get(it.egrid || it.number);
      if (g) polys.push(...g);
    }
    return polys.length ? polys : null;
  }

  // --- Routen-Rechner ----------------------------------------------------------
  function recomputeRoutes() {
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => {
      const doc = effectiveDoc();
      const q = doc.route;
      const pairs = (doc.routePairs || []).filter((p) => p.from && p.to);
      const iso = doc.isochrone;
      const busLines = (doc.busLines || []).filter((l) => l.stops.length >= 2);
      try {
        state.busResults = busLines.length ? computeBusLines({ osmWays: osm.list(), doc, model: settings.speedModel }) : [];
      } catch {
        state.busResults = [];
      }
      if (!q && !pairs.length && !iso) {
        state.routes = null;
        state.pairResults = [];
        state.iso = null;
      } else {
        try {
          const graphs = buildGraphs({ osmWays: osm.list(), doc, model: settings.speedModel });
          state.routes = q ? { current: routeOnGraph(graphs.current, q.from, q.to), proposed: routeOnGraph(graphs.proposed, q.from, q.to), model: settings.speedModel } : null;
          state.pairResults = pairs.map((p) => ({ id: p.id, current: routeOnGraph(graphs.current, p.from, p.to), proposed: routeOnGraph(graphs.proposed, p.from, p.to) }));
          state.iso = iso ? computeIsochrone({ osmWays: osm.list(), doc, from: iso.from, minutes: iso.minutes, mode: iso.mode, model: settings.speedModel, graphs }) : null;
        } catch (e) {
          state.routes = { current: { error: e.message }, proposed: { error: e.message } };
          state.pairResults = [];
          state.iso = { error: e.message };
        }
      }
      map.requestRender();
      if (ui) {
        ui.refreshRoute();
        ui.refreshPresent();
      }
    }, 120);
  }

  /** Bereich um den Isochronen-Ursprung: höchste Minutenzahl bei rund 50 km/h, Luftlinie etwa 70 % davon. */
  function isochroneBounds(iso) {
    const maxMin = Math.max(...iso.minutes);
    const radiusM = Math.max(600, (maxMin / 60) * 50000 * 0.7);
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos((iso.from[0] * Math.PI) / 180));
    const b = { south: iso.from[0] - dLat, north: iso.from[0] + dLat, west: iso.from[1] - dLng, east: iso.from[1] + dLng };
    b.cells = cellsFor(b).length;
    b.tooLarge = b.cells > MAX_CELLS;
    return b;
  }

  /** Entwurf im gewählten Etappen-Zustand (Elemente späterer Etappen fehlen), sonst der ganze Entwurf. */
  function effectiveDoc() {
    return state.phaseView ? docForPhase(store.doc, state.phaseView) : store.doc;
  }

  /** Lädt Haltestellen und Linien für die Ansicht nach, wenn sie klein genug ist (ohne Meldung). */
  function ensureTransit() {
    if (map.getZoom() < 14) return;
    const b = map.getBounds();
    if (cellsFor(b).length > 6) return;
    transit.ensureArea(b);
  }

  function ensureRouteNetwork() {
    const doc = store.doc;
    const queries = [];
    if (doc.route) queries.push(doc.route);
    for (const p of doc.routePairs || []) if (p.from && p.to) queries.push(p);
    for (const l of doc.busLines || []) {
      const stops = l.stops.map((id) => getFeature(doc, id)).filter((f) => f && f.at);
      for (let i = 1; i < stops.length; i++) queries.push({ from: stops[i - 1].at, to: stops[i].at });
    }
    for (const q of queries) {
      const b = routeBounds(q.from, q.to);
      if (b.tooLarge) {
        ui.toast(t('Start und Ziel liegen zu weit auseinander ({n} Zellen, erlaubt {max}). Näher zusammenliegende Punkte wählen.', { n: b.cells, max: MAX_CELLS }), 'error', 6000);
        continue;
      }
      osm.ensureArea(b);
    }
    if (doc.isochrone) {
      const b = isochroneBounds(doc.isochrone);
      if (b.tooLarge) ui.toast(t('Erreichbarkeit: Bereich zu gross ({n} Zellen, erlaubt {max}). Weniger Minuten wählen.', { n: b.cells, max: MAX_CELLS }), 'error', 6000);
      else osm.ensureArea(b);
    }
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
    defaultZoneKind: () => state.defaultZoneKind,
    setDefaultZoneKind(kind) {
      state.defaultZoneKind = kind;
    },
    comments: () => state.comments,
    activeCommentId: () => state.activeCommentId,
    replyTo: () => state.replyTo,
    canManageComment: (c) => !!state.token || !!local.commentToken(c.id),
    refreshComments: () => loadComments(),
    startReply(id) {
      state.replyTo = id;
      state.activeCommentId = id;
      ui.refreshComments();
      map.requestRender();
    },
    cancelReply() {
      state.replyTo = null;
      ui.refreshComments();
    },
    async submitComment({ author, text, parentId = null }) {
      const draft = tools.commentDraft;
      if (!state.id || (!parentId && !draft)) return;
      const clean = text.trim();
      if (!clean) return ui.toast(t('Bitte einen Text eingeben.'), 'error');
      if (author.trim() !== settings.author) actions.updateSettings({ author: author.trim() });
      try {
        const body = { author: author.trim(), text: clean, clientId: state.clientId };
        if (parentId) body.parentId = parentId;
        else {
          body.lat = draft.latlng[0];
          body.lng = draft.latlng[1];
        }
        const res = await api.addComment(state.id, body);
        local.rememberCommentToken(res.comment.id, res.commentToken);
        if (parentId) state.replyTo = null;
        else tools.clearCommentDraft();
        state.activeCommentId = parentId || res.comment.id;
        if (state.knownCommentIds) state.knownCommentIds.add(res.comment.id);
        await loadComments({ quiet: true });
        ui.toast(parentId ? t('Antwort gespeichert.') : t('Kommentar gespeichert.'), 'ok');
        if (!parentId && state.push.subscribed && state.push.role === 'replies') actions.enablePush({ silent: true });
      } catch (e) {
        ui.toast(`${parentId ? t('Antwort') : t('Kommentar')} ${t('fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    pushStatus: () => ({ ...state.push, supported: pushSupported(), permission: permissionState() }),
    async enablePush({ silent = false } = {}) {
      if (!state.id || !state.push.serverEnabled) return;
      try {
        const subscription = await pushSubscribe(state.push.publicKey);
        const role = state.token ? 'all' : 'replies';
        const res = await api.setPushSub(state.id, { clientId: state.clientId, subscription, role, threads: local.ownCommentIds() }, state.token);
        local.setPushState(state.id, { role: res.role });
        state.push.subscribed = true;
        state.push.role = res.role;
        if (!silent) ui.toast(res.role === 'all' ? t('Du wirst bei neuen Kommentaren benachrichtigt.') : t('Du wirst bei Antworten auf deine Kommentare benachrichtigt.'), 'ok', 5000);
      } catch (e) {
        state.push.subscribed = false;
        if (!silent) ui.toast(`${t('Benachrichtigungen')}: ${e.message}`, 'error', 7000);
      }
      ui.refreshComments();
    },
    async disablePush() {
      if (!state.id) return;
      try {
        await api.deletePushSub(state.id, state.clientId);
      } catch {
        // Server-Abo fehlt schon, egal
      }
      local.setPushState(state.id, null);
      state.push.subscribed = false;
      state.push.role = null;
      // Das Browser-Abo bleibt für andere Entwürfe bestehen; ohne Server-Eintrag kommt nichts mehr an.
      const others = local.listDrafts().some((d) => d.id !== state.id && local.pushState(d.id));
      if (!others) {
        try {
          await pushUnsubscribe();
        } catch {
          // egal
        }
      }
      ui.refreshComments();
    },
    cancelComment() {
      tools.clearCommentDraft();
      ui.refreshComments();
    },
    async resolveComment(id, resolved) {
      try {
        await api.resolveComment(state.id, id, resolved, { token: state.token, commentToken: local.commentToken(id) });
        await loadComments();
      } catch (e) {
        ui.toast(`${t('Ändern fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    async deleteComment(id) {
      if (!confirm(t('Kommentar löschen?'))) return;
      try {
        await api.deleteComment(state.id, id, { token: state.token, commentToken: local.commentToken(id) });
        if (state.activeCommentId === id) state.activeCommentId = null;
        await loadComments();
      } catch (e) {
        ui.toast(`${t('Löschen fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    focusComment(id) {
      const c = state.comments.find((x) => x.id === id);
      if (!c) return;
      state.activeCommentId = id;
      map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 16));
      ui.showTab('comments');
      ui.refreshComments();
      map.requestRender();
    },
    costEstimate: () => estimateCosts(store.doc),
    setCost(key, value) {
      if (!actions.requireEdit()) return;
      store.commit('Einheitskosten ändern', (d) => {
        if (!d.costs) d.costs = {};
        if (value === null || !Number.isFinite(value) || value < 0) delete d.costs[key];
        else d.costs[key] = Math.round(value);
      });
    },
    resetCosts() {
      if (!actions.requireEdit()) return;
      store.commit('Einheitskosten zurücksetzen', (d) => { d.costs = {}; });
    },
    runChecks: () => runChecks(store.doc, { osmWays: osm.list() }),
    parcelsFor: (roadId) => {
      const r = getFeature(store.doc, roadId);
      return r && r.type === 'road' ? validParcels(r) : null;
    },
    async loadParcels(roadId) {
      if (!actions.requireEdit()) return;
      const road = getFeature(store.doc, roadId);
      if (!road || road.type !== 'road') return;
      ui.toast(t('Parzellen werden abgefragt…'));
      try {
        const res = await api.parcels(road.nodes);
        for (const p of res.parcels || []) {
          if (p.polygons && p.polygons.length) state.parcelGeoms.set(p.egrid || p.number || p.id, p.polygons);
        }
        const summary = summarizeParcels(road, res.parcels || []);
        store.commit('Parzellen ermitteln', (d) => {
          const r = getFeature(d, roadId);
          if (r) r.parcels = summary;
        });
        ui.toast(summary.items.length ? tn(summary.items.length, '{n} Parzelle berührt.', '{n} Parzellen berührt.') : t('Keine Parzellen gefunden (amtliche Vermessung deckt nur die Schweiz ab).'), 'ok', 5000);
      } catch (e) {
        ui.toast(`${t('Parzellen')}: ${e.message}`, 'error', 7000);
      }
    },
    clearParcels(roadId) {
      actions.patchFeature(roadId, 'Parzellen entfernen', (r) => { r.parcels = null; });
    },
    buildingsStatus() {
      if (buildings.pending) return t('Gebäude werden geladen… ({n} Zellen offen)', { n: buildings.remaining });
      if (buildings.lastError) return `${t('Gebäude')}: ${buildings.lastError.message}`;
      return buildings.ways.size ? t('{n} Gebäude geladen.', { n: buildings.ways.size }) : t('Noch keine Gebäude geladen.');
    },
    buildingsLoaded: () => buildings.ways.size,
    loadBuildings() {
      const b = map.getBounds();
      const n = cellsFor(b).length;
      if (n > MAX_CELLS) {
        ui.toast(t('Ansicht zu gross ({n} Zellen, erlaubt {max}) – näher heranzoomen.', { n, max: MAX_CELLS }), 'error', 5000);
        return;
      }
      buildings.ensureArea(b);
      if (store.doc.route) buildings.ensureArea(routeBounds(store.doc.route.from, store.doc.route.to, { factor: 0.1 }));
      ui.refreshAnalysis();
    },
    // --- Variantenvergleich, Parkplatzbilanz, Etappen -------------------------------------
    compareVariants() {
      state.variants = compareVariants({ doc: store.doc, osmWays: osm.list(), model: settings.speedModel, buildings: buildings.list(), radiusM: settings.exposureRadius });
      ui.refreshAnalysis();
    },
    variants: () => state.variants,
    parkingStatus() {
      if (parking.pending) return t('Parkplätze werden geladen… ({n} Zellen offen)', { n: parking.remaining });
      if (parking.lastError) return `${t('Parkplätze')}: ${parking.lastError.message}`;
      return parking.ways.size ? t('{n} OSM-Parkplätze geladen; Parkstreifen kommen aus den geladenen OSM-Strassen.', { n: parking.ways.size }) : t('Noch keine OSM-Parkplätze geladen; Parkstreifen kommen aus den geladenen OSM-Strassen.');
    },
    loadParking() {
      const b = map.getBounds();
      const n = cellsFor(b).length;
      if (n > MAX_CELLS) return ui.toast(t('Ansicht zu gross ({n} Zellen, erlaubt {max}) – näher heranzoomen.', { n, max: MAX_CELLS }), 'error', 5000);
      parking.ensureArea(b);
      osm.ensureArea(b);
      ui.refreshAnalysis();
      return undefined;
    },
    parkingBalance: () => parkingBalance({ doc: store.doc, osmWays: osm.list(), parkingAreas: parking.list() }),
    addPhase() {
      if (!actions.requireEdit()) return;
      let ok = false;
      store.commit('Etappe hinzufügen', (d) => { ok = !!createPhase(d); });
      if (!ok) ui.toast(t('Höchstens 10 Etappen.'), 'error');
    },
    patchPhase(id, label, fn) {
      actions.commitDoc(label, (d) => {
        const ph = (d.phases || []).find((x) => x.id === id);
        if (ph) fn(ph);
      });
    },
    removePhase(id) {
      actions.commitDoc('Etappe löschen', (d) => removePhase(d, id));
      if (state.phaseView === id) actions.setPhaseView(null);
    },
    setFeaturesPhase(ids, phaseId) {
      actions.commitDoc(ids.length > 1 ? 'Etappe der Auswahl setzen' : 'Etappe setzen', (d) => {
        const valid = !phaseId || (d.phases || []).some((ph) => ph.id === phaseId);
        for (const id of ids) {
          const f = getFeature(d, id);
          if (f) f.phase = valid && phaseId ? phaseId : null;
        }
      });
    },
    phaseView: () => state.phaseView,
    setPhaseView(id) {
      state.phaseView = id && (store.doc.phases || []).some((ph) => ph.id === id) ? id : null;
      map.requestRender();
      recomputeRoutes();
      ui.refreshAll();
    },
    /** Je Etappe kumuliert: Elemente, Kosten (sichtbare Ebenen), Fahrzeit der Hauptroute. */
    phaseTable() {
      const phases = store.doc.phases || [];
      if (!phases.length) return [];
      const q = store.doc.route;
      const ways = osm.list();
      return phases.map((ph, i) => {
        const pdoc = docForPhase(store.doc, ph.id);
        const row = { id: ph.id, label: phaseLabel(ph, i), features: pdoc.features.filter((f) => f.phase).length, own: store.doc.features.filter((f) => f.phase === ph.id).length, costs: estimateCosts(pdoc).total, routeTime: null };
        if (q && ways.length) {
          const r = computeRoutes({ osmWays: ways, doc: pdoc, from: q.from, to: q.to, model: settings.speedModel });
          if (r.proposed && !r.proposed.error) row.routeTime = r.proposed.time;
        }
        return row;
      });
    },
    exposure() {
      if (!buildings.ways.size) return null;
      const hidden = new Set(store.doc.layers.filter((l) => l.visible === false).map((l) => l.id));
      const roads = store.doc.features.filter((f) => f.type === 'road' && !hidden.has(f.layerId));
      return computeExposure({ buildings: buildings.list(), routes: store.doc.route ? state.routes : null, roads, radiusM: settings.exposureRadius });
    },
    showExposure: () => state.showExposure,
    setShowExposure(on) {
      state.showExposure = !!on;
      map.requestRender();
    },
    async runExport({ format, mode, paper, orientation, dpi, scale = 2000, report = false, confidence = settings.reportConfidence !== false }) {
      const opts = { mode, paper, orientation, dpi, scale, routes: actions.routes(), pairs: state.pairResults, busLines: state.busResults, isochrone: state.iso, link: state.id ? `${location.origin}/d/${state.id}` : '', comments: state.comments, checks: actions.runChecks(), exposure: actions.exposure(), confidence: confidence ? actions.confidences() : null, variants: state.variants, parking: actions.parkingBalance(), phases: actions.phaseTable() };
      let blob;
      if (format === 'pdf' && report) blob = await exportReport(map, store.doc, opts);
      else if (format === 'pdf') blob = await exportPdf(map, store.doc, opts);
      else blob = await exportPng(map, store.doc, opts);
      download(`${safeFilename(store.doc.name)}${report ? '-bericht' : ''}.${format}`, blob);
    },
    isPresent: () => state.present,
    exitPresent() {
      if (!state.id) return;
      location.href = `/d/${state.id}`;
    },
    remoteUpdate: () => state.remoteUpdate,
    async reloadFromServer() {
      if (!state.id) return;
      try {
        const res = await api.getDraft(state.id);
        applyServerDoc(res);
        ui.toast(t('Aktueller Stand vom Server geladen.'), 'ok');
      } catch (e) {
        ui.toast(`${t('Laden fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    tileSources: () => state.tileSources,
    updateSettings(patch) {
      Object.assign(settings, patch);
      local.saveSettings(settings);
      state.snapDirty = true;
      if ('basemap' in patch || 'overlays' in patch) applyTileLayers();
      if ('theme' in patch) applyTheme();
      if ('speedModel' in patch) {
        recomputeRoutes();
        ui.refreshRoute();
      }
      if ('exposureRadius' in patch) ui.refreshAnalysis();
      if ('language' in patch) {
        setLanguage(patch.language);
        applyStatic();
        ui.refreshAll();
        ui.setStatus(tools.toolInfo().hint);
        updateOsmStatus();
      }
      if ('showOsm' in patch || 'snapOsm' in patch) ensureOsm();
      map.requestRender();
      ui.refreshTools();
      if ('showComments' in patch) ui.refreshComments();
      updateOsmStatus();
    },
    requireEdit() {
      if (canEdit()) return true;
      ui.toast(t('Nur Ansicht: Lege zuerst eine eigene Kopie an.'));
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
      if (label) ui.toast(`${t('Rückgängig')}: ${t(label)}`);
    },
    redo() {
      if (!actions.requireEdit()) return;
      const label = store.redo();
      if (label) ui.toast(`${t('Wiederholt')}: ${t(label)}`);
    },
    commitDoc(label, fn) {
      if (!actions.requireEdit()) return;
      store.commit(label, fn);
    },
    smoothRoad(id) {
      if (!actions.requireEdit()) return;
      store.commit('Strasse glätten', (d) => smoothRoad(getFeature(d, id), 4));
    },
    simplifyRoad(id) {
      if (!actions.requireEdit()) return;
      let changed = false;
      store.commit('Strasse vereinfachen', (d) => { changed = simplifyRoad(getFeature(d, id), 1); });
      if (!changed) ui.toast(t('Nichts zu vereinfachen (Toleranz 1 m).'));
    },
    async loadProfile(id) {
      if (!actions.requireEdit()) return;
      const road = getFeature(store.doc, id);
      if (!road || road.type !== 'road') return;
      ui.toast(t('Höhenprofil wird geladen…'));
      try {
        const res = await api.profile(road.nodes);
        const key = nodesKey(road.nodes);
        store.commit('Höhenprofil laden', (d) => {
          const r = getFeature(d, id);
          if (r) r.profile = { points: res.points, key };
        });
        ui.toast(t('Höhenprofil geladen.'), 'ok');
      } catch (e) {
        ui.toast(`${t('Höhenprofil')}: ${e.message}`, 'error', 7000);
      }
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
      const name = prompt(t('Name der neuen Ebene:'), `${t('Ebene')} ${store.doc.layers.length + 1}`);
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
      if (count && !confirm(t('Ebene „{name}“ mit {n} Element(en) löschen?', { name: layer.name, n: count }))) return;
      store.commit('Ebene löschen', (d) => removeLayer(d, id));
    },
    /** Auswahl per Liste oder Menü: optional ergänzen (Shift) und hinzoomen. */
    selectFeature(id, { zoom = false, add = false } = {}) {
      const f = getFeature(store.doc, id);
      if (!f) return;
      if (tools.tool !== 'select') tools.setTool('select');
      if (add) tools.toggleSelected({ featureId: id, segIndex: null });
      else tools.setSelection({ featureId: id, segIndex: null });
      if (zoom) actions.zoomToFeature(id);
    },
    /** Auf mehrere Elemente zoomen (Umriss aller Punkte). */
    zoomToFeatures(ids) {
      const feats = ids.map((id) => getFeature(store.doc, id)).filter(Boolean);
      if (feats.length === 1) return actions.zoomToFeature(feats[0].id);
      const pts = [];
      for (const f of feats) {
        if (f.type === 'junction') pts.push(f.at);
        else if (f.type === 'roundabout') pts.push(f.center);
        else pts.push(...f.nodes);
      }
      if (!pts.length) return undefined;
      const lats = pts.map((n) => n[0]);
      const lngs = pts.map((n) => n[1]);
      map.fitBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) }, { padding: 60, maxZoom: 18 });
      return undefined;
    },
    setFeaturesLayer(ids, layerId) {
      if (!getLayer(store.doc, layerId)) return;
      actions.commitDoc(ids.length > 1 ? 'Ebene der Auswahl wechseln' : 'Ebene wechseln', (d) => {
        for (const id of ids) {
          const f = getFeature(d, id);
          if (f) f.layerId = layerId;
        }
      });
    },
    setFeaturesStatus(ids, status) {
      actions.commitDoc(ids.length > 1 ? 'Status der Auswahl ändern' : 'Status ändern', (d) => {
        for (const id of ids) {
          const f = getFeature(d, id);
          if (f && f.type === 'road') f.status = status;
        }
      });
    },
    setSegmentLevel(id, i, level) {
      actions.patchFeature(id, 'Abschnitt ändern', (f) => { if (f.segments[i]) f.segments[i].level = level; });
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
      return !actions.isDirty() || store.doc.features.length === 0 || confirm(t('Der aktuelle Entwurf hat ungespeicherte Änderungen. Trotzdem fortfahren?'));
    },
    newDraft() {
      if (!actions.confirmDiscard()) return;
      bind(null, null);
      loadDocument(createDocument({ center: map.getCenter(), zoom: map.getZoom() }), { keepView: true });
      history.replaceState(null, '', '/');
      ui.toast(t('Neuer Entwurf angelegt.'));
    },
    async saveDraft(label, { force = false } = {}) {
      store.doc.view = currentView();
      try {
        if (state.id && state.token) {
          if (label === undefined) {
            label = prompt(t('Kurze Beschreibung dieser Version (optional):'), '') ?? '';
          }
          let res;
          try {
            res = await api.saveDraft(state.id, state.token, store.doc, label || 'Gespeichert', force ? null : state.serverUpdatedAt);
          } catch (e) {
            if (e.status !== 409 || !e.data || !e.data.doc) throw e;
            // Jemand anderes hat inzwischen gespeichert: überschreiben oder Serverstand übernehmen?
            const choice = await ui.openConflict({ updatedAt: e.data.updatedAt, versionCount: e.data.versionCount });
            if (choice === 'overwrite') return actions.saveDraft(label || 'Gespeichert', { force: true });
            if (choice === 'reload') {
              applyServerDoc(e.data);
              ui.toast(t('Serverstand übernommen; deine Fassung liegt im Verlauf unter „Rückgängig“.'), 'info', 6000);
            }
            return undefined;
          }
          state.serverUpdatedAt = res.updatedAt;
          if (state.remoteUpdate) {
            state.remoteUpdate = null;
            ui.showBanner(null);
          }
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
        ui.toast(t('„{name}“ gespeichert.', { name: store.doc.name }), 'ok');
      } catch (e) {
        ui.toast(`${t('Speichern fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    async makeOwnCopy() {
      if (!state.id) return actions.saveDraft();
      try {
        const name = prompt(t('Name deiner Kopie:'), `${store.doc.name} (${t('Kopie')})`);
        if (name === null) return;
        const res = await api.forkDraft(state.id, name.trim());
        const copy = deserialize(JSON.stringify(res.doc));
        bind(res.id, res.editToken);
        loadDocument(copy, { keepView: true });
        state.serverUpdatedAt = res.updatedAt || null;
        state.savedKey = contentKey(copy);
        local.rememberDraft({ id: res.id, name: copy.name, token: res.editToken });
        history.replaceState(null, '', `/d/${res.id}`);
        saveWorking();
        ui.showBanner(null);
        ui.refreshAll();
        ui.toast(t('Eigene Kopie angelegt – du kannst jetzt bearbeiten.'), 'ok');
      } catch (e) {
        ui.toast(`${t('Kopie fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    async saveCopy() {
      if (!state.id) return actions.saveDraft();
      const name = prompt(t('Name der Kopie:'), `${store.doc.name} (${t('Kopie')})`);
      if (name === null) return;
      const copy = cloneDocument(store.doc);
      copy.name = name.trim() || copy.name;
      try {
        const res = await api.createDraft(copy, 'Kopie angelegt');
        bind(res.id, res.editToken);
        loadDocument(deserialize(JSON.stringify(res.doc)), { keepView: true });
        state.serverUpdatedAt = res.updatedAt || null;
        state.savedKey = contentKey(store.doc);
        local.rememberDraft({ id: res.id, name: copy.name, token: res.editToken, updatedAt: res.updatedAt });
        history.replaceState(null, '', `/d/${res.id}`);
        saveWorking();
        ui.refreshAll();
        ui.toast(t('Kopie „{name}“ gespeichert.', { name: copy.name }), 'ok');
      } catch (e) {
        ui.toast(`${t('Kopie fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    openDraft(id) {
      if (!actions.confirmDiscard()) return;
      saveWorking();
      location.href = `/d/${id}`;
    },
    openByLink(text) {
      const m = /([0-9a-z]{6,32})(?:\/?(?:#.*)?)?$/.exec(text.trim());
      if (!m) return ui.toast(t('Das sieht nicht nach einem Entwurfs-Link aus.'), 'error');
      const hash = /#(edit=[0-9a-f]+)/.exec(text);
      if (!actions.confirmDiscard()) return;
      location.href = `/d/${m[1]}${hash ? '#' + hash[1] : ''}`;
    },
    async deleteDraft(id) {
      const entry = local.getDraft(id);
      if (!entry) return;
      const own = !!entry.token;
      const msg = own
        ? t('Entwurf „{name}“ auf dem Server samt Versionen endgültig löschen?', { name: entry.name })
        : t('„{name}“ aus deiner Liste entfernen? (Der Entwurf bleibt auf dem Server, du hast kein Bearbeitungsrecht.)', { name: entry.name });
      if (!confirm(msg)) return;
      try {
        if (own) await api.deleteDraft(id, entry.token);
      } catch (e) {
        if (e.status !== 404) return ui.toast(`${t('Löschen fehlgeschlagen')}: ${e.message}`, 'error', 6000);
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
        ui.toast(t('Version wiederhergestellt (mit Rückgängig widerrufbar).'));
      } catch (e) {
        ui.toast(`${t('Version konnte nicht geladen werden')}: ${e.message}`, 'error');
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
        const text = await file.text();
        const parsed = parseImport(text, file.name);
        if (parsed.format === 'stadtplaner') {
          const d = deserialize(text);
          if (!actions.confirmDiscard()) return;
          bind(null, null);
          loadDocument(d);
          history.replaceState(null, '', '/');
          ui.toast(t('„{name}“ importiert – speichern, um ihn auf dem Server abzulegen.', { name: d.name }));
          return;
        }
        if (!actions.requireEdit()) return;
        if (!parsed.items.length) return ui.toast(t('Keine Linien, Punkte oder Flächen in der Datei gefunden.'), 'error', 6000);
        const name = `${t('Import')} ${file.name.replace(/\.[^.]+$/, '')}`.slice(0, 60);
        let counts = null;
        store.commit(`Import ${parsed.format.toUpperCase()}`, (d) => { counts = applyImport(d, parsed.items, { layerName: name }); });
        actions.setActiveLayer(counts.layerId);
        const layerFeatures = store.doc.features.filter((f) => f.layerId === counts.layerId);
        const lats = [];
        const lngs = [];
        for (const f of layerFeatures) for (const p of f.nodes || [f.at]) { lats.push(p[0]); lngs.push(p[1]); }
        if (lats.length) map.fitBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) }, { padding: 60, maxZoom: 17 });
        ui.toast(t('{format} importiert: {roads} Strassen, {junctions} Punkte, {zones} Flächen auf Ebene „{name}“ (Status „bestehend“).', { format: parsed.format.toUpperCase(), roads: counts.roads, junctions: counts.junctions, zones: counts.zones, name }), 'ok', 7000);
      } catch (e) {
        ui.toast(`${t('Import fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    diff: () => state.diff,
    showDiff: () => state.showDiff,
    setShowDiff(on) {
      state.showDiff = !!on;
      map.requestRender();
    },
    clearDiff() {
      state.diff = null;
      state.showDiff = false;
      map.requestRender();
    },
    async compareVersions(a, b) {
      if (!state.id) throw new Error(t('Entwurf ist nicht gespeichert'));
      const load = async (which) => (which === 'current' ? store.doc : deserialize(JSON.stringify((await api.version(state.id, Number(which))).doc)));
      const [docA, docB] = await Promise.all([load(a), load(b)]);
      state.diff = { a, b, result: diffDocuments(docA, docB) };
      state.showDiff = !state.diff.result.empty;
      map.requestRender();
      return state.diff;
    },
    zoomToGeometry(f) {
      const pts = f.nodes || (f.at ? [f.at] : f.center ? [f.center] : []);
      if (!pts.length) return;
      const lats = pts.map((p) => p[0]);
      const lngs = pts.map((p) => p[1]);
      if (pts.length === 1) map.flyTo(pts[0], Math.max(map.getZoom(), 17));
      else map.fitBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) }, { padding: 60, maxZoom: 18 });
    },
    async share() {
      if (!state.id || actions.isDirty()) {
        if (!canEdit()) return ui.openShare({ viewUrl: `${location.origin}/d/${state.id}`, presentUrl: `${location.origin}/d/${state.id}?present=1`, editUrl: null, doc: store.doc });
        await actions.saveDraft(state.id ? 'Vor dem Teilen gespeichert' : undefined);
        if (!state.id) return;
      }
      ui.openShare({
        viewUrl: `${location.origin}/d/${state.id}`,
        presentUrl: `${location.origin}/d/${state.id}?present=1`,
        editUrl: state.token ? `${location.origin}/d/${state.id}#edit=${state.token}` : null,
        doc: store.doc,
      });
    },
    routes: () => (store.doc.route ? state.routes : null),
    pairResults: () => state.pairResults,
    addPair() {
      if (!actions.requireEdit()) return;
      const n = (store.doc.routePairs || []).length;
      if (n >= 20) return ui.toast(t('Höchstens 20 Routenpaare.'), 'error');
      const id = newId('p');
      store.commit('Routenpaar hinzufügen', (d) => {
        if (!d.routePairs) d.routePairs = [];
        d.routePairs.push({ id, name: `${t('Paar')} ${n + 1}`, from: null, to: null });
      });
      tools.captureRoute({ pairId: id });
      ui.refreshRoute();
    },
    capturePair(id) {
      if (!actions.requireEdit()) return;
      tools.captureRoute({ pairId: id });
      ui.refreshRoute();
    },
    renamePair(id, name) {
      actions.commitDoc('Routenpaar umbenennen', (d) => {
        const p = (d.routePairs || []).find((x) => x.id === id);
        if (p) p.name = name.trim().slice(0, 60);
      });
    },
    swapPair(id) {
      actions.commitDoc('Routenpaar umkehren', (d) => {
        const p = (d.routePairs || []).find((x) => x.id === id);
        if (p && p.from && p.to) [p.from, p.to] = [p.to, p.from];
      });
    },
    removePair(id) {
      actions.commitDoc('Routenpaar löschen', (d) => { d.routePairs = (d.routePairs || []).filter((x) => x.id !== id); });
    },
    busResults: () => state.busResults,
    addBusLine() {
      if (!actions.requireEdit()) return;
      if ((store.doc.busLines || []).length >= MAX_BUS_LINES) return ui.toast(t('Höchstens 20 Buslinien.'), 'error');
      let id = null;
      store.commit('Buslinie hinzufügen', (d) => { id = createBusLine(d).id; });
      if (id) tools.captureRoute({ busLine: id });
      ensureTransit();
      ui.refreshRoute();
    },
    captureBusStops(id) {
      if (!actions.requireEdit()) return;
      tools.captureRoute({ busLine: id });
      ensureTransit();
      ui.refreshRoute();
    },
    // Bestehende Haltestellen und Linien aus OSM
    transitStatus() {
      if (transit.pending) return t('ÖV wird geladen… ({n} Zellen offen)', { n: transit.remaining });
      if (transit.lastError) return `${t('ÖV aus OSM')}: ${transit.lastError.message}`;
      if (!transit.stops.size && !transit.routes.size) return t('Noch nichts geladen – „Für Ansicht laden“ holt Haltestellen und Buslinien aus OSM (ab Zoom 13).');
      return t('{n} Haltestellen und {m} Linien aus OSM geladen. Beim Setzen von Haltestellen hängt ein Klick auf eine OSM-Haltestelle sie an die Linie.', { n: transit.stops.size, m: transit.routes.size });
    },
    transitRoutes: () => transit.routeList(),
    loadTransit() {
      if (map.getZoom() < 13) return ui.toast(t('ÖV aus OSM ab Zoom 13 – näher heranzoomen.'), 'error');
      const b = map.getBounds();
      const n = cellsFor(b).length;
      if (n > MAX_CELLS) return ui.toast(t('Ansicht zu gross ({n} Zellen, erlaubt {max}) – näher heranzoomen.', { n, max: MAX_CELLS }), 'error', 5000);
      transit.refreshArea(b);
      ui.refreshRoute();
    },
    adoptBusRoute(osmId) {
      if (!actions.requireEdit()) return;
      const route = transit.routes.get(osmId);
      if (!route) return;
      if ((store.doc.busLines || []).length >= MAX_BUS_LINES) return ui.toast(t('Höchstens 20 Buslinien.'), 'error');
      let line = null;
      store.commit('Buslinie aus OSM übernehmen', (d) => { line = adoptBusRoute(d, route, state.activeLayerId); });
      if (line) ui.toast(t('Linie {name} mit {n} Haltestellen übernommen.', { name: line.name, n: line.stops.length }));
      ui.refreshRoute();
    },
    patchBusLine(id, label, fn) {
      actions.commitDoc(label, (d) => {
        const l = (d.busLines || []).find((x) => x.id === id);
        if (l) fn(l);
      });
    },
    removeBusLine(id) {
      actions.commitDoc('Buslinie löschen', (d) => { d.busLines = (d.busLines || []).filter((x) => x.id !== id); });
      if (tools.routeTarget && tools.routeTarget.busLine === id) tools.cancel();
    },
    isochrone: () => state.iso,
    /** Zuversicht eines Ergebnisses: route, pair(id), pairs, bus(id), isochrone, costs, parcels, buildings, checks. */
    confidence(kind, id = null) {
      const networkLoading = !!osm.pending;
      switch (kind) {
        case 'route': return state.routes ? travelTimeConfidence([state.routes.current, state.routes.proposed], { networkLoading }) : null;
        case 'pair': {
          const r = state.pairResults.find((x) => x.id === id);
          return r ? travelTimeConfidence([r.current, r.proposed], { networkLoading }) : null;
        }
        case 'pairs': return travelTimeConfidence(state.pairResults.flatMap((r) => [r.current, r.proposed]), { networkLoading });
        case 'bus': {
          const r = state.busResults.find((x) => x.id === id);
          const l = (store.doc.busLines || []).find((x) => x.id === id);
          return r ? travelTimeConfidence([r.current, r.proposed], { networkLoading, dwell: l ? l.dwell : null }) : null;
        }
        case 'isochrone': return state.iso && !state.iso.error ? travelTimeConfidence(state.iso, { networkLoading }) : null;
        case 'costs': return costConfidence(store.doc);
        default: return staticConfidence(kind);
      }
    },
    /** Alle Einstufungen für den Bericht. */
    confidences() {
      return {
        route: actions.confidence('route'),
        pairs: Object.fromEntries(state.pairResults.map((r) => [r.id, actions.confidence('pair', r.id)])),
        busLines: Object.fromEntries(state.busResults.map((r) => [r.id, actions.confidence('bus', r.id)])),
        isochrone: actions.confidence('isochrone'),
        costs: actions.confidence('costs'),
        parcels: staticConfidence('parcels'),
        buildings: staticConfidence('buildings'),
        checks: staticConfidence('checks'),
      };
    },
    captureIsochrone() {
      if (!actions.requireEdit()) return;
      tools.captureRoute({ isochrone: true });
      ui.refreshRoute();
    },
    setIsochrone(patch) {
      actions.commitDoc('Erreichbarkeit ändern', (d) => {
        if (!d.isochrone) return;
        Object.assign(d.isochrone, patch);
      });
    },
    clearIsochrone() {
      actions.commitDoc('Erreichbarkeit löschen', (d) => { d.isochrone = null; });
    },
    routeNetworkStatus() {
      if (osm.pending) return t('Strassennetz wird geladen… ({n} Zellen offen)', { n: osm.remaining });
      if (osm.lastError) return `${t('Strassennetz')}: ${osm.lastError.message}`;
      return osm.ways.size ? t('{n} OSM-Strassen im Speicher.', { n: osm.ways.size }) : t('Noch kein Strassennetz geladen – Start und Ziel setzen oder „Netz für Ansicht laden“.');
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
      const n = cellsFor(b).length;
      if (n > MAX_CELLS) {
        ui.toast(t('Ansicht zu gross ({n} Zellen, erlaubt {max}) – näher heranzoomen.', { n, max: MAX_CELLS }), 'error', 5000);
        return;
      }
      osm.ensureArea(b);
      ui.refreshRoute();
    },
    async exportPng() {
      try {
        await actions.runExport({ format: 'png', mode: 'view', paper: 'a4', orientation: 'landscape', dpi: 150 });
      } catch (e) {
        ui.toast(`${t('PNG-Export fehlgeschlagen')}: ${e.message}`, 'error', 6000);
      }
    },
    async exportPdf() {
      try {
        await actions.runExport({ format: 'pdf', mode: 'view', paper: 'a4', orientation: 'landscape', dpi: 150 });
      } catch (e) {
        ui.toast(`${t('PDF-Export fehlgeschlagen')}: ${e.message}`, 'error', 6000);
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
      if (!navigator.geolocation) return ui.toast(t('Standortbestimmung nicht verfügbar.'), 'error');
      navigator.geolocation.getCurrentPosition(
        (pos) => map.flyTo([pos.coords.latitude, pos.coords.longitude], 16),
        () => ui.toast(t('Standort konnte nicht bestimmt werden.'), 'error'),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    },
  };

  tools.onCommentSelect = (id) => actions.focusComment(id);

  function exposureForDrawing() {
    const e = actions.exposure();
    if (!e) return null;
    return { list: buildings.list(), current: e.current.ids, proposed: e.proposed.ids, roads: e.roads.ids };
  }

  // --- Kommentare ---------------------------------------------------------------
  async function loadComments({ quiet = false } = {}) {
    if (!state.id) {
      state.comments = [];
      state.commentsLoadedFor = null;
      state.knownCommentIds = null;
      return;
    }
    try {
      const list = await api.comments(state.id);
      if (state.knownCommentIds && state.commentsLoadedFor === state.id) {
        const fresh = list.filter((c) => !state.knownCommentIds.has(c.id) && !local.commentToken(c.id));
        if (fresh.length && !quiet) {
          const c = fresh[fresh.length - 1];
          ui.toast(`${tn(fresh.length, 'Neuer Kommentar', '{n} neue Kommentare')}: ${c.author}: ${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}`, 'info', 6000);
        }
      }
      state.comments = list;
      state.knownCommentIds = new Set(list.map((c) => c.id));
      state.commentsLoadedFor = state.id;
    } catch (e) {
      if (e.status !== 404 && !quiet) ui.toast(`${t('Kommentare')}: ${e.message}`, 'error');
      state.comments = [];
    }
    map.requestRender();
    ui.refreshComments();
    if (state.pendingComment) {
      const id = state.pendingComment;
      state.pendingComment = null;
      if (state.comments.some((c) => c.id === id)) actions.focusComment(id);
    }
  }

  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (state.id && document.visibilityState === 'visible') await loadComments({ quiet: false });
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  // --- Push -----------------------------------------------------------------------
  async function initPush() {
    try {
      const info = await api.pushKey();
      state.push.serverEnabled = !!info.enabled;
      state.push.publicKey = info.publicKey || '';
    } catch {
      state.push.serverEnabled = false;
    }
    if (pushSupported()) {
      registerWorker();
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'open-comment') {
          const m = /#comment=([0-9a-z]+)/.exec(e.data.url || '');
          if (m) actions.focusComment(m[1]);
        }
      });
    }
    await refreshPushState();
  }

  async function refreshPushState() {
    const saved = state.id ? local.pushState(state.id) : null;
    let sub = null;
    if (pushSupported()) {
      try {
        sub = await currentSubscription();
      } catch {
        sub = null;
      }
    }
    state.push.subscribed = !!(saved && sub);
    state.push.role = saved ? saved.role : null;
    ui.refreshComments();
  }


  // --- Kartenquellen --------------------------------------------------------------
  function applyTileLayers() {
    const sources = state.tileSources;
    const base = sources.find((t) => t.id === settings.basemap && !t.overlay) || sources.find((t) => !t.overlay);
    if (!base) return;
    if (base.id !== settings.basemap) settings.basemap = base.id;
    map.setBaseLayer({ url: `/tiles/${base.id}/{z}/{x}/{y}.png`, maxNativeZoom: base.maxZoom || 19 });
    const active = [];
    for (const t of sources.filter((x) => x.overlay)) {
      const on = settings.overlays.includes(t.id);
      map.setTileOverlay(t.id, on ? { url: `/tiles/${t.id}/{z}/{x}/{y}.png`, maxNativeZoom: t.maxZoom || 19, minZoom: t.minZoom || 0, opacity: 0.9 } : null);
      if (on) active.push(t);
    }
    const attributions = [base, ...active].map((t) => t.attribution).filter((a, i, arr) => a && arr.indexOf(a) === i);
    map.setAttribution(attributions.map((a) => (a.includes('OpenStreetMap') ? '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende' : a)).join(' · '));
  }

  async function initTileSources() {
    try {
      const list = await api.tileSources();
      if (Array.isArray(list) && list.length) state.tileSources = list;
    } catch {
      // Standardquelle bleibt
    }
    applyTileLayers();
    ui.refreshTools();
  }

  // --- Live-Änderungen (Server-Sent Events) ---------------------------------------
  function applyServerDoc(res) {
    const d = deserialize(JSON.stringify(res.doc));
    const label = 'Serverstand übernehmen';
    tools.cancel();
    tools.setSelection(null);
    if (store.doc.features.length || store.doc.name !== d.name) {
      store.commit(label, (cur) => {
        cur.name = d.name;
        cur.layers = d.layers;
        cur.features = d.features;
        cur.route = d.route;
      });
    } else {
      store.load(d);
      map.requestRender();
    }
    if (!getLayer(store.doc, state.activeLayerId)) state.activeLayerId = store.doc.layers[0].id;
    state.serverUpdatedAt = res.updatedAt;
    state.savedKey = contentKey(store.doc);
    if (state.remoteUpdate) {
      state.remoteUpdate = null;
      ui.showBanner(null);
    }
    saveWorking();
    ui.refreshAll();
  }

  function connectEvents() {
    if (state.events) {
      state.events.close();
      state.events = null;
    }
    if (!state.id || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/drafts/${encodeURIComponent(state.id)}/events`);
    state.events = es;
    es.addEventListener('updated', async (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.clientId && data.clientId === state.clientId) return; // eigene Speicherung
      if (state.serverUpdatedAt && data.updatedAt === state.serverUpdatedAt) return;
      if (!actions.isDirty()) {
        try {
          const res = await api.getDraft(state.id);
          applyServerDoc(res);
          ui.toast(t('Der Entwurf wurde von jemand anderem gespeichert – Ansicht aktualisiert.'), 'info', 5000);
        } catch {
          // beim nächsten Speichern meldet der Server den Konflikt
        }
      } else {
        state.remoteUpdate = { updatedAt: data.updatedAt, versionCount: data.versionCount };
        ui.showBanner(t('Jemand anderes hat diesen Entwurf inzwischen gespeichert. Beim Speichern wirst du gefragt, welcher Stand gilt.'), t('Serverstand laden'), () => actions.reloadFromServer());
      }
    });
    es.addEventListener('comment', (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {
        data = {};
      }
      loadComments({ quiet: !!data.clientId && data.clientId === state.clientId });
    });
    es.onerror = () => {
      // Der Browser verbindet selbst neu; Kommentare werden ohnehin periodisch nachgeladen.
    };
  }

  function bind(id, token) {
    state.id = id;
    state.token = token;
    state.serverUpdatedAt = null;
    state.remoteUpdate = null;
    state.comments = [];
    state.activeCommentId = null;
    state.knownCommentIds = null;
    state.replyTo = null;
    tools.commentDraft = null;
    if (id) loadComments({ quiet: true });
    refreshPushState();
    connectEvents();
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
    if (zoom < OSM_MIN_ZOOM) return ui.setOsmStatus(t('OSM-Strassen ab Zoom {z}', { z: OSM_MIN_ZOOM }), 'muted');
    if (info && info.status === 'loading') return ui.setOsmStatus(t('Lade OSM-Strassen… ({n} Zellen)', { n: info.remaining || osm.remaining }), 'muted');
    if (info && info.status === 'error') return ui.setOsmStatus(`${t('OSM-Strassen')}: ${info.error.message}`, 'error');
    ui.setOsmStatus(t('{n} OSM-Strassen geladen', { n: osm.ways.size }), 'ok');
  }

  ui = new UI({ store, local, settings, tools, actions, map });

  // --- Reaktionen auf Änderungen ------------------------------------------------
  let autosaveTimer = null;
  const scheduleAutosave = () => {
    if (state.present) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveWorking, 400);
  };

  store.subscribe((d, event) => {
    if (event.type !== 'meta') {
      state.snapDirty = true;
      if (tools.selection && !getFeature(d, tools.selection.featureId)) tools.selection = null;
      if (tools.hover && !getFeature(d, tools.hover.featureId)) tools.setHover(null);
      if (!getLayer(d, state.activeLayerId)) state.activeLayerId = d.layers[0].id;
      if (state.phaseView && !(d.phases || []).some((ph) => ph.id === state.phaseView)) state.phaseView = null;
      map.requestRender();
      ui.refreshAll();
      ensureRouteNetwork();
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
  buildings.subscribe(() => {
    map.requestRender();
    ui.refreshAnalysis();
  });
  transit.subscribe(() => {
    map.requestRender();
    ui.refreshRoute();
  });
  parking.subscribe(() => ui.refreshAnalysis());

  map.on('moveend', () => {
    scheduleAutosave();
    ensureOsm();
    updateOsmStatus();
    ui.setCoords(null, map.getZoom());
  });
  map.on('pointermove', (e) => ui.setCoords(e.latlng, map.getZoom()));
  map.on('zoom', () => ui.setCoords(null, map.getZoom()));

  /** Kontextmenü für das Element unter dem Zeiger bzw. die ganze Auswahl. */
  function showMenuFor(info) {
    const doc = store.doc;
    const ids = info.ids;
    const feats = ids.map((id) => getFeature(doc, id)).filter(Boolean);
    const f = getFeature(doc, info.featureId);
    if (!f || !feats.length) return;
    const multi = feats.length > 1;
    const editable = canEdit();
    const items = [];
    items.push({ header: multi ? tn(feats.length, '{n} Element ausgewählt', '{n} Elemente ausgewählt') : t(featureLabel(f)) });
    items.push({ label: t('Hinzoomen'), action: () => actions.zoomToFeatures(ids) });
    items.push({ label: t('Eigenschaften'), action: () => ui.showTab('draw', { reveal: true }) });
    if (editable) {
      items.push({ separator: true }, { header: t('Ebene') });
      const layerIds = new Set(feats.map((x) => x.layerId));
      for (const l of doc.layers) items.push({ label: l.name, checked: layerIds.size === 1 && layerIds.has(l.id), action: () => actions.setFeaturesLayer(ids, l.id) });
      const roads = feats.filter((x) => x.type === 'road');
      if (roads.length) {
        items.push({ separator: true }, { header: t('Status') });
        const statuses = new Set(roads.map((x) => x.status));
        for (const st of STATUSES) items.push({ label: t(st.label), checked: statuses.size === 1 && statuses.has(st.id), action: () => actions.setFeaturesStatus(roads.map((x) => x.id), st.id) });
      }
      if (!multi && f.type === 'road' && info.segIndex !== null && info.segIndex !== undefined && f.segments[info.segIndex]) {
        const i = info.segIndex;
        items.push({ separator: true }, { header: t('Abschnitt {n}', { n: i + 1 }) });
        for (const lv of LEVELS) items.push({ label: t(lv.label), checked: f.segments[i].level === lv.id, action: () => actions.setSegmentLevel(f.id, i, lv.id) });
      }
      if (!multi && f.type === 'road') {
        items.push({ separator: true }, { header: t('Zugang') });
        for (const a of ROAD_ACCESS) items.push({ label: t(a.label), checked: (f.access || 'all') === a.id, action: () => actions.patchFeature(f.id, 'Zugang ändern', (x) => { x.access = a.id; }) });
      }
      if ((doc.phases || []).length) {
        items.push({ separator: true }, { header: t('Etappe') });
        const phases = new Set(feats.map((x) => x.phase || ''));
        items.push({ label: t('Alle Etappen'), checked: phases.size === 1 && phases.has(''), action: () => actions.setFeaturesPhase(ids, null) });
        doc.phases.forEach((ph, i) => items.push({ label: phaseLabel(ph, i), checked: phases.size === 1 && phases.has(ph.id), action: () => actions.setFeaturesPhase(ids, ph.id) }));
      }
      items.push({ separator: true }, { label: t('Löschen'), danger: true, action: () => tools.deleteSelection() });
    }
    const rect = map.container.getBoundingClientRect();
    ui.showContextMenu(items, { x: rect.left + info.point.x, y: rect.top + info.point.y });
  }

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
    if (ctrl && e.key.toLowerCase() === 'a' && tools.tool === 'select') {
      e.preventDefault();
      return tools.selectAll();
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

  window.addEventListener('beforeunload', () => {
    if (!state.present) saveWorking();
  });

  // --- Start ----------------------------------------------------------------------
  window.stadtplaner = { map, store, tools, local, osm, buildings, settings, actions, api, routes: () => state.routes, comments: () => state.comments, pollComments: () => loadComments(), state };
  if (state.present) {
    document.body.classList.add('present', 'sidebar-hidden');
    tools.setTool('select');
  } else if (window.matchMedia && window.matchMedia('(max-width: 860px)').matches) {
    document.body.classList.add('sidebar-hidden'); // Bottom-Sheet startet eingeklappt, die Tabs bleiben als Griff sichtbar
  }
  ui.refreshAll();
  connectEvents();
  if (store.doc.route || (store.doc.routePairs || []).length || store.doc.isochrone || (store.doc.busLines || []).length) {
    ensureRouteNetwork();
    recomputeRoutes();
  }
  if (state.id) loadComments({ quiet: true });
  initPush();
  initTileSources();
  schedulePoll();
  window.addEventListener('hashchange', () => {
    const m = /#comment=([0-9a-z]+)/.exec(location.hash);
    if (m) {
      history.replaceState(null, '', location.pathname);
      actions.focusComment(m[1]);
    }
  });
  ui.setStatus(TOOLS[0].hint);
  ui.setCoords(null, map.getZoom());
  ensureOsm();
  updateOsmStatus();
  if (loadError) ui.toast(loadError, 'error', 8000);
  if (state.present) {
    if (store.doc.features.length && !store.doc.route) {
      // Präsentation: den ganzen Vorschlag zeigen, nicht die zuletzt gespeicherte Ansicht
      const lats = [];
      const lngs = [];
      for (const f of store.doc.features) {
        const pts = f.type === 'road' || f.type === 'zone' ? f.nodes : [f.at || f.center];
        for (const p of pts) {
          lats.push(p[0]);
          lngs.push(p[1]);
        }
      }
      map.fitBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) }, { padding: 80, maxZoom: 17 });
    }
  } else if (openedFromLink && !canEdit()) {
    ui.showBanner(t('Nur Ansicht: Dieser Entwurf wurde mit dir geteilt. Lege eine eigene Kopie an, um ihn zu bearbeiten.'), t('Eigene Kopie anlegen'), () => actions.makeOwnCopy());
  } else if (openedFromLink) {
    ui.showTab('drafts');
  }
}

main().catch((e) => {
  console.error(e);
  alert(`Der Stadtplaner konnte nicht starten / n'a pas pu démarrer / non è partito: ${e.message}`);
});
