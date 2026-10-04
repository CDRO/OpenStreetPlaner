// Einstiegspunkt: verdrahtet Karte, Zustand, Werkzeuge, Server-API und UI.

import { SlippyMap } from './map.js';
import { drawScene } from './draw.js';
import { Store } from './store.js';
import { LocalState } from './local.js';
import { api, setClientId } from './api.js';
import {
  cloneDocument, createBusLine, createDocument, createLayer, deserialize, getFeature, getLayer, moveLayer, removeLayer, toGeoJSON, adoptBusRoute, MAX_BUS_LINES, featureLabel, STATUSES, LEVELS, ROAD_ACCESS, docForPhase, createPhase, removePhase, phaseLabel, featureInPhase, VEHICLES,
  groupFeatures, ungroupFeatures,
} from './model.js';
import { buildSnapIndex } from './snap.js';
import { MAX_CELLS, OSM_MIN_ZOOM, OsmRoadCache, OsmTransitCache, cellsFor, routeBounds } from './osm.js';
import { ToolController, TOOLS } from './tools.js';
import { UI } from './ui.js';
import { computeAll, computeRace, computeRoutes, formatDuration } from './routing.js';
import { RACE_MODES, RACE_SPEEDS, buildRunners, raceDuration, raceSnapshot, suggestedSpeed } from './race.js';
import { toDXF } from './dxf.js';
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
import { mergeFeatures, mergeKind } from './merge.js';
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
    expiresAt: null, // Lebenszyklus: wann der Server den Entwurf löscht (null = nie)
    retentionDays: 0,
    reminder: null, // { email, mailEnabled } vom Server, nur für Besitzer
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
    vehicle: 'car', // Verkehrsmittel für die nächste Hauptroute
    race: null, // Fahrt-Animation { kind, id, mode, speed, status, t, runners, duration, results, stale }
    adoptActive: false, // Werkzeug „OSM übernehmen“ aktiv: OSM-Strassen im Einrast-Index
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
      state.expiresAt = res.expiresAt || null;
      state.retentionDays = res.retentionDays || 0;
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
  // Ablaufdatum aus Serverantworten übernehmen; die Erinnerung gilt für den gespeicherten Stand
  function applyLifecycle(res) {
    state.expiresAt = (res && res.expiresAt) || null;
    state.retentionDays = (res && res.retentionDays) || 0;
    if (state.reminder) state.reminder.expiresAt = state.expiresAt;
  }

  const getSnapIndex = () => {
    if (state.snapDirty || !state.snapIndex) {
      // OSM-Strassen im Index, wenn Einrasten an OSM aktiv ist oder das Werkzeug „OSM übernehmen“ sie braucht
      state.snapIndex = buildSnapIndex(store.doc, { osmWays: osm.list(), includeOsm: settings.snapOsm || state.adoptActive });
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
    getDefaultVehicle: () => state.vehicle,
    getDefaultZoneKind: () => state.defaultZoneKind,
    getComments: () => (settings.showComments ? state.comments : []),
    canEdit,
    onSelectionChange: (sel) => {
      if (!ui) return;
      ui.refreshProperties();
      if (sel) ui.showTab('draw'); // Eigenschaften liegen im Zeichnen-Tab
    },
    onToolChange: (id) => {
      state.adoptActive = id === 'adopt';
      state.snapDirty = true; // Index je nach Werkzeug mit oder ohne OSM-Strassen
      if (!ui) return;
      ui.refreshTools();
      ui.refreshDrawActions();
      ensureOsm(); // „OSM übernehmen“ braucht das Netz der Ansicht
      updateOsmStatus();
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
    showOsm: settings.showOsm || tools.tool === 'adopt',
    osmHover: tools.osmHover ? tools.osmHover.way : null,
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
    race: raceScene(),
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
  // Routing im Web Worker (Hauptfaden bleibt flüssig); Fallback im Hauptfaden, wenn Worker fehlen oder scheitern.
  let worker = null;
  let workerBroken = false;
  let jobCounter = 0;
  const raceJobs = new Map(); // laufende Rennen-Berechnungen im Worker: id -> { job, resolve }
  function routingWorker() {
    if (workerBroken || typeof globalThis.Worker === 'undefined') return null;
    if (worker) return worker;
    try {
      worker = new globalThis.Worker('/static/js/routing.worker.js', { type: 'module' });
    } catch {
      workerBroken = true;
      return null;
    }
    worker.onmessage = (e) => {
      const { id, kind, result, error } = e.data || {};
      if (kind === 'race') {
        const pending = raceJobs.get(id);
        if (!pending) return;
        raceJobs.delete(id);
        pending.resolve(error ? computeRace(pending.job) : result);
        return;
      }
      if (id !== state.routeJob) return; // veraltet
      if (error) applyRouteResults(computeAll(state.routeJobPayload));
      else applyRouteResults(result);
    };
    worker.onerror = () => {
      // Modul-Worker nicht verfügbar oder Fehler beim Laden: ab jetzt im Hauptfaden rechnen
      workerBroken = true;
      try { worker.terminate(); } catch { /* egal */ }
      worker = null;
      if (state.routeJobPayload) applyRouteResults(computeAll(state.routeJobPayload));
      for (const [id, pending] of raceJobs) {
        raceJobs.delete(id);
        pending.resolve(computeRace(pending.job));
      }
    };
    return worker;
  }

  /** Strecke je Verkehrsmittel für die Fahrt-Animation, im Worker wenn möglich. */
  function runRaceJob(job) {
    const w = routingWorker();
    if (!w) return Promise.resolve(computeRace(job));
    return new Promise((resolve) => {
      const id = ++jobCounter;
      raceJobs.set(id, { job, resolve });
      try {
        w.postMessage({ id, kind: 'race', job });
      } catch {
        raceJobs.delete(id);
        workerBroken = true;
        resolve(computeRace(job));
      }
    });
  }

  function applyRouteResults(res) {
    state.busResults = res.busResults || [];
    state.routes = res.routes;
    state.pairResults = res.pairResults || [];
    state.iso = res.iso;
    state.routeJobPayload = null;
    clearTimeout(state.routeProgressTimer);
    map.requestRender();
    if (ui) {
      ui.progressDone('route');
      ui.refreshRoute();
      ui.refreshPresent();
    }
  }

  function recomputeRoutes() {
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => {
      const doc = effectiveDoc();
      const job = { osmWays: osm.list(), doc, model: settings.speedModel };
      const w = routingWorker();
      if (!w) return applyRouteResults(computeAll(job));
      state.routeJob = ++jobCounter;
      state.routeJobPayload = job;
      // Fortschritt erst zeigen, wenn die Rechnung spürbar dauert
      clearTimeout(state.routeProgressTimer);
      state.routeProgressTimer = setTimeout(() => { if (state.routeJobPayload && ui) ui.progress('route', { label: t('Routen werden berechnet…') }); }, 300);
      try {
        w.postMessage({ id: state.routeJob, job });
      } catch {
        workerBroken = true;
        applyRouteResults(computeAll(job));
      }
      return undefined;
    }, 120);
  }

  // --- Fahrt-Animation („Abfahren“) ---------------------------------------------------
  /** Startet die Uhr; die Fahrzeuge folgen der Zeitachse des Routen-Rechners im Zeitraffer. */
  function launchRace(race, results, { title = '' } = {}) {
    const runners = buildRunners(results, { mode: race.mode });
    const duration = raceDuration(runners);
    Object.assign(race, { results, runners, duration, title, t: 0, stale: false, status: runners.length ? 'running' : 'empty', lastTick: null, frame: null });
    if (!race.speed) race.speed = suggestedSpeed(duration);
    if (runners.length) {
      // Alle Strecken ins Bild
      const lats = [];
      const lngs = [];
      for (const r of runners) for (const p of r.path) { lats.push(p[0]); lngs.push(p[1]); }
      const b = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
      const view = map.getBounds();
      const inside = b.south >= view.south && b.north <= view.north && b.west >= view.west && b.east <= view.east;
      if (!inside) map.fitBounds(b, { padding: 60, maxZoom: 17 });
      race.frame = requestAnimationFrame(raceTick);
    }
    ui.refreshRace();
    map.requestRender();
  }

  function raceTick(now) {
    const r = state.race;
    if (!r || r.status !== 'running') return;
    if (r.lastTick !== null) r.t = Math.min(r.duration, r.t + ((now - r.lastTick) / 1000) * r.speed);
    r.lastTick = now;
    if (r.t >= r.duration) r.status = 'done';
    map.requestRender();
    if (r.status === 'running') {
      ui.updateRaceClock();
      r.frame = requestAnimationFrame(raceTick);
    } else {
      r.frame = null;
      ui.refreshRace();
    }
  }

  function stopRaceClock() {
    const r = state.race;
    if (r && r.frame) cancelAnimationFrame(r.frame);
    if (r) r.frame = null;
  }

  /** Momentaufnahme fürs Zeichnen (Positionen, Spuren, Ränge) oder null. */
  function raceScene() {
    const r = state.race;
    if (!r || !r.runners || !r.runners.length) return null;
    return { runners: raceSnapshot(r.runners, r.t), mode: r.mode, status: r.status };
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
      ui.progress('parcels', { label: t('Parzellen werden abgefragt…') });
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
        ui.progressDone('parcels', summary.items.length ? tn(summary.items.length, '{n} Parzelle berührt.', '{n} Parzellen berührt.') : t('Keine Parzellen gefunden (amtliche Vermessung deckt nur die Schweiz ab).'));
      } catch (e) {
        ui.progressDone('parcels');
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
      ui.progress('variants', { label: t('Varianten werden verglichen…') });
      // Rechnet im Hauptfaden: erst die Fortschrittsanzeige zeichnen lassen
      setTimeout(() => {
        try {
          state.variants = compareVariants({ doc: store.doc, osmWays: osm.list(), model: settings.speedModel, buildings: buildings.list(), radiusM: settings.exposureRadius });
          ui.progressDone('variants', t('Variantenvergleich fertig.'));
        } catch (e) {
          ui.progressDone('variants');
          ui.toast(`${t('Variantenvergleich')}: ${e.message}`, 'error', 6000);
        }
        ui.refreshAnalysis();
      }, 30);
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
      if (format === 'dxf') {
        download(`${safeFilename(store.doc.name)}.dxf`, toDXF(store.doc), 'application/dxf');
        return;
      }
      const onProgress = (done, total) => ui.progress('export', { label: t('Export: Kacheln laden…'), done, total });
      const opts = { mode, paper, orientation, dpi, scale, routes: actions.routes(), pairs: state.pairResults, busLines: state.busResults, isochrone: state.iso, link: state.id ? `${location.origin}/d/${state.id}` : '', comments: state.comments, checks: actions.runChecks(), exposure: actions.exposure(), confidence: confidence ? actions.confidences() : null, variants: state.variants, parking: actions.parkingBalance(), phases: actions.phaseTable(), onProgress };
      ui.progress('export', { label: t('Export wird vorbereitet…') });
      let blob;
      try {
        if (format === 'pdf' && report) blob = await exportReport(map, store.doc, opts);
        else if (format === 'pdf') blob = await exportPdf(map, store.doc, opts);
        else blob = await exportPng(map, store.doc, opts);
      } catch (e) {
        ui.progressDone('export');
        throw e;
      }
      ui.progressDone('export', t('{format} erstellt.', { format: format.toUpperCase() }));
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
      ui.progress('profile', { label: t('Höhenprofil wird geladen…') });
      try {
        const res = await api.profile(road.nodes);
        const key = nodesKey(road.nodes);
        store.commit('Höhenprofil laden', (d) => {
          const r = getFeature(d, id);
          if (r) r.profile = { points: res.points, key };
        });
        ui.progressDone('profile', t('Höhenprofil geladen.'));
      } catch (e) {
        ui.progressDone('profile');
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
    /** Gruppieren: die Elemente werden fortan zusammen ausgewählt, verschoben und gelöscht. */
    groupFeatures(ids) {
      if (!actions.requireEdit() || ids.length < 2) return;
      let gid = null;
      store.commit('Elemente gruppieren', (d) => { gid = groupFeatures(d, ids); });
      if (gid) {
        tools.setSelection({ featureId: ids[0], segIndex: null });
        ui.toast(tn(tools.multi.size, 'Gruppe mit {n} Element.', 'Gruppe mit {n} Elementen.'), 'ok');
      }
    },
    /** Flächen vereinigen oder Strassen verbinden; die erste bleibt und wird ausgewählt. */
    mergeFeatures(ids) {
      if (!actions.requireEdit()) return;
      const kind = mergeKind(store.doc, ids);
      if (!kind) return ui.toast(t('Nur Flächen mit Flächen oder Strassen mit Strassen lassen sich zusammenführen.'), 'error');
      let result = null;
      let error = null;
      store.commit(kind === 'zone' ? 'Flächen vereinigen' : 'Strassen verbinden', (d) => {
        try {
          result = mergeFeatures(d, ids);
        } catch (e) {
          error = e;
        }
      });
      if (error) return ui.toast(t(error.message), 'error', 6000);
      tools.setSelection({ featureId: result.id, segIndex: null });
      ui.toast(kind === 'zone' ? t('Flächen vereinigt.') : t('Strassen verbunden.'), 'ok');
      return undefined;
    },
    ungroupFeatures(ids) {
      if (!actions.requireEdit()) return;
      store.commit('Gruppe auflösen', (d) => ungroupFeatures(d, ids));
      if (tools.selection) tools.setSelection({ featureId: tools.selection.featureId, segIndex: tools.selection.segIndex });
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
          applyLifecycle(res);
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
          applyLifecycle(res);
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
        applyLifecycle(res);
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
        applyLifecycle(res);
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
    // --- Lebenszyklus: Ablauf, Erinnerung per E-Mail, Sicherung -------------------
    lifecycle: () => ({ expiresAt: state.expiresAt, retentionDays: state.retentionDays, reminder: state.reminder }),
    async loadReminder() {
      if (!state.id || !state.token || state.reminder) return state.reminder;
      try {
        const res = await api.reminder(state.id, state.token);
        state.reminder = { email: res.email || '', mailEnabled: !!res.mailEnabled };
        applyLifecycle(res);
      } catch (e) {
        state.reminder = { email: '', mailEnabled: false, error: e.message };
      }
      return state.reminder;
    },
    async setReminderEmail(email) {
      if (!state.id || !state.token) throw new Error(t('Entwurf ist nicht gespeichert'));
      const res = await api.setReminder(state.id, state.token, (email || '').trim());
      state.reminder = { email: res.email || '', mailEnabled: !!res.mailEnabled };
      applyLifecycle(res);
      ui.toast(res.email ? t('Erinnerung geht an {email}.', { email: res.email }) : t('Erinnerung entfernt.'), 'ok');
      return state.reminder;
    },
    async downloadBackup() {
      if (!state.id) return ui.toast(t('Zuerst speichern – die Sicherung kommt vom Server und enthält auch Versionen und Kommentare.'), 'info', 6000);
      if (actions.isDirty() && canEdit()) {
        await actions.saveDraft('Vor der Sicherung gespeichert');
        if (actions.isDirty()) return undefined; // Speichern fehlgeschlagen oder abgebrochen
      }
      const a = document.createElement('a');
      a.href = api.backupUrl(state.id);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      ui.toast(t('Sicherung wird heruntergeladen; über „Importieren“ lässt sie sich als neuer Entwurf einspielen.'), 'ok', 6000);
      return undefined;
    },
    exportGeoJson() {
      download(`${safeFilename(store.doc.name)}.geojson`, JSON.stringify(toGeoJSON(store.doc), null, 2), 'application/geo+json');
    },
    async importFile(file) {
      try {
        const text = await file.text();
        const parsed = parseImport(text, file.name);
        if (parsed.format === 'backup') {
          if (!actions.confirmDiscard()) return;
          const res = await api.importBackup(parsed.raw);
          local.rememberDraft({ id: res.id, name: res.name, token: res.editToken, updatedAt: res.updatedAt });
          saveWorking();
          ui.toast(t('Sicherung eingespielt – „{name}“ wird als neuer Entwurf geöffnet.', { name: res.name }), 'ok');
          location.href = `/d/${res.id}#edit=${res.editToken}`;
          return;
        }
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
        d.routePairs.push({ id, name: `${t('Paar')} ${n + 1}`, from: null, to: null, vehicle: state.vehicle });
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
    /** Fahrplan-Abgleich: direkte Busfahrten zwischen erster und letzter Haltestelle laut Fahrplan. */
    async checkTimetable(id) {
      if (!actions.requireEdit()) return;
      const line = (store.doc.busLines || []).find((x) => x.id === id);
      const stops = line ? line.stops.map((sid) => getFeature(store.doc, sid)).filter((f) => f && f.at) : [];
      if (stops.length < 2) return ui.toast(t('Mindestens zwei Haltestellen für den Fahrplan-Abgleich.'), 'error');
      state.timetableBusy = id;
      ui.progress('timetable', { label: t('Fahrplan wird abgefragt…') });
      ui.refreshRoute();
      try {
        const tt = await api.timetable(stops[0].at, stops[stops.length - 1].at, line.name);
        actions.patchBusLine(id, 'Fahrplan abgleichen', (l) => { l.schedule = { seconds: tt.median, trips: tt.trips, at: new Date().toISOString(), from: tt.from.name, to: tt.to.name }; });
        ui.toast(t('Fahrplan: {min} von {from} nach {to} ({n} Fahrten).', { min: formatDuration(tt.median), from: tt.from.name, to: tt.to.name, n: tt.trips }));
      } catch (e) {
        ui.toast(`${t('Fahrplan-Abgleich')}: ${e.message}`, 'error', 6000);
      } finally {
        state.timetableBusy = null;
        ui.progressDone('timetable');
        ui.refreshRoute();
      }
      return undefined;
    },
    timetableBusy: () => state.timetableBusy,
    /** Haltezeit so setzen, dass das Modell heute die Fahrplanzeit trifft (Fahrzeit ohne Halte bleibt). */
    calibrateDwell(id) {
      const line = (store.doc.busLines || []).find((x) => x.id === id);
      const r = state.busResults.find((x) => x.id === id);
      if (!line || !line.schedule || !r || !r.current || r.current.error) return;
      const mids = Math.max(0, line.stops.length - 2);
      if (!mids) return ui.toast(t('Ohne Zwischenhalte lässt sich keine Haltezeit kalibrieren.'), 'error');
      const driving = r.current.time - line.dwell * mids;
      const dwell = Math.max(0, Math.min(300, Math.round((line.schedule.seconds - driving) / mids)));
      actions.patchBusLine(id, 'Haltezeit kalibrieren', (l) => { l.dwell = dwell; });
      return undefined;
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
          return r ? travelTimeConfidence([r.current, r.proposed], { networkLoading, dwell: l ? l.dwell : null, schedule: l && l.schedule && r.current && !r.current.error ? { seconds: l.schedule.seconds, model: r.current.time, trips: l.schedule.trips } : null }) : null;
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
    /** Verkehrsmittel der Hauptroute (und Vorgabe für die nächste). */
    routeVehicle: () => (store.doc.route && store.doc.route.vehicle) || state.vehicle,
    setRouteVehicle(v) {
      state.vehicle = VEHICLES.some((x) => x.id === v) ? v : 'car';
      if (store.doc.route) actions.commitDoc('Verkehrsmittel ändern', (d) => { if (d.route) d.route.vehicle = state.vehicle; });
      else ui.refreshRoute();
    },
    setPairVehicle(id, v) {
      actions.commitDoc('Verkehrsmittel des Paars ändern', (d) => {
        const p = (d.routePairs || []).find((x) => x.id === id);
        if (p) p.vehicle = VEHICLES.some((x) => x.id === v) ? v : 'car';
      });
    },
    race: () => state.race,
    raceScene,
    /** Fahrt-Animation starten: Hauptroute je Verkehrsmittel oder eine Buslinie (heute gegen neu). */
    async startRace({ kind = 'route', id = null, mode = null } = {}) {
      const prev = state.race;
      stopRaceClock();
      const m = RACE_MODES.includes(mode) ? mode : prev && prev.kind === kind ? prev.mode : 'both';
      const speed = prev && RACE_SPEEDS.includes(prev.speed) ? prev.speed : null;
      if (kind === 'bus') {
        const line = (store.doc.busLines || []).find((l) => l.id === id);
        const r = state.busResults.find((x) => x.id === id);
        if (!line || !r) {
          ui.toast(t('Für diese Linie liegt noch keine Fahrzeit vor (mindestens zwei Haltestellen, Netz geladen).'), 'error', 5000);
          return;
        }
        state.race = { kind, id, mode: m, speed, status: 'loading', t: 0, runners: [], duration: 0, results: null, stale: false };
        launchRace(state.race, { bus: { current: r.current, proposed: r.proposed } }, { title: `${t('Linie')} ${line.name}` });
        return;
      }
      const q = store.doc.route;
      if (!q) {
        ui.toast(t('Zuerst Start und Ziel der Route setzen.'), 'error');
        return;
      }
      const race = { kind: 'route', id: null, mode: m, speed, status: 'loading', t: 0, runners: [], duration: 0, results: null, stale: false };
      state.race = race;
      ui.refreshRace();
      ui.progress('race', { label: t('Fahrt wird vorbereitet…') });
      const job = { osmWays: osm.list(), doc: effectiveDoc(), model: settings.speedModel, from: q.from, to: q.to };
      const results = await runRaceJob(job);
      if (state.race !== race) return; // inzwischen abgebrochen oder neu gestartet
      ui.progressDone('race');
      launchRace(race, results);
      if (race.status === 'empty') ui.toast(t('Keine fahrbare Strecke für die Animation (Strassennetz geladen?).'), 'error', 5000);
    },
    raceSetMode(mode) {
      const r = state.race;
      if (!r || !RACE_MODES.includes(mode)) return;
      stopRaceClock();
      r.mode = mode;
      if (r.results) launchRace(r, r.results, { title: r.title });
    },
    raceSetSpeed(speed) {
      const r = state.race;
      if (!r || !RACE_SPEEDS.includes(speed)) return;
      r.speed = speed;
      ui.refreshRace();
    },
    /** Pause oder weiter; am Ende startet die Fahrt von vorn. */
    raceToggle() {
      const r = state.race;
      if (!r || !r.runners.length) return;
      if (r.status === 'running') {
        stopRaceClock();
        r.status = 'paused';
      } else {
        if (r.status === 'done') r.t = 0;
        r.status = 'running';
        r.lastTick = null;
        r.frame = requestAnimationFrame(raceTick);
      }
      ui.refreshRace();
      map.requestRender();
    },
    raceRestart() {
      const r = state.race;
      if (!r) return;
      if (r.stale || !r.results) return actions.startRace({ kind: r.kind, id: r.id, mode: r.mode });
      stopRaceClock();
      launchRace(r, r.results, { title: r.title });
      return undefined;
    },
    /** Zur Modellzeit springen (Sekunden), z. B. von der Zeitleiste. */
    raceSeek(seconds) {
      const r = state.race;
      if (!r || !r.runners.length) return;
      r.t = Math.min(r.duration, Math.max(0, Number(seconds) || 0));
      if (r.status === 'done' && r.t < r.duration) r.status = 'paused';
      ui.updateRaceClock();
      map.requestRender();
    },
    stopRace() {
      stopRaceClock();
      state.race = null;
      ui.refreshRace();
      map.requestRender();
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
    state.expiresAt = null;
    state.retentionDays = 0;
    state.reminder = null;
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
    if (!settings.snapOsm && !settings.showOsm && tools.tool !== 'adopt') return;
    osm.ensure(map.getBounds(), map.getZoom());
  }

  function updateOsmStatus(info) {
    const zoom = map.getZoom();
    if (!settings.snapOsm && !settings.showOsm && tools.tool !== 'adopt') return ui.setOsmStatus('');
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
      if (state.race && !state.race.stale) {
        // Strecke oder Netz haben sich geändert: die laufende Fahrt bleibt, „Neu starten“ rechnet neu
        state.race.stale = true;
        ui.refreshRace();
      }
      map.requestRender();
      ui.refreshAll();
      ensureRouteNetwork();
      recomputeRoutes();
    }
    scheduleAutosave();
  });

  /** Fortschritt eines Zellen-Speichers in der Statusleiste: Zellen geladen/gesamt, danach eine kurze Meldung. */
  function trackProgress(id, label, done) {
    return (info) => {
      if (info.status === 'loading') ui.progress(id, { label: t(label), done: info.done, total: info.total });
      else if (info.status === 'ready') ui.progressDone(id, done(info));
      else if (info.status === 'error') ui.progressDone(id, `${t(label).replace(/…$/, '')}: ${info.error && info.error.message ? info.error.message : t('fehlgeschlagen')}`, 'error');
    };
  }
  const osmProgress = trackProgress('osm', 'Strassennetz laden…', (info) => t('Strassennetz geladen: {n} Strassen.', { n: info.count }));
  const buildingsProgress = trackProgress('buildings', 'Gebäude laden…', (info) => t('{n} Gebäude geladen.', { n: info.count }));
  const transitProgress = trackProgress('transit', 'Haltestellen laden…', (info) => t('{n} Haltestellen aus OSM geladen.', { n: info.count }));
  const parkingProgress = trackProgress('parking', 'Parkplätze laden…', (info) => t('{n} OSM-Parkplätze geladen.', { n: info.count }));
  osm.subscribe((info) => {
    state.snapDirty = true;
    map.requestRender();
    updateOsmStatus(info);
    osmProgress(info);
    if (info.status !== 'loading') recomputeRoutes();
    ui.refreshRoute();
  });
  buildings.subscribe((info) => {
    buildingsProgress(info);
    map.requestRender();
    ui.refreshAnalysis();
  });
  transit.subscribe((info) => {
    transitProgress(info);
    map.requestRender();
    ui.refreshRoute();
  });
  parking.subscribe((info) => {
    parkingProgress(info);
    ui.refreshAnalysis();
  });

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
    const rect = map.container.getBoundingClientRect();
    if (info.osmWay) {
      // Rechtsklick auf eine OSM-Strasse: übernehmen oder als Rückbau übernehmen
      const tags = info.osmWay.tags || {};
      const name = tags.name || tags.ref || t('ohne Namen');
      const items = [{ header: `OSM: ${name} (${tags.highway || 'way'})` }];
      if (canEdit()) {
        items.push({ label: t('OSM-Strasse übernehmen'), action: () => tools.adoptWay(info.osmWay, 'existing') });
        items.push({ label: t('OSM-Strasse als Rückbau übernehmen'), action: () => tools.adoptWay(info.osmWay, 'remove') });
      } else {
        items.push({ label: t('Nur Ansicht'), disabled: true });
      }
      ui.showContextMenu(items, { x: rect.left + info.point.x, y: rect.top + info.point.y });
      return;
    }
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
      const mk = multi ? mergeKind(doc, ids) : null;
      if (mk) items.push({ separator: true }, { label: mk === 'zone' ? t('Flächen vereinigen') : t('Strassen verbinden'), action: () => actions.mergeFeatures(ids) });
      const groups = new Set(feats.map((x) => x.group).filter(Boolean));
      if (multi || groups.size) {
        items.push({ separator: true }, { header: t('Gruppe') });
        if (multi && !(groups.size === 1 && feats.every((x) => x.group))) items.push({ label: t('Gruppieren'), action: () => actions.groupFeatures(ids) });
        if (groups.size) items.push({ label: t('Gruppe auflösen'), action: () => actions.ungroupFeatures(ids) });
      }
      if ((doc.phases || []).length) {
        items.push({ separator: true }, { header: t('Etappe') });
        const phases = new Set(feats.map((x) => x.phase || ''));
        items.push({ label: t('Alle Etappen'), checked: phases.size === 1 && phases.has(''), action: () => actions.setFeaturesPhase(ids, null) });
        doc.phases.forEach((ph, i) => items.push({ label: phaseLabel(ph, i), checked: phases.size === 1 && phases.has(ph.id), action: () => actions.setFeaturesPhase(ids, ph.id) }));
      }
      items.push({ separator: true }, { label: t('Löschen'), danger: true, action: () => tools.deleteSelection() });
    }
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
  // Offline-Schale: App-Dateien werden gecacht, die Arbeitskopie bleibt nutzbar. Nach einem Release übernimmt
  // der neue Worker sofort; die Seite lädt neu (ohne ungesicherte Änderungen von selbst, sonst mit Hinweis).
  registerWorker({
    onUpdate: () => {
      if (!actions.isDirty() || state.present) {
        if (!state.present) saveWorking();
        location.reload();
        return;
      }
      ui.showBanner(t('Neue Version des Stadtplaners ist da. Die Arbeitskopie bleibt erhalten – jetzt neu laden?'), t('Neu laden'), () => { saveWorking(); location.reload(); });
    },
  });
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
