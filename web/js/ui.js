// Seitenleiste, Kopfzeile, Statuszeile, Dialoge. Reine DOM-Arbeit; die Logik
// steckt in app.js (actions) und den Modulen.

import { JUNCTION_KINDS, LEVELS, ROAD_KINDS, SECTION_LIMITS, STATUSES, ZONE_KINDS, defaultSection, docStats, featureLabel, getFeature, junctionKind, junctionTurns, roadKind, roadSpeed, roadWidthMeters, sectionSummary, sectionWidth, segmentSpeed, splitRoadAtNode, validProfile } from './model.js';
import { DPI, PAPER, SCALES } from './export.js';
import { qrSvg } from './qr.js';
import { featureTitle } from './diff.js';
import { COST_ITEMS, costValue, formatChf } from './costs.js';
import { parcelLabel, validParcels } from './parcels.js';
import { ISO_COLORS, ISO_DIFF_COLORS } from './draw.js';
import { ISOCHRONE_PRESETS, ROAD_ACCESS, VEHICLES, segmentAccess, normalizeLines, getLayer, phaseLabel } from './model.js';
import { haversine, pathLength } from './geometry.js';
import { segmentGrades } from './speedmodel.js';
import { TOOLS, formatLength } from './tools.js';
import { formatDuration } from './routing.js';
import { RACE_SPEEDS, formatClock } from './race.js';
import { mergeKind } from './merge.js';
import { LANGUAGES, getLanguage, locale, t, tn } from './i18n.js';
import { confidenceLabel, confidenceText, staticConfidence, transitRouteConfidence } from './confidence.js';
import { icon, mountIcons } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Zuversicht als aufklappbare Zeile: Stufe, Band und die Gründe. */
function confidenceBlock(conf) {
  if (!conf) return '';
  const head = `${confidenceLabel(conf.level)}${conf.band ? ` (±${conf.band} %)` : ''}`;
  return `<details class="conf conf-${conf.level}"><summary><span class="conf-dot"></span>${esc(head)}</summary><ul class="conf-reasons">${(conf.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>`;
}

/** Zuversicht als Punkt mit Tooltip (für Tabellenzellen und Listen). */
function confidenceDot(conf) {
  if (!conf) return '';
  return `<span class="conf-dot conf-${conf.level}" title="${esc(confidenceText(conf))}" aria-label="${esc(confidenceLabel(conf.level))}"></span>`;
}
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
};
const fmtDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale(), { dateStyle: 'medium' });
};
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const options = (list, value) => list.map((o) => `<option value="${o.id}"${o.id === value ? ' selected' : ''}>${esc(t(o.label))}</option>`).join('');

function safeQr(url) {
  try {
    return `<span class="qr">${qrSvg(url, { size: 128 })}</span>`;
  } catch {
    return '';
  }
}

/** Weitere Routenpaare mit Ergebnistabelle und Summen. */
/** Fahrplan-Abgleich einer Buslinie: Fahrplanzeit, Abweichung des Modells heute, Kalibrierung der Haltezeit. */
function scheduleRow(line, cur, actions, editable) {
  const dis = editable ? '' : 'disabled';
  const busy = actions.timetableBusy() === line.id;
  const sc = line.schedule;
  let text = `<span class="muted small">${t('Fahrplan noch nicht abgeglichen.')}</span>`;
  if (sc) {
    const dev = cur ? Math.round(((cur.time - sc.seconds) / sc.seconds) * 100) : null;
    const cls = dev === null ? '' : Math.abs(dev) <= 15 ? 'ok' : Math.abs(dev) > 30 ? 'warn' : 'muted';
    text = `<span class="badge ${cls}" title="${esc(`${sc.from} → ${sc.to}`)}">${t('Fahrplan')} ${formatDuration(sc.seconds)}</span> <span class="muted small">${tn(sc.trips, '{n} Fahrt', '{n} Fahrten')}${dev === null ? '' : ` · ${t('Modell heute')} ${dev > 0 ? '+' : ''}${dev} %`}</span>`;
  }
  return `<div class="schedule-row">${text}
    <button type="button" class="btn small bus-race" data-id="${esc(line.id)}" title="${t('Die Linie heute und neu im Zeitraffer abfahren')}">${t('Abfahren')}</button>
    <button type="button" class="btn small bus-timetable" data-id="${esc(line.id)}" ${dis || busy ? 'disabled' : ''}>${busy ? t('Abgleich läuft…') : t('Fahrplan abgleichen')}</button>
    ${sc && cur && line.stops.length > 2 ? `<button type="button" class="btn small bus-calibrate" data-id="${esc(line.id)}" title="${t('Haltezeit so setzen, dass das Modell heute die Fahrplanzeit trifft')}" ${dis}>${t('Haltezeit kalibrieren')}</button>` : ''}
  </div>`;
}

/** Anteil der Strecke auf schnellen Strassen ohne Velostreifen bzw. Trottoir (nur Velo und zu Fuss). */
function unsafeShare(r) {
  if (!r || r.error || !r.quality || !r.quality.dist) return null;
  if (r.quality.vehicle !== 'bike' && r.quality.vehicle !== 'foot') return null;
  return Math.round((r.quality.unsafeDist / r.quality.dist) * 100);
}

function unsafeNote(res) {
  if (!res) return '';
  const cur = unsafeShare(res.current);
  const neu = unsafeShare(res.proposed);
  if (cur === null && neu === null) return '';
  const cls = (v) => (v === null ? '' : v > 50 ? 'warn' : v > 20 ? 'muted' : 'ok');
  return `<div class="small unsafe"><span class="badge ${cls(neu ?? cur)}" title="${t('Anteil auf schnellen Strassen ohne Velostreifen bzw. Trottoir')}">${t('unsicher')} ${cur === null ? '–' : `${cur} %`} → ${neu === null ? '–' : `${neu} %`}</span></div>`;
}

function pairsSection(doc, actions, tools, geometry) {
  const pairs = doc.routePairs || [];
  const results = actions.pairResults();
  const editable = actions.canEdit();
  const dis = editable ? '' : 'disabled';
  const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
  const capturing = tools.routeTarget && tools.routeTarget.pairId;
  let sumDelta = 0;
  let count = 0;
  const rows = pairs.map((p, i) => {
    const r = results.find((x) => x.id === p.id);
    const cur = r && r.current && !r.current.error ? r.current : null;
    const neu = r && r.proposed && !r.proposed.error ? r.proposed : null;
    let delta = '–';
    if (cur && neu) {
      const d = neu.time - cur.time;
      sumDelta += d;
      count++;
      delta = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${formatDuration(Math.abs(d))}`;
    }
    const state = !p.from || !p.to ? `<span class="muted small">${t('Start und Ziel setzen')}</span>` : '';
    return `<tr class="${capturing === p.id ? 'active' : ''}">
      <td>${i + 1}</td>
      <td><input type="text" class="pair-name" data-id="${esc(p.id)}" value="${esc(p.name)}" ${dis}> <select class="pair-vehicle" data-id="${esc(p.id)}" title="${t('Verkehrsmittel')}" ${dis}>${VEHICLES.map((v) => `<option value="${v.id}" ${(p.vehicle || 'car') === v.id ? 'selected' : ''}>${esc(t(v.label))}</option>`).join('')}</select> ${state}${unsafeNote(r)}</td>
      <td class="num">${cur ? `${fmtKm(cur.dist)}<br>${formatDuration(cur.time)}` : '–'}</td>
      <td class="num">${neu ? `${fmtKm(neu.dist)}<br>${formatDuration(neu.time)}` : '–'}</td>
      <td class="num">${delta} ${confidenceDot(actions.confidence('pair', p.id))}</td>
      <td class="pair-actions"><button type="button" class="icon-btn pair-set" data-id="${esc(p.id)}" title="${t('Start und Ziel auf der Karte setzen')}" ${dis}>◎</button><button type="button" class="icon-btn pair-swap" data-id="${esc(p.id)}" title="A ↔ B" ${dis || !p.from || !p.to ? 'disabled' : ''}>⇄</button><button type="button" class="icon-btn pair-del" data-id="${esc(p.id)}" title="${t('Löschen')}" ${dis}>✕</button></td>
    </tr>`;
  }).join('');
  const total = count ? `<tr class="total"><td colspan="4">${tn(count, 'Summe über {n} Paar', 'Summe über {n} Paare')} · Ø ${formatDuration(Math.abs(sumDelta / count))} ${t('je Fahrt')}</td><td class="num"><strong>${sumDelta > 0 ? '+' : sumDelta < 0 ? '−' : '±'}${formatDuration(Math.abs(sumDelta))}</strong></td><td></td></tr>` : '';
  return `
    <h4>${t('Weitere Routenpaare')}</h4>
    <p class="muted small">${t('Feste Verbindungen wie Schule, Bahnhof oder Nachbardorf: heute gegen neu{typ}, dazu die Summe der Zeitgewinne. Nummerierte Marker auf der Karte.', { typ: geometry ? t(' (typische Zeit)') : '' })}</p>
    ${pairs.length ? `<table class="route-table pairs"><thead><tr><th>#</th><th>${t('Name')}</th><th class="num">${t('Heute')}</th><th class="num">${t('Neu')}</th><th class="num">Δ</th><th></th></tr></thead><tbody>${rows}${total}</tbody></table>${confidenceBlock(actions.confidence('pairs'))}` : ''}
    <div class="btn-row"><button type="button" id="pair-add" class="btn small" ${dis}>${t('+ Paar hinzufügen')}</button>${capturing ? `<span class="muted small">${t('Start und Ziel auf der Karte anklicken (Esc bricht ab).')}</span>` : ''}</div>`;
}

/**
 * Fahrt-Animation: Start-Knopf, Modus (heute/neu/beide), Zeitraffer, Zeitleiste mit Fortschritt je Fahrzeug
 * und Rang bei Ankunft. compact: ohne Erklärtext (Präsentationsmodus).
 */
const RACE_MODE_LABELS = { both: 'Heute und neu', current: 'Nur heute', proposed: 'Nur neu' };
function raceBlock(race, actions, { compact = false, canStart = true } = {}) {
  const conf = actions.confidence('route');
  const dot = conf ? confidenceDot(conf) : '';
  const modeSelect = (current) => `<select class="race-mode" title="${t('Welche Netze fahren mit')}">${Object.entries(RACE_MODE_LABELS).map(([id, label]) => `<option value="${id}" ${current === id ? 'selected' : ''}>${t(label)}</option>`).join('')}</select>`;
  if (!race) {
    if (!canStart) return '';
    return `
      <div class="race idle">
        <div class="btn-row">
          <button type="button" class="btn small race-start" title="${t('Auto, Bus, Velo und Fussgänger fahren die Strecke im Zeitraffer ab')}">▶ ${t('Abfahren')}</button>
          ${modeSelect('both')}
          ${dot}
        </div>
        ${compact ? '' : `<p class="muted small">${t('Zeigt, wie die Strecke im Modell abgefahren wird – heute gegen neu, parallel je Verkehrsmittel. Kein realer Verkehr.')}</p>`}
      </div>`;
  }
  const scene = actions.raceScene();
  const runners = scene ? scene.runners : [];
  const variantLabel = { current: t('Heute'), proposed: t('Neu') };
  const variantColor = { current: '#1b6ac9', proposed: '#2a9d3f' };
  const rows = runners.map((r) => `
      <tr data-runner="${esc(r.id)}">
        <td><span class="race-glyph">${r.glyph}</span> ${esc(t(r.label))}</td>
        <td><span class="dot" style="background:${variantColor[r.variant]}"></span>${variantLabel[r.variant]}</td>
        <td class="race-bar-cell"><span class="race-bar"><i style="width:${Math.round(r.progress * 100)}%;background:${r.color}"></i></span></td>
        <td class="race-rank num">${r.finished ? `${r.rank}. · ${formatDuration(r.total)}` : formatDuration(r.total)}</td>
      </tr>`).join('');
  const toggleLabel = race.status === 'running' ? t('Pause') : race.status === 'done' ? t('Nochmals') : t('Weiter');
  return `
    <div class="race active" data-status="${esc(race.status)}">
      <div class="race-head">
        <strong>${t('Abfahren')}</strong>
        ${race.title ? `<span class="muted small">${esc(race.title)}</span>` : ''}
        ${dot}
        ${race.status === 'loading' ? `<span class="muted small">${t('Berechne…')}</span>` : ''}
      </div>
      <div class="btn-row">
        ${race.kind === 'route' ? modeSelect(race.mode) : ''}
        <span class="race-speeds">${RACE_SPEEDS.map((sp) => `<button type="button" class="btn small race-speed ${race.speed === sp ? 'active' : ''}" data-speed="${sp}" title="${t('Zeitraffer')}">${sp}×</button>`).join('')}</span>
      </div>
      ${runners.length ? `
      <div class="race-timeline">
        <input type="range" class="race-seek" min="0" max="${Math.ceil(race.duration)}" step="1" value="${Math.floor(race.t)}" aria-label="${t('Modellzeit')}">
        <span class="race-clock">${formatClock(race.t)} / ${formatClock(race.duration)}</span>
      </div>
      <table class="route-table race-table"><tbody>${rows}</tbody></table>` : race.status === 'empty' ? `<p class="muted small">${t('Keine fahrbare Strecke für die Animation (Strassennetz geladen?).')}</p>` : ''}
      <div class="btn-row">
        <button type="button" class="btn small primary race-toggle" ${runners.length ? '' : 'disabled'}>${toggleLabel}</button>
        <button type="button" class="btn small race-restart">${race.stale ? t('Neu berechnen') : t('Neu starten')}</button>
        <button type="button" class="btn small race-stop">${t('Schliessen')}</button>
      </div>
      ${race.stale ? `<p class="muted small">${t('Der Entwurf hat sich geändert – „Neu berechnen“ fährt die aktuelle Strecke.')}</p>` : ''}
      ${compact ? '' : `<p class="muted small">${t('Positionen folgen der Zeitachse des Routen-Rechners (Tempolimits, Wartezeiten, Haltezeiten) – kein realer Verkehr.')}</p>`}
    </div>`;
}

/** Buslinien: Haltestellen in Reihenfolge, Fahrzeit heute/neu über das Bus-Netz. */
function busSection(doc, actions, tools) {
  const lines = doc.busLines || [];
  const results = actions.busResults();
  const editable = actions.canEdit();
  const dis = editable ? '' : 'disabled';
  const capturing = tools.routeTarget && tools.routeTarget.busLine;
  const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
  const stopName = (id, i) => {
    const f = doc.features.find((x) => x.id === id);
    return f ? (f.name || `${t('Haltestelle')} ${i + 1}`) : `${t('Haltestelle')} ${i + 1}`;
  };
  const rows = lines.map((l) => {
    const r = results.find((x) => x.id === l.id);
    const cur = r && r.current && !r.current.error ? r.current : null;
    const neu = r && r.proposed && !r.proposed.error ? r.proposed : null;
    let delta = '–';
    if (cur && neu) {
      const d = neu.time - cur.time;
      delta = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${formatDuration(Math.abs(d))}`;
    }
    const err = r && ((r.current && r.current.error) || (r.proposed && r.proposed.error));
    const stops = l.stops.map((id, i) => `<span class="stop-chip"><button type="button" class="linkish stop-focus" data-stop="${esc(id)}">${i + 1}. ${esc(stopName(id, i))}</button>${editable ? `<button type="button" class="icon-btn stop-up" data-id="${esc(l.id)}" data-i="${i}" title="${t('Nach vorne')}" ${i === 0 ? 'disabled' : ''}>◀</button><button type="button" class="icon-btn stop-del" data-id="${esc(l.id)}" data-i="${i}" title="${t('Aus der Linie entfernen')}">✕</button>` : ''}</span>`).join('');
    return `
      <div class="bus-line ${capturing === l.id ? 'active' : ''}">
        <div class="bus-head">
          <input type="color" class="bus-color" data-id="${esc(l.id)}" value="${esc(l.color)}" title="${t('Linienfarbe')}" ${dis}>
          <input type="text" class="bus-name" data-id="${esc(l.id)}" value="${esc(l.name)}" placeholder="12" title="${t('Liniennummer')}" ${dis}>
          <label class="muted small">${t('Halt')} <input type="number" class="bus-dwell" data-id="${esc(l.id)}" min="0" max="300" step="5" value="${l.dwell}" ${dis}> s</label>
          <button type="button" class="btn small bus-capture ${capturing === l.id ? 'primary' : ''}" data-id="${esc(l.id)}" ${dis}>${t('Haltestellen setzen')}</button>
          <button type="button" class="icon-btn bus-del" data-id="${esc(l.id)}" title="${t('Linie löschen')}" ${dis}>✕</button>
        </div>
        <div class="bus-stops">${stops || `<span class="muted small">${t('Noch keine Haltestellen – „Haltestellen setzen“ und auf der Karte klicken.')}</span>`}</div>
        ${l.stops.length >= 2 ? `<table class="route-table"><thead><tr><th></th><th class="num">${t('Heute')}</th><th class="num">${t('Neu')}</th><th class="num">Δ</th></tr></thead><tbody>
          <tr><td>${t('Fahrzeit')} <span class="muted small">(${t('inkl. Halte')})</span></td><td class="num">${cur ? formatDuration(cur.time) : '–'}</td><td class="num">${neu ? formatDuration(neu.time) : '–'}</td><td class="num">${delta}</td></tr>
          <tr><td>${t('Distanz')}</td><td class="num">${cur ? fmtKm(cur.dist) : '–'}</td><td class="num">${neu ? fmtKm(neu.dist) : '–'}</td><td></td></tr>
        </tbody></table>${err ? `<p class="muted small">${esc(t(err))}</p>` : ''}${scheduleRow(l, cur, actions, editable)}${confidenceBlock(actions.confidence('bus', l.id))}` : ''}
      </div>`;
  }).join('');
  return `
    <h4>${t('Buslinien')}</h4>
    <p class="muted small">${t('Haltestellen in Reihenfolge; die Fahrzeit folgt dem Bus-Netz: Busschleusen (Zugang „Nur Bus“) und freigegebene Flächen sind für Busse offen, für Autos gesperrt. Je Zwischenhalt kommt die Haltezeit dazu.')} ${t('„Fahrplan abgleichen“ holt die Fahrzeit direkter Busfahrten zwischen erster und letzter Haltestelle aus dem offenen Fahrplan (transport.opendata.ch) und vergleicht sie mit dem Modell heute.')}</p>
    ${rows}
    <div class="btn-row"><button type="button" id="bus-add" class="btn small" ${dis}>${t('+ Buslinie')}</button>${capturing ? `<span class="muted small">${t('Haltestellen anklicken oder neue setzen (Esc beendet).')}</span>` : ''}</div>
    ${transitSection(doc, actions)}`;
}

const fmtMin = (sec) => (sec === null || sec === undefined ? '–' : formatDuration(sec));
const fmtDelta = (sec) => (sec === null || sec === undefined ? '–' : `${sec > 0 ? '+' : sec < 0 ? '−' : '±'}${formatDuration(Math.abs(sec))}`);

/** Variantenvergleich: jede Ebene allein; auf Knopfdruck, weil je Ebene geroutet wird. */
function variantsSection(doc, actions) {
  const v = actions.variants();
  const stale = v && (v.layers.length !== doc.layers.length || v.layers.some((r, i) => r.id !== doc.layers[i].id));
  const table = v ? `
      <table class="route-table variants">
        <thead><tr><th>${t('Ebene')}</th><th class="num">${t('Elemente')}</th><th class="num">${t('Neu (m)')}</th><th class="num">${t('Kosten')}</th><th class="num">${t('Route Δ')}</th><th class="num">${t('Paare Δ')}</th><th class="num">${t('Parzellen')}</th><th class="num">${t('Gebäude')}</th><th class="num">${t('Warn.')}</th></tr></thead>
        <tbody>${v.layers.map((r) => `<tr class="${r.visible ? '' : 'muted'}"><td>${esc(r.name)}${r.visible ? '' : ` (${t('ausgeblendet')})`}</td><td class="num">${r.features}</td><td class="num">${Math.round(r.lengthNew)}</td><td class="num">${formatChf(r.costs)}</td><td class="num">${fmtDelta(r.routeDelta)}</td><td class="num">${r.pairsCount ? fmtDelta(r.pairsDelta) : '–'}</td><td class="num">${r.parcels}</td><td class="num">${r.buildings === null ? '–' : r.buildings}</td><td class="num">${r.warnings}</td></tr>`).join('')}</tbody>
      </table>
      <p class="muted small">${t('Je Ebene allein sichtbar gerechnet: Kosten der Ebene, Fahrzeit-Differenz der Hauptroute und Summe der Paare gegenüber heute, Parzellen und Gebäude entlang neuer Strassen, Warnungen des Normen-Checks.')}${stale ? ` <strong>${t('Ebenen haben sich geändert – neu rechnen.')}</strong>` : ''}</p>` : `<p class="muted small">${t('Vergleicht die Ebenen als Varianten: jede allein sichtbar mit Kosten, Fahrzeiten, Parzellen, Gebäuden und Warnungen.')}</p>`;
  return `
      <h3>${t('Variantenvergleich')}</h3>
      ${table}
      <div class="btn-row"><button type="button" id="variants-run" class="btn small">${v ? t('Neu rechnen') : t('Varianten vergleichen')}</button></div>`;
}

/** Parkplatzbilanz: neu aus Parkstreifen und Parkflächen, entfallen aus OSM. */
function parkingSection(actions) {
  const b = actions.parkingBalance();
  const rows = b.items.map((it) => `<li><span class="badge ${it.kind === 'added' ? 'ok' : 'warn'}">${it.spaces > 0 ? '+' : ''}${it.spaces}</span> ${it.featureId ? `<button type="button" class="linkish parking-row" data-id="${esc(it.featureId)}">${esc(it.label)}</button>` : esc(it.label)}${it.note ? ` <span class="muted small">${esc(it.note)}</span>` : ''}</li>`).join('');
  return `
      <h3>${t('Parkplatzbilanz')}</h3>
      <p class="muted small">${t('Neu: Parkstreifen aus dem Querschnitt (6 m je Platz) und Parkflächen (25 m² je Platz inkl. Fahrgasse). Entfallen: OSM-Parkstreifen an übernommenen Strassen ohne Parkstreifen im Querschnitt oder bei Rückbau, OSM-Parkplätze, die neue Strassen oder Flächen berühren (capacity oder Fläche).')}</p>
      <table class="route-table"><tbody>
        <tr><td>${t('Neu')}</td><td class="num">+${b.added.lanes + b.added.zones}</td><td class="muted small">${t('{a} Parkstreifen, {b} Flächen', { a: b.added.lanes, b: b.added.zones })}</td></tr>
        <tr><td>${t('Entfallen')}</td><td class="num">−${b.removed.lanes + b.removed.areas}</td><td class="muted small">${t('{a} Parkstreifen, {b} OSM-Parkplätze', { a: b.removed.lanes, b: b.removed.areas })}</td></tr>
        <tr class="total"><td>${t('Bilanz')}</td><td class="num"><strong>${b.net > 0 ? '+' : ''}${b.net}</strong></td><td></td></tr>
      </tbody></table>
      ${rows ? `<ul class="parking-list">${rows}</ul>` : ''}
      <div class="btn-row"><button type="button" id="parking-load" class="btn small">${t('OSM-Parkplätze für die Ansicht laden')}</button></div>
      <p class="muted small" id="parking-status">${esc(actions.parkingStatus())}</p>`;
}

/** Etappierung: kumulierte Kennzahlen je Etappe. */
function phasesSection(doc, actions) {
  const rows = actions.phaseTable();
  if (!rows.length) return '';
  return `
      <h3>${t('Etappierung')}</h3>
      <table class="route-table">
        <thead><tr><th>${t('bis Etappe')}</th><th class="num">${t('Elemente')}</th><th class="num">${t('Kosten kumuliert')}</th><th class="num">${t('Fahrzeit neu')}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${actions.phaseView() === r.id ? 'active' : ''}"><td>${esc(r.label)}</td><td class="num">${r.features} <span class="muted small">(+${r.own})</span></td><td class="num">${formatChf(r.costs)}</td><td class="num">${fmtMin(r.routeTime)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="muted small">${t('Kumuliert bis zur jeweiligen Etappe (Elemente ohne Etappe zählen immer). Fahrzeit der Hauptroute im Netz dieses Zustands. Ansicht im Ebenen-Tab wählen.')}</p>`;
}

/** Bestehende Buslinien aus OSM (route=bus) mit ihrer Haltestellenfolge zum Übernehmen. */
function transitSection(doc, actions) {
  const routes = actions.transitRoutes();
  const editable = actions.canEdit();
  const dis = editable ? '' : 'disabled';
  const adopted = new Set((doc.busLines || []).map((l) => l.osmId).filter(Boolean));
  const shown = routes.slice(0, 60);
  const items = shown.map((r) => {
    const title = r.name || [r.from, r.to].filter(Boolean).join(' – ') || `#${r.id}`;
    const action = adopted.has(r.id)
      ? `<span class="muted small">${t('übernommen')}</span>`
      : `<button type="button" class="btn small transit-adopt" data-id="${r.id}" ${dis}>${t('Übernehmen')}</button>`;
    return `<li><span class="bus-badge" style="background:${esc(r.colour || '#3d5afe')}">${esc(r.ref || '–')}</span>${confidenceDot(transitRouteConfidence(r))}<span class="transit-name" title="${esc(r.operator || '')}">${esc(title)}</span><span class="muted small">${tn(r.stops.length, '{n} Haltestelle', '{n} Haltestellen')}</span>${action}</li>`;
  }).join('');
  const more = routes.length > shown.length ? `<p class="muted small">${t('… und {n} weitere Linien; Ansicht verkleinern.', { n: routes.length - shown.length })}</p>` : '';
  return `
    <div class="transit">
      <div class="transit-head"><strong>${t('Bestehende Linien aus OSM')}</strong><button type="button" id="transit-load" class="btn small">${t('Für Ansicht laden')}</button></div>
      <p class="muted small" id="transit-status">${esc(actions.transitStatus())}</p>
      ${items ? `<ul class="transit-list">${items}</ul>${more}` : ''}
    </div>`;
}

/** Erreichbarkeit ab einem Ursprung als Isochronen-Netz. */
function isochroneSection(doc, actions, tools) {
  const iso = doc.isochrone;
  const res = iso ? actions.isochrone() : null; // nach dem Löschen liegt bis zur Neuberechnung noch ein altes Ergebnis vor
  const editable = actions.canEdit();
  const dis = editable ? '' : 'disabled';
  const capturing = tools.routeTarget && tools.routeTarget.isochrone;
  const presetValue = iso ? iso.minutes.join(',') : '5,10,15';
  const presets = ISOCHRONE_PRESETS.map((p) => p.join(','));
  if (!presets.includes(presetValue)) presets.push(presetValue);
  let stats = '';
  if (res && res.error) stats = `<p class="muted small">${esc(t(res.error))}</p>`;
  else if (res && res.mode === 'diff') {
    stats = `<table class="route-table"><tbody>
      <tr><td><span class="dot" style="background:${ISO_DIFF_COLORS.gained}"></span>${t('Neu erreichbar (nur mit Entwurf)')}</td><td class="num">${res.stats.gainedKm} km</td></tr>
      <tr><td><span class="dot" style="background:${ISO_DIFF_COLORS.lost}"></span>${t('Nicht mehr erreichbar (nur heute)')}</td><td class="num">${res.stats.lostKm} km</td></tr>
      <tr><td><span class="dot" style="background:#777"></span>${t('In beiden Fällen')}</td><td class="num">${res.stats.bothKm} km</td></tr></tbody></table>
      <p class="muted small">${t('Strassennetz, das innerhalb von {min} Minuten ab dem Ursprung erreichbar ist.', { min: iso.minutes[iso.minutes.length - 1] })}</p>`;
  } else if (res) {
    stats = `<table class="route-table"><thead><tr><th>${t('bis')}</th><th class="num">${t('erreichbares Netz')}</th></tr></thead><tbody>
      ${res.minutes.map((m, i) => `<tr><td><span class="dot" style="background:${ISO_COLORS[Math.min(i, ISO_COLORS.length - 1)]}"></span>${m} min</td><td class="num">${res.stats.km[i]} km</td></tr>`).join('')}</tbody></table>`;
  }
  if (res && !res.error) stats += confidenceBlock(actions.confidence('isochrone'));
  return `
    <h4>${t('Erreichbarkeit (Isochronen)')}</h4>
    <p class="muted small">${t('Welches Strassennetz ist ab einem Punkt in 5, 10 oder 15 Minuten erreichbar – heute, mit dem Entwurf oder als Differenz (grün: nur neu, rot: nur heute).')}</p>
    <div class="btn-row">
      <button type="button" id="iso-set" class="btn small ${capturing ? 'primary' : ''}" ${dis}>${iso ? t('Ursprung verschieben') : t('Ursprung setzen')}</button>
      ${iso ? `
      <select id="iso-minutes" ${dis}>${presets.map((p) => `<option value="${p}" ${p === presetValue ? 'selected' : ''}>${p.split(',').join(' / ')} min</option>`).join('')}</select>
      <select id="iso-mode" ${dis}>${[['proposed', 'Neu (mit Entwurf)'], ['current', 'Heute'], ['diff', 'Differenz']].map(([v, l]) => `<option value="${v}" ${iso.mode === v ? 'selected' : ''}>${t(l)}</option>`).join('')}</select>
      <button type="button" id="iso-clear" class="btn small" ${dis}>${t('Löschen')}</button>` : ''}
    </div>
    ${capturing ? `<p class="muted small">${t('Ursprung auf der Karte anklicken (Esc bricht ab).')}</p>` : ''}
    ${stats}`;
}

/** Parzellen-Block der Strassen-Eigenschaften: Abfrage, Liste mit Länge je Parzelle, Hinweis bei veralteter Geometrie. */
function parcelsBlock(road, editable) {
  const dis = editable ? '' : 'disabled';
  const valid = validParcels(road);
  const stale = road.parcels && !valid;
  let body = '';
  if (valid) {
    const total = valid.items.reduce((s, it) => s + it.length, 0);
    body = valid.items.length
      ? `<ul class="parcel-list">${valid.items.map((it) => `<li><strong>${esc(parcelLabel(it))}</strong> <span class="muted small">${esc(it.egrid)}</span><span class="num">${it.length.toFixed(0)} m</span></li>`).join('')}</ul>
         <p class="muted small">${tn(valid.items.length, '{n} Parzelle', '{n} Parzellen')}, ${t('{m} m Strasse auf Privat- oder Gemeindeland (Liegenschaften der amtlichen Vermessung).', { m: total.toFixed(0) })}</p>`
      : `<p class="muted small">${t('Keine Parzellen berührt (oder ausserhalb der Schweiz).')}</p>`;
    if (valid.items.length) body += confidenceBlock(staticConfidence('parcels'));
  } else if (stale) {
    body = `<p class="muted small">${t('Die Strasse wurde seit der Abfrage verändert; die Parzellenliste ist veraltet.')}</p>`;
  } else {
    body = `<p class="muted small">${t('Ermittelt über die amtliche Vermessung (geo.admin), welche Liegenschaften die Strasse berührt und wie viele Meter darauf liegen. Nur Schweiz.')}</p>`;
  }
  return `
    <details class="box" ${valid ? 'open' : ''}>
      <summary>${t('Betroffene Parzellen')}${valid ? ` <span class="muted">(${valid.items.length})</span>` : stale ? ` <span class="muted">(${t('veraltet')})</span>` : ''}</summary>
      ${body}
      <div class="btn-row">
        <button type="button" id="parcels-load" class="btn small" ${dis}>${valid || stale ? t('Neu ermitteln') : t('Betroffene Parzellen ermitteln')}</button>
        ${road.parcels ? `<button type="button" id="parcels-clear" class="btn small" ${dis}>${t('Entfernen')}</button>` : ''}
      </div>
    </details>`;
}

/** Querschnitt-Block der Strassen-Eigenschaften: Standard-Hinweis oder Editor. */
function sectionBlock(road, editable) {
  const dis = editable ? '' : 'disabled';
  const s = road.section;
  if (!s) {
    return `
      <details class="box">
        <summary>${t('Querschnitt')} <span class="muted">(${t('Standard')})</span></summary>
        <p class="muted small">${t('Standard für {kind}: {summary}. Ein eigener Querschnitt legt Fahrstreifen, Velostreifen, Trottoirs und Parkstreifen mit Breiten fest; ab Zoom 17 werden sie als Bänder gezeichnet.', { kind: esc(t(roadKind(road).label)), summary: esc(sectionSummary(defaultSection(road.kind))) })}</p>
        <button type="button" id="sec-create" class="btn small" ${dis}>${t('Querschnitt festlegen')}</button>
      </details>`;
  }
  const num = (key, label, step = 0.25) => `<label class="field">${label}<input type="number" class="sec-num" data-key="${key}" min="${SECTION_LIMITS[key][0]}" max="${SECTION_LIMITS[key][1]}" step="${step}" value="${s[key]}" ${dis}></label>`;
  const side = (name, label) => `
    <div class="sec-row">
      <span>${label}</span>
      <label class="check"><input type="checkbox" class="sec-flag" data-key="${name}Left" ${s[`${name}Left`] ? 'checked' : ''} ${dis}> ${t('links')}</label>
      <label class="check"><input type="checkbox" class="sec-flag" data-key="${name}Right" ${s[`${name}Right`] ? 'checked' : ''} ${dis}> ${t('rechts')}</label>
      <input type="number" class="sec-num" data-key="${name}Width" min="${SECTION_LIMITS[`${name}Width`][0]}" max="${SECTION_LIMITS[`${name}Width`][1]}" step="0.25" value="${s[`${name}Width`]}" title="${t('Breite in m')}" ${dis}> m
    </div>`;
  return `
    <details class="box" open>
      <summary>${t('Querschnitt')} <span class="muted">(${t('{w} m gesamt', { w: sectionWidth(s) })})</span></summary>
      <div class="sec-grid">
        ${num('lanes', t('Fahrstreifen'), 1)}
        ${num('laneWidth', t('Breite je Streifen (m)'))}
        ${num('median', t('Mittelstreifen (m)'))}
        ${num('shoulder', t('Pannenstreifen (m)'))}
      </div>
      ${side('bike', t('Velostreifen'))}
      ${side('walk', t('Trottoir'))}
      ${side('park', t('Parkstreifen'))}
      <p class="muted small">${esc(sectionSummary(s))}. ${t('Links/rechts in Zeichenrichtung; ein Mittelstreifen teilt die Fahrstreifen in zwei Fahrbahnen.')}</p>
      <button type="button" id="sec-remove" class="btn small" ${dis}>${t('Querschnitt entfernen')}</button>
    </details>`;
}

function nodeDistances(nodes) {
  const d = [0];
  for (let i = 1; i < nodes.length; i++) d.push(d[i - 1] + haversine(nodes[i - 1], nodes[i]));
  return d;
}

function profileBlock(road) {
  const profile = validProfile(road);
  const stale = road.profile && !profile;
  if (!profile) {
    return `<div class="profile-box">
      <div class="btn-row"><button type="button" id="prop-profile-load" class="btn small">${t('Höhenprofil laden')}</button>
      <span class="muted small">${stale ? t('Profil veraltet (Geometrie geändert).') : t('swisstopo-Höhenmodell, nur Schweiz.')}</span></div>
    </div>`;
  }
  const dists = nodeDistances(road.nodes);
  const grades = segmentGrades(dists, profile.points);
  let up = 0;
  let down = 0;
  for (let i = 1; i < profile.points.length; i++) {
    const dh = profile.points[i][1] - profile.points[i - 1][1];
    if (dh > 0) up += dh;
    else down -= dh;
  }
  const maxGrade = grades.reduce((m, g) => Math.max(m, Math.abs(g)), 0);
  return `<div class="profile-box">
    <canvas id="prop-profile-chart" class="profile-chart" width="320" height="140"></canvas>
    <div class="muted small">↑ ${Math.round(up)} m · ↓ ${Math.round(down)} m · ${t('max. Steigung')} ${maxGrade.toFixed(1)} %</div>
    <div class="btn-row"><button type="button" id="prop-profile-load" class="btn small">${t('Neu laden')}</button><button type="button" id="prop-profile-clear" class="btn small">${t('Profil entfernen')}</button></div>
  </div>`;
}

/** Zeichnet Gelände und Strassenführung (Brücke über, Tunnel unter dem Gelände). */
function drawProfileChart(canvas, road) {
  const profile = validProfile(road);
  if (!profile) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 320;
  const H = 140;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = profile.points;
  const maxD = Math.max(pts[pts.length - 1][0], 1);
  let minH = Infinity;
  let maxH = -Infinity;
  for (const [, h] of pts) {
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
  }
  const span = Math.max(maxH - minH, 10);
  minH -= span * 0.15;
  maxH += span * 0.15;
  const pad = { l: 36, r: 8, t: 8, b: 18 };
  const X = (d) => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const Y = (h) => H - pad.b - ((h - minH) / (maxH - minH)) * (H - pad.t - pad.b);
  const heightAt = (d) => {
    if (d <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (d <= pts[i][0]) {
        const [d0, h0] = pts[i - 1];
        const [d1, h1] = pts[i];
        return d1 === d0 ? h1 : h0 + ((d - d0) / (d1 - d0)) * (h1 - h0);
      }
    }
    return pts[pts.length - 1][1];
  };
  // Gelände
  ctx.beginPath();
  ctx.moveTo(X(pts[0][0]), H - pad.b);
  for (const [d, h] of pts) ctx.lineTo(X(d), Y(h));
  ctx.lineTo(X(pts[pts.length - 1][0]), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = '#e8ecf0';
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [d, h] = pts[i];
    if (i === 0) ctx.moveTo(X(d), Y(h));
    else ctx.lineTo(X(d), Y(h));
  }
  ctx.strokeStyle = '#6b7480';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Strassenführung je Abschnitt
  const dists = nodeDistances(road.nodes);
  for (let i = 0; i < road.segments.length; i++) {
    const seg = road.segments[i];
    const d0 = dists[i];
    const d1 = dists[i + 1];
    ctx.beginPath();
    if (seg.level === 'ground') {
      const steps = Math.max(2, Math.round((d1 - d0) / 5));
      for (let k = 0; k <= steps; k++) {
        const d = d0 + ((d1 - d0) * k) / steps;
        if (k === 0) ctx.moveTo(X(d), Y(heightAt(d)));
        else ctx.lineTo(X(d), Y(heightAt(d)));
      }
      ctx.strokeStyle = '#d7263d';
      ctx.setLineDash([]);
    } else {
      ctx.moveTo(X(d0), Y(heightAt(d0)));
      ctx.lineTo(X(d1), Y(heightAt(d1)));
      ctx.strokeStyle = seg.level === 'bridge' ? '#1a1a1a' : '#7b3fbf';
      ctx.setLineDash(seg.level === 'tunnel' ? [5, 4] : []);
    }
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Achsen
  ctx.fillStyle = '#6b7480';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxH - span * 0.15)} m`, pad.l - 4, pad.t + 8);
  ctx.fillText(`${Math.round(minH + span * 0.15)} m`, pad.l - 4, H - pad.b);
  ctx.textAlign = 'left';
  ctx.fillText('0 m', pad.l, H - 5);
  ctx.textAlign = 'right';
  ctx.fillText(maxD >= 1000 ? `${(maxD / 1000).toFixed(2)} km` : `${Math.round(maxD)} m`, W - pad.r, H - 5);
}

export class UI {
  constructor(ctx) {
    this.ctx = ctx; // { store, local, settings, tools, actions, map }
    this.$ = (id) => document.getElementById(id);
    mountIcons();
    this.wireStatic();
  }

  wireStatic() {
    const { actions } = this.ctx;
    document.querySelectorAll('.tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.showTab(btn.dataset.tab, { reveal: true }));
    });
    this.$('sidebar-toggle').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-hidden');
      setTimeout(() => this.ctx.map.invalidateSize(), 250);
    });
    // Aktionsleiste über der Karte während des Zeichnens (v. a. für Touch ohne Enter/Esc/Backspace)
    this.$('da-finish').addEventListener('click', () => this.ctx.tools.finish());
    this.$('da-undo-point').addEventListener('click', () => this.ctx.tools.popVertex());
    this.$('da-cancel').addEventListener('click', () => this.ctx.tools.cancel());
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

  showTab(name, { reveal = false } = {}) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
    if (reveal && document.body.classList.contains('sidebar-hidden')) {
      // Auf schmalen Bildschirmen ist die Leiste ein Bottom-Sheet: Tipp auf einen Tab klappt sie auf.
      document.body.classList.remove('sidebar-hidden');
      setTimeout(() => this.ctx.map.invalidateSize(), 250);
    }
    if (name === 'history') this.refreshHistory();
    if (name === 'route') {
      this.refreshRoute();
      if (this.ctx.tools.tool !== 'route') this.ctx.tools.setTool('route');
    }
    if (name === 'comments') this.refreshComments();
    if (name === 'analysis') this.refreshAnalysis();
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
          this.renderSearchResults([{ label: `${t('Koordinate')} ${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, bbox: null }]);
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
      list.innerHTML = `<li class="muted">${t('Nichts gefunden.')}</li>`;
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
    this.refreshComments();
    this.refreshDrawActions();
    this.refreshElements();
    this.refreshPresent();
    if (this.$('tab-analysis') && this.$('tab-analysis').classList.contains('active')) this.refreshAnalysis();
  }

  // --- Analyse: Kosten und Normen-Check ---------------------------------------------------

  refreshAnalysis() {
    const { store, actions, tools, map, settings } = this.ctx;
    const el = this.$('analysis-panel');
    if (!el) return;
    const doc = store.doc;
    const editable = actions.canEdit();
    const dis = editable ? '' : 'disabled';
    const est = actions.costEstimate();
    const checks = actions.runChecks();
    const exp = actions.exposure();
    const warns = checks.filter((c) => c.severity === 'warn').length;
    const groups = [];
    for (const item of COST_ITEMS) {
      let g = groups.find((x) => x.name === item.group);
      if (!g) {
        g = { name: item.group, items: [] };
        groups.push(g);
      }
      g.items.push(item);
    }
    const overridden = Object.keys(doc.costs || {}).length;
    const openState = Array.from(el.querySelectorAll('details')).map((d) => d.open); // bleibt über das Neuzeichnen erhalten
    el.innerHTML = `
      <h3>${t('Kostenschätzung')}</h3>
      <p class="muted small">${t('Grobe Richtwerte für Schweizer Verhältnisse: Strassen pro Kilometer (mit der Breite skaliert), Brücken und Tunnel als Zuschlag pro Meter, Knoten und Flächen pauschal. Bestehende Strassen werden nicht gerechnet; ein Umbau wird als „Neu“ markiert. Die Summe zählt nur sichtbare Ebenen, Varianten also per Ein-/Ausblenden.')}</p>
      ${confidenceBlock(actions.confidence('costs'))}
      <table class="route-table">
        <thead><tr><th>${t('Ebene')}</th><th class="num">${t('Kosten')}</th></tr></thead>
        <tbody>
          ${est.layers.map((l) => `<tr class="${l.visible ? '' : 'muted'}"><td>${esc(l.name)}${l.visible ? '' : ` (${t('ausgeblendet')})`}</td><td class="num">${formatChf(l.amount)}</td></tr>`).join('')}
          <tr class="total"><td>${t('Total (sichtbare Ebenen)')}</td><td class="num"><strong>${formatChf(est.total)}</strong></td></tr>
        </tbody>
      </table>
      <details class="box">
        <summary>${t('Positionen')} (${est.rows.length})</summary>
        ${est.rows.length ? `<ul class="cost-list">${est.rows.map((r) => `<li><button type="button" class="linkish cost-row" data-id="${esc(r.featureId)}">${esc(t(r.label))}</button> <span class="muted small">${esc(r.detail)}</span><span class="num">${formatChf(r.amount)}</span></li>`).join('')}</ul>` : `<p class="muted small">${t('Keine Elemente.')}</p>`}
      </details>
      <details class="box">
        <summary>${t('Einheitskosten anpassen')}${overridden ? ` <span class="muted">(${t('{n} geändert', { n: overridden })})</span>` : ''}</summary>
        ${groups.map((g) => `<div class="cost-group"><div class="muted small">${esc(t(g.name))}</div>${g.items.map((it) => `
          <label class="cost-item"><span>${esc(t(it.label))}</span><input type="number" class="cost-input" data-key="${it.key}" min="0" step="${it.value >= 1e6 ? 100000 : it.value >= 10000 ? 10000 : 10}" value="${costValue(doc, it.key)}" ${dis}><span class="muted small">${esc(it.unit)}</span></label>`).join('')}</div>`).join('')}
        <button type="button" id="cost-reset" class="btn small" ${dis || !overridden ? 'disabled' : ''}>${t('Alle auf Standard')}</button>
      </details>
      <h3>${t('Normen-Check')}</h3>
      <p class="muted small">${t('Richtwerte nach VSS: Kurvenradius zum Tempo, Steigung aus dem Höhenprofil, Kreiselgrösse, Fahrstreifenbreite, Tempo in Zonen, nicht angeschlossene Enden.')} ${checks.length ? `${tn(warns, '{n} Warnung', '{n} Warnungen')}, ${tn(checks.length - warns, '{n} Hinweis', '{n} Hinweise')}.` : t('Keine Auffälligkeiten.')}</p>
      ${checks.length ? `<ul class="check-list">${checks.map((c) => `<li class="${c.severity}"><button type="button" class="linkish check-row" data-id="${esc(c.id)}">${esc(c.text)}</button></li>`).join('')}</ul>` : ''}
      ${confidenceBlock(staticConfidence('checks'))}
      ${variantsSection(doc, actions)}
      ${parkingSection(actions)}
      ${phasesSection(doc, actions)}
      <h3>${t('Betroffene Gebäude')}</h3>
      <p class="muted small">${t('Gebäude aus OpenStreetMap im Umkreis der heutigen Route, der neuen Route und aller neuen Strassen (sichtbare Ebenen). Lärm- und Sicherheitsargument in einer Zahl.')}</p>
      <div class="btn-row">
        <label class="field inline">${t('Umkreis')}<select id="exp-radius">${[25, 50, 100].map((r) => `<option value="${r}" ${settings.exposureRadius === r ? 'selected' : ''}>${r} m</option>`).join('')}</select></label>
        <button type="button" id="exp-load" class="btn small">${t('Gebäude für die Ansicht laden')}</button>
      </div>
      <p class="muted small" id="exp-status">${esc(actions.buildingsStatus())}</p>
      ${exp ? `
      <table class="route-table">
        <thead><tr><th></th><th class="num">${t('Gebäude ≤ {r} m', { r: exp.radius })}</th></tr></thead>
        <tbody>
          ${exp.hasRoutes ? `
          <tr><td><span class="dot" style="background:#1b6ac9"></span>${t('Route heute')}</td><td class="num">${exp.current.count}</td></tr>
          <tr><td><span class="dot" style="background:#2a9d3f"></span>${t('Route neu')}</td><td class="num">${exp.proposed.count}</td></tr>
          <tr class="total"><td>${t('Differenz')}</td><td class="num"><strong>${exp.delta > 0 ? '+' : ''}${exp.delta}</strong></td></tr>` : `<tr><td colspan="2" class="muted">${t('Für heute/neu Start und Ziel im Routen-Tab setzen.')}</td></tr>`}
          <tr><td>${t('Entlang neuer Strassen')}</td><td class="num">${exp.roads.count}</td></tr>
        </tbody>
      </table>
      <label class="check"><input type="checkbox" id="exp-show" ${actions.showExposure() ? 'checked' : ''}> ${t('Auf der Karte hervorheben')} <span class="muted small">${t('(rot: neu betroffen, grün: entlastet, orange: beides)')}</span></label>
      ${confidenceBlock(staticConfidence('buildings'))}` : ''}`;
    el.querySelectorAll('details').forEach((d, i) => { if (openState[i]) d.open = true; });
    const vrun = this.$('variants-run');
    if (vrun) vrun.onclick = () => actions.compareVariants();
    const pload = this.$('parking-load');
    if (pload) pload.onclick = () => actions.loadParking();
    el.querySelectorAll('.parking-row').forEach((b) => {
      b.onclick = () => {
        tools.setSelection({ featureId: b.dataset.id });
        actions.zoomToFeature(b.dataset.id);
      };
    });
    el.querySelectorAll('.cost-row').forEach((b) => {
      b.onclick = () => {
        tools.setSelection({ featureId: b.dataset.id });
        actions.zoomToFeature(b.dataset.id);
      };
    });
    el.querySelectorAll('.cost-input').forEach((inp) => {
      inp.onchange = () => actions.setCost(inp.dataset.key, inp.value === '' ? null : Number(inp.value));
    });
    const reset = this.$('cost-reset');
    if (reset) reset.onclick = () => actions.resetCosts();
    this.$('exp-radius').onchange = (e) => actions.updateSettings({ exposureRadius: Number(e.target.value) });
    this.$('exp-load').onclick = () => actions.loadBuildings();
    const expShow = this.$('exp-show');
    if (expShow) expShow.onchange = (e) => actions.setShowExposure(e.target.checked);
    el.querySelectorAll('.check-row').forEach((b) => {
      b.onclick = () => {
        const c = checks.find((x) => x.id === b.dataset.id);
        if (!c) return;
        tools.setSelection({ featureId: c.featureId });
        if (c.at) map.flyTo(c.at, Math.max(map.getZoom(), 17));
        else actions.zoomToFeature(c.featureId);
      };
    });
  }

  /** Aktionsleiste „Fertig / Letzter Punkt / Abbrechen“ während einer laufenden Zeichnung. */
  refreshDrawActions() {
    const { tools } = this.ctx;
    const bar = this.$('draw-actions');
    if (!bar) return;
    const draft = tools.draft;
    bar.hidden = !draft && !tools.routeDraft && !tools.commentDraft;
    if (bar.hidden) return;
    const polyline = draft && (tools.tool === 'road' || tools.tool === 'zone');
    const n = polyline ? draft.vertices.length : 0;
    const min = tools.tool === 'zone' ? 3 : (draft && draft.extend ? 1 : 2);
    this.$('da-finish').hidden = !polyline;
    this.$('da-finish').disabled = n < min;
    this.$('da-finish').textContent = tools.tool === 'zone' ? t('Fläche schliessen') : t('Strasse fertig');
    this.$('da-undo-point').hidden = !polyline;
    this.$('da-undo-point').disabled = n === 0;
  }

  // --- Präsentationsmodus ------------------------------------------------------------

  refreshPresent() {
    const { store, actions, settings } = this.ctx;
    const panel = this.$('present-panel');
    if (!panel) return;
    if (!actions.isPresent()) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const doc = store.doc;
    const visible = doc.features.filter((f) => {
      const l = doc.layers.find((x) => x.id === f.layerId);
      return !l || l.visible !== false;
    });
    const roadKinds = new Set(visible.filter((f) => f.type === 'road').map((f) => f.kind));
    const zoneKinds = new Set(visible.filter((f) => f.type === 'zone').map((f) => f.kind));
    const counts = { road: 0, junction: 0, roundabout: 0, zone: 0 };
    visible.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
    const legend = [];
    ROAD_KINDS.filter((k) => roadKinds.has(k.id)).forEach((k) => legend.push(`<li><span class="swatch ground"></span> ${esc(t(k.label))}${k.speed ? ` · ${k.speed} km/h` : ''}</li>`));
    if (visible.some((f) => f.type === 'road' && f.segments.some((sg) => sg.level === 'bridge'))) legend.push(`<li><span class="swatch bridge"></span> ${t('Brücke')}</li>`);
    if (visible.some((f) => f.type === 'road' && f.segments.some((sg) => sg.level === 'tunnel'))) legend.push(`<li><span class="swatch tunnel"></span> ${t('Tunnel')}</li>`);
    if (visible.some((f) => f.status === 'remove')) legend.push(`<li><span class="swatch remove"></span> ${t('Rückbau')}</li>`);
    ZONE_KINDS.filter((k) => zoneKinds.has(k.id)).forEach((k) => legend.push(`<li><span class="swatch zone" style="${k.color ? `background:${k.color}33;border-color:${k.color}` : ''}"></span> ${esc(t(k.label))}</li>`));
    const layers = doc.layers.map((l) => `<li><span class="dot" style="background:${esc(l.color)}"></span>${esc(l.name)}${l.visible === false ? ` <span class="muted">(${t('ausgeblendet')})</span>` : ''}</li>`).join('');
    const routes = actions.routes();
    let route = '';
    if (doc.route && routes) {
      const cur = routes.current && !routes.current.error ? routes.current : null;
      const neu = routes.proposed && !routes.proposed.error ? routes.proposed : null;
      const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
      const geometry = settings.speedModel === 'geometry';
      const band = (r) => (geometry && r && r.sd > 0 ? `<div class="muted small">${formatDuration(r.p15)} – ${formatDuration(r.p85)}</div>` : '');
      route = `
        <h3>${t('Route: heute vs. neu')}</h3>
        <table class="route-table">
          <thead><tr><th></th><th><span class="dot" style="background:#1b6ac9"></span>${t('Heute')}</th><th><span class="dot" style="background:#2a9d3f"></span>${t('Neu')}</th></tr></thead>
          <tbody>
            <tr><td>${t('Distanz')}</td><td>${cur ? fmtKm(cur.dist) : '–'}</td><td>${neu ? fmtKm(neu.dist) : '–'}</td></tr>
            <tr><td>${t('Fahrzeit')}</td><td>${cur ? formatDuration(cur.time) + band(cur) : '–'}</td><td>${neu ? formatDuration(neu.time) + band(neu) : '–'}</td></tr>
          </tbody>
        </table>`;
    }
    const busDefs = doc.busLines || [];
    const busRes = actions.busResults();
    if (busDefs.length && busRes.length) {
      const rows = busDefs.map((l) => {
        const r = busRes.find((x) => x.id === l.id);
        const cur = r && r.current && !r.current.error ? r.current : null;
        const neu = r && r.proposed && !r.proposed.error ? r.proposed : null;
        if (!cur && !neu) return '';
        return `<tr><td><span class="dot" style="background:${esc(l.color)}"></span>${t('Linie')} ${esc(l.name)}</td><td>${cur ? formatDuration(cur.time) : '–'}</td><td>${neu ? formatDuration(neu.time) : '–'}</td></tr>`;
      }).join('');
      if (rows) route += `<h3>${t('Buslinien')}</h3><table class="route-table"><thead><tr><th></th><th>${t('Heute')}</th><th>${t('Neu')}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const pairDefs = doc.routePairs || [];
    const pairRes = actions.pairResults();
    if (pairDefs.length && pairRes.length) {
      const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
      const rows = pairDefs.map((p) => {
        const r = pairRes.find((x) => x.id === p.id);
        const cur = r && r.current && !r.current.error ? r.current : null;
        const neu = r && r.proposed && !r.proposed.error ? r.proposed : null;
        if (!cur && !neu) return '';
        return `<tr><td>${esc(p.name)}</td><td>${cur ? `${fmtKm(cur.dist)}, ${formatDuration(cur.time)}` : '–'}</td><td>${neu ? `${fmtKm(neu.dist)}, ${formatDuration(neu.time)}` : '–'}</td></tr>`;
      }).join('');
      if (rows) route += `<h3>${t('Weitere Verbindungen')}</h3><table class="route-table"><thead><tr><th></th><th>${t('Heute')}</th><th>${t('Neu')}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const stats = [counts.road && tn(counts.road, '{n} Strasse', '{n} Strassen'), counts.junction && tn(counts.junction, '{n} Punkt', '{n} Punkte'), counts.roundabout && tn(counts.roundabout, '{n} Kreisel', '{n} Kreisel'), counts.zone && tn(counts.zone, '{n} Fläche', '{n} Flächen')].filter(Boolean).join(' · ');
    panel.innerHTML = `
      <h2>${esc(doc.name)}</h2>
      <p class="muted small">${esc(stats || t('Noch keine Elemente'))}</p>
      ${legend.length ? `<ul class="legend">${legend.join('')}</ul>` : ''}
      ${doc.layers.length > 1 ? `<details><summary>${t('Ebenen')} (${doc.layers.length})</summary><ul class="legend">${layers}</ul></details>` : ''}
      ${route}
      <div id="present-race" class="race-box">${raceBlock(actions.race(), actions, { compact: true, canStart: !!(doc.route && routes) })}</div>
      <div class="btn-row">
        <button type="button" id="present-edit" class="btn small">${t('Zum Editor')}</button>
        <button type="button" id="present-export" class="btn small">PNG / PDF</button>
      </div>`;
    this.$('present-edit').onclick = () => actions.exitPresent();
    this.$('present-export').onclick = () => this.openExport();
    this.wireRace(this.$('present-race'));
  }

  // --- Fahrt-Animation ----------------------------------------------------------------

  /** Zeichnet die Rennen-Blöcke neu (Routen-Tab und Präsentation), ohne die ganzen Panels zu bauen. */
  refreshRace() {
    const { actions, store } = this.ctx;
    const race = actions.race();
    const routes = actions.routes();
    const box = this.$('race-box');
    if (box) {
      box.innerHTML = raceBlock(race, actions, { canStart: !!(store.doc.route && routes) });
      this.wireRace(box);
    }
    const pbox = this.$('present-race');
    if (pbox && actions.isPresent()) {
      pbox.innerHTML = raceBlock(race, actions, { compact: true, canStart: !!(store.doc.route && routes) });
      this.wireRace(pbox);
    }
  }

  wireRace(box) {
    if (!box) return;
    const { actions } = this.ctx;
    const start = box.querySelector('.race-start');
    if (start) start.onclick = () => actions.startRace({ kind: 'route', mode: box.querySelector('.race-mode') ? box.querySelector('.race-mode').value : null });
    const mode = box.querySelector('.race-mode');
    if (mode) mode.onchange = () => { if (actions.race()) actions.raceSetMode(mode.value); };
    box.querySelectorAll('.race-speed').forEach((b) => { b.onclick = () => actions.raceSetSpeed(Number(b.dataset.speed)); });
    const toggle = box.querySelector('.race-toggle');
    if (toggle) toggle.onclick = () => actions.raceToggle();
    const restart = box.querySelector('.race-restart');
    if (restart) restart.onclick = () => actions.raceRestart();
    const stop = box.querySelector('.race-stop');
    if (stop) stop.onclick = () => actions.stopRace();
    const seek = box.querySelector('.race-seek');
    if (seek) seek.oninput = () => actions.raceSeek(Number(seek.value));
  }

  /** Uhr und Balken je Bild nachführen (ohne das Markup neu zu bauen). */
  updateRaceClock() {
    const { actions } = this.ctx;
    const race = actions.race();
    const scene = race ? actions.raceScene() : null;
    if (!scene) return;
    document.querySelectorAll('.race.active').forEach((box) => {
      const clock = box.querySelector('.race-clock');
      if (clock) clock.textContent = `${formatClock(race.t)} / ${formatClock(race.duration)}`;
      const seek = box.querySelector('.race-seek');
      if (seek && document.activeElement !== seek) seek.value = String(Math.floor(race.t));
      for (const r of scene.runners) {
        const row = box.querySelector(`tr[data-runner="${r.id}"]`);
        if (!row) continue;
        const bar = row.querySelector('.race-bar i');
        if (bar) bar.style.width = `${Math.round(r.progress * 100)}%`;
        const rank = row.querySelector('.race-rank');
        if (rank) rank.textContent = r.finished ? `${r.rank}. · ${formatDuration(r.total)}` : formatDuration(r.total);
      }
    });
  }

  /** Speicherkonflikt: jemand anderes hat inzwischen gespeichert. Liefert 'overwrite' | 'reload' | 'cancel'. */
  openConflict({ updatedAt, versionCount }) {
    return new Promise((resolve) => {
      this.openModal(`
        <h2>${t('Entwurf wurde inzwischen geändert')}</h2>
        <p>${t('Jemand anderes hat diesen Entwurf {when}gespeichert{version}. Welche Fassung soll gelten?', { when: updatedAt ? t('am {date} ', { date: esc(fmtDate(updatedAt)) }) : '', version: versionCount ? ` (${t('Version')} ${versionCount})` : '' })}</p>
        <div class="btn-row">
          <button type="button" id="conflict-overwrite" class="btn primary">${t('Meine Fassung speichern')}</button>
          <button type="button" id="conflict-reload" class="btn">${t('Serverstand übernehmen')}</button>
          <button type="button" id="conflict-cancel" class="btn" data-close>${t('Abbrechen')}</button>
        </div>
        <p class="muted small">${t('„Meine Fassung speichern“ überschreibt die fremde Änderung; sie bleibt im Verlauf als eigene Version erhalten. „Serverstand übernehmen“ ersetzt deine Fassung, die du mit Rückgängig zurückholen kannst.')}</p>`);
      let done = false;
      const finish = (choice) => {
        if (done) return;
        done = true;
        this.closeModal();
        resolve(choice);
      };
      this.$('conflict-overwrite').onclick = () => finish('overwrite');
      this.$('conflict-reload').onclick = () => finish('reload');
      this.$('conflict-cancel').onclick = () => finish('cancel');
      this.$('modal').addEventListener('click', (e) => {
        if (e.target === this.$('modal')) finish('cancel');
      }, { once: true });
    });
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
    this.$('btn-save').textContent = actions.canEdit() ? t('Speichern') : t('Eigene Kopie');
    document.title = `${store.doc.name} – Stadtplaner`;
  }

  /** Eigenschaften bei Mehrfachauswahl: Zusammenfassung und gemeinsame Aktionen. */
  refreshMultiProperties(box) {
    const { store, tools, actions } = this.ctx;
    const ids = tools.selectedIds();
    const feats = ids.map((id) => getFeature(store.doc, id)).filter(Boolean);
    const editable = actions.canEdit();
    const dis = editable ? '' : 'disabled';
    const counts = {};
    for (const f of feats) counts[f.type] = (counts[f.type] || 0) + 1;
    const typeLabel = { road: ['{n} Strasse', '{n} Strassen'], junction: ['{n} Punkt', '{n} Punkte'], roundabout: ['{n} Kreisel', '{n} Kreisel'], zone: ['{n} Fläche', '{n} Flächen'] };
    const summary = Object.entries(counts).map(([k, n]) => tn(n, typeLabel[k][0], typeLabel[k][1])).join(', ');
    const layerIds = new Set(feats.map((f) => f.layerId));
    const roads = feats.filter((f) => f.type === 'road');
    const statuses = new Set(roads.map((f) => f.status));
    const groups = new Set(feats.map((f) => f.group).filter(Boolean));
    const merge = mergeKind(store.doc, ids);
    const grouped = groups.size > 0;
    const sameGroup = groups.size === 1 && feats.every((f) => f.group);
    box.innerHTML = `
      <h3>${t('Eigenschaften')} <span class="muted">(${tn(feats.length, '{n} Element', '{n} Elemente')})</span></h3>
      <p class="muted small">${esc(summary)}. ${t('Ziehen auf einem ausgewählten Element verschiebt alle; Shift+Klick ergänzt oder entfernt; Entf löscht.')}</p>
      <label class="field">${t('Ebene')}<select id="multi-layer" ${dis}><option value="">${layerIds.size > 1 ? t('(verschieden)') : ''}</option>${store.doc.layers.map((l) => `<option value="${l.id}" ${layerIds.size === 1 && layerIds.has(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      ${(store.doc.phases || []).length ? `<label class="field">${t('Etappe')}<select id="multi-phase" ${dis}><option value="">${new Set(feats.map((f) => f.phase || '')).size > 1 ? t('(verschieden)') : t('Alle Etappen')}</option>${store.doc.phases.map((ph, i) => `<option value="${esc(ph.id)}" ${feats.every((f) => f.phase === ph.id) ? 'selected' : ''}>${esc(phaseLabel(ph, i))}</option>`).join('')}</select></label>` : ''}
      ${roads.length ? `<label class="field">${t('Status')} (${tn(roads.length, '{n} Strasse', '{n} Strassen')})<select id="multi-status" ${dis}><option value="">${statuses.size > 1 ? t('(verschieden)') : ''}</option>${STATUSES.map((st) => `<option value="${st.id}" ${statuses.size === 1 && statuses.has(st.id) ? 'selected' : ''}>${esc(t(st.label))}</option>`).join('')}</select></label>` : ''}
      <div class="btn-row">
        <button type="button" id="multi-group" class="btn small" ${dis || sameGroup ? 'disabled' : ''} title="${t('Gruppierte Elemente werden immer zusammen ausgewählt, verschoben und gelöscht')}">⧉ ${t('Gruppieren')}</button>
        <button type="button" id="multi-ungroup" class="btn small" ${dis || !grouped ? 'disabled' : ''}>${t('Gruppe auflösen')}</button>
        ${merge ? `<button type="button" id="multi-merge" class="btn small" ${dis} title="${merge === 'zone' ? t('Flächen, die sich berühren oder überlappen, zu einer Fläche vereinigen (Eigenschaften der ersten bleiben)') : t('Strassen, deren Enden zusammenliegen (bis 10 m), zu einer Strasse verbinden (Eigenschaften der ersten bleiben)')}">${merge === 'zone' ? t('Flächen vereinigen') : t('Strassen verbinden')}</button>` : ''}
      </div>
      <div class="btn-row">
        <button type="button" id="multi-zoom" class="btn small">${t('Hinzoomen')}</button>
        <button type="button" id="multi-clear" class="btn small">${t('Auswahl aufheben')}</button>
        <button type="button" id="multi-delete" class="btn small danger" ${dis}>${t('Löschen')}</button>
      </div>`;
    this.$('multi-layer').onchange = (e) => { if (e.target.value) actions.setFeaturesLayer(ids, e.target.value); };
    const st = this.$('multi-status');
    if (st) st.onchange = (e) => { if (e.target.value) actions.setFeaturesStatus(roads.map((f) => f.id), e.target.value); };
    const mp = this.$('multi-phase');
    if (mp) mp.onchange = (e) => actions.setFeaturesPhase(ids, e.target.value || null);
    this.$('multi-group').onclick = () => actions.groupFeatures(ids);
    this.$('multi-ungroup').onclick = () => actions.ungroupFeatures(ids);
    const mergeBtn = this.$('multi-merge');
    if (mergeBtn) mergeBtn.onclick = () => actions.mergeFeatures(ids);
    this.$('multi-zoom').onclick = () => actions.zoomToFeatures(ids);
    this.$('multi-clear').onclick = () => tools.setSelection(null);
    this.$('multi-delete').onclick = () => tools.deleteSelection();
    return undefined;
  }

  // --- Elementliste ----------------------------------------------------------------

  refreshElements() {
    const { store, tools, actions } = this.ctx;
    const list = this.$('element-list');
    if (!list) return;
    const filterEl = this.$('element-filter');
    const q = (this.elementFilter || '').trim().toLowerCase();
    if (filterEl && document.activeElement !== filterEl) filterEl.value = this.elementFilter || '';
    const typeName = { road: t('Strasse'), junction: t('Punkt'), roundabout: t('Kreisel'), zone: t('Fläche') };
    const rows = store.doc.features.map((f) => {
      const layer = getLayer(store.doc, f.layerId) || {};
      const label = t(featureLabel(f));
      const extra = f.type === 'road' ? `${formatLength(pathLength(f.nodes))} · ${t(STATUSES.find((st) => st.id === f.status)?.label || f.status)}` : f.type === 'roundabout' ? `r = ${f.radius} m` : f.type === 'zone' ? tn(f.nodes.length, '{n} Eckpunkt', '{n} Eckpunkte') : (f.lines && f.lines.length ? f.lines.join(' ') : '');
      const extraG = f.group ? `${extra ? `${extra} · ` : ''}⧉ ${t('Gruppe')}` : extra;
      return { f, layer, label, type: typeName[f.type] || f.type, extra: extraG, text: `${label} ${typeName[f.type] || ''} ${layer.name || ''} ${extraG} ${f.note || ''}`.toLowerCase() };
    }).filter((r) => !q || r.text.includes(q));
    const count = this.$('elements-count');
    if (count) count.textContent = q ? `${rows.length}/${store.doc.features.length}` : `${store.doc.features.length}`;
    const shown = rows.slice(0, 200);
    list.innerHTML = shown.map(({ f, layer, label, type, extra }) => `<li class="${tools.isSelected(f.id) ? 'selected' : ''}${layer.visible === false ? ' muted' : ''}"><button type="button" class="linkish el-row" data-id="${esc(f.id)}" title="${t('Auswählen und hinzoomen')}"><span class="dot" style="background:${esc(layer.color || '#333')}"></span>${esc(label)}</button><span class="muted small">${esc(type)}${extra ? ` · ${esc(extra)}` : ''}${layer.visible === false ? ` · ${t('ausgeblendet')}` : ''}</span></li>`).join('')
      + (rows.length > shown.length ? `<li class="muted small">${t('… und {n} weitere; Filter eingrenzen.', { n: rows.length - shown.length })}</li>` : '')
      + (!rows.length ? `<li class="muted small">${store.doc.features.length ? t('Nichts gefunden.') : t('Noch keine Elemente.')}</li>` : '');
    list.querySelectorAll('.el-row').forEach((b) => {
      b.onclick = (e) => actions.selectFeature(b.dataset.id, { zoom: true, add: e.shiftKey });
    });
    if (filterEl && !filterEl.dataset.wired) {
      filterEl.dataset.wired = '1';
      filterEl.oninput = () => { this.elementFilter = filterEl.value; this.refreshElements(); };
    }
  }

  // --- Kontextmenü -----------------------------------------------------------------

  /** items: { header } | { separator } | { label, action, checked, disabled, danger }. Position in Seitenkoordinaten. */
  showContextMenu(items, { x, y }) {
    const menu = this.$('context-menu');
    if (!menu) return;
    menu.innerHTML = items.map((it, i) => {
      if (it.header) return `<div class="menu-header">${esc(it.header)}</div>`;
      if (it.separator) return '<div class="sep"></div>';
      return `<button type="button" class="${it.checked ? 'checked' : ''}${it.danger ? ' danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.icon ? `<span class="mi">${icon(it.icon, { size: 15 })}</span>` : ''}${esc(it.label)}</button>`;
    }).join('');
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
    menu.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const it = items[Number(b.dataset.i)];
        this.hideContextMenu();
        if (it && it.action) it.action();
      };
    });
    const close = (e) => { if (!menu.contains(e.target)) this.hideContextMenu(); };
    const esc2 = (e) => { if (e.key === 'Escape') this.hideContextMenu(); };
    setTimeout(() => {
      document.addEventListener('pointerdown', close, { capture: true });
      document.addEventListener('keydown', esc2, { capture: true });
    }, 0);
    this.menuCloser = () => {
      document.removeEventListener('pointerdown', close, { capture: true });
      document.removeEventListener('keydown', esc2, { capture: true });
    };
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  hideContextMenu() {
    const menu = this.$('context-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (this.menuCloser) this.menuCloser();
    this.menuCloser = null;
  }

  // --- Werkzeuge -----------------------------------------------------------------

  refreshTools() {
    const { store, tools, settings, actions } = this.ctx;
    const grid = this.$('tool-buttons');
    const editable = actions.canEdit();
    grid.innerHTML = TOOLS.map((tool) => `<button type="button" class="tool${tools.tool === tool.id ? ' active' : ''}" data-tool="${tool.id}" title="${esc(t(tool.hint))} (${t('Taste')} ${tool.key})" ${!editable && tool.id !== 'select' ? 'disabled' : ''}>${icon(tool.id, { size: 22 })}<span class="tool-label">${esc(t(tool.label))}</span><span class="tool-key">${tool.key}</span></button>`).join('');
    grid.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));
    const opts = this.$('tool-options');
    if (opts) {
      opts.innerHTML = tools.tool === 'adopt' ? `
        <label class="field inline">${t('Übernehmen als')}
          <select id="adopt-status">
            <option value="existing" ${tools.adoptStatus !== 'remove' ? 'selected' : ''}>${t('Bestehend (bearbeiten)')}</option>
            <option value="remove" ${tools.adoptStatus === 'remove' ? 'selected' : ''}>${t('Rückbau (entfernen)')}</option>
          </select>
        </label>
        <p class="muted small">${t('OSM-Strassen der Ansicht werden eingeblendet; die Strasse unter dem Zeiger leuchtet orange. Bereits übernommene Strassen werden ausgewählt statt verdoppelt.')}</p>` : '';
      const sel = this.$('adopt-status');
      if (sel) sel.onchange = () => { tools.adoptStatus = sel.value; };
    }
    const multi = this.$('multi-mode');
    if (multi) {
      multi.checked = tools.multiMode;
      multi.onchange = () => { tools.multiMode = multi.checked; };
    }

    const layerSel = this.$('active-layer');
    layerSel.innerHTML = store.doc.layers.map((l) => `<option value="${l.id}"${l.id === actions.activeLayerId() ? ' selected' : ''}>${esc(l.name)}${l.visible === false ? ` (${t('ausgeblendet')})` : ''}</option>`).join('');
    layerSel.onchange = () => actions.setActiveLayer(layerSel.value);

    const kindSel = this.$('default-kind');
    kindSel.innerHTML = options(ROAD_KINDS, actions.defaultRoadKind());
    kindSel.onchange = () => actions.setDefaultRoadKind(kindSel.value);
    const zoneSel = this.$('default-zone-kind');
    zoneSel.innerHTML = options(ZONE_KINDS, actions.defaultZoneKind());
    zoneSel.onchange = () => actions.setDefaultZoneKind(zoneSel.value);

    const snap = this.$('snap-settings');
    snap.innerHTML = `
      <label class="check"><input type="checkbox" id="set-snap" ${settings.snapEnabled ? 'checked' : ''}> ${t('Einrasten aktiv')}</label>
      <label class="field">${t('Taste zum Aussetzen für die aktuelle Aktion')}
        <select id="set-modifier">
          <option value="Shift"${settings.snapModifier === 'Shift' ? ' selected' : ''}>Shift</option>
          <option value="Control"${settings.snapModifier === 'Control' ? ' selected' : ''}>Ctrl / Strg</option>
          <option value="Alt"${settings.snapModifier === 'Alt' ? ' selected' : ''}>Alt</option>
        </select></label>
      <label class="check"><input type="checkbox" id="set-snap-osm" ${settings.snapOsm ? 'checked' : ''}> ${t('An bestehende OSM-Strassen einrasten')}</label>
      <label class="check"><input type="checkbox" id="set-show-osm" ${settings.showOsm ? 'checked' : ''}> ${t('Geladene OSM-Strassen anzeigen')}</label>
      <label class="field">${t('Toleranz')}: <span id="set-tol-val">${settings.snapTolerance}</span> px
        <input type="range" id="set-tol" min="4" max="40" value="${settings.snapTolerance}"></label>`;
    const sources = actions.tileSources();
    const bases = sources.filter((t) => !t.overlay);
    const overlays = sources.filter((t) => t.overlay);
    const mapBox = this.$('map-settings');
    mapBox.innerHTML = `
      <label class="field">${t('Grundkarte')}<select id="set-basemap">${bases.map((src) => `<option value="${esc(src.id)}"${src.id === settings.basemap ? ' selected' : ''}>${esc(src.label)}</option>`).join('')}</select></label>
      ${overlays.map((src) => `<label class="check"><input type="checkbox" class="set-overlay" data-id="${esc(src.id)}" ${settings.overlays.includes(src.id) ? 'checked' : ''}> ${esc(src.label)}${src.minZoom ? ` <span class="muted small">(${t('ab Zoom')} ${src.minZoom})</span>` : ''}</label>`).join('')}
      ${bases.length <= 1 ? `<p class="muted small">${t('Weitere Kartenquellen lassen sich auf dem Server über TILE_SOURCES einrichten.')}</p>` : ''}
      <label class="field">Sprache / Langue / Lingua<select id="set-language">${LANGUAGES.map((l) => `<option value="${l.id}" ${getLanguage() === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}</select></label>
      <label class="field">${t('Darstellung')}<select id="set-theme">${[['system', 'Wie das System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([id, label]) => `<option value="${id}" ${(settings.theme || 'system') === id ? 'selected' : ''}>${t(label)}</option>`).join('')}</select></label>`;
    this.$('set-basemap').onchange = (e) => actions.updateSettings({ basemap: e.target.value });
    this.$('set-theme').onchange = (e) => actions.updateSettings({ theme: e.target.value });
    this.$('set-language').onchange = (e) => actions.updateSettings({ language: e.target.value });
    mapBox.querySelectorAll('.set-overlay').forEach((cb) => {
      cb.onchange = () => {
        const on = new Set(settings.overlays);
        if (cb.checked) on.add(cb.dataset.id);
        else on.delete(cb.dataset.id);
        actions.updateSettings({ overlays: Array.from(on) });
      };
    });
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
    if (tools.multi.size > 1 && !tools.isGroupSelection()) return this.refreshMultiProperties(box);
    if (!f) {
      box.innerHTML = `<h3>${t('Eigenschaften')}</h3><p class="muted">${t('Kein Element ausgewählt. Mit dem Werkzeug „Auswählen“ ein Element anklicken.')}</p>`;
      return;
    }
    const editable = actions.canEdit();
    const dis = editable ? '' : 'disabled';
    const layerOpts = store.doc.layers.map((l) => ({ id: l.id, label: l.name }));
    let specific = '';
    if (f.type === 'road') {
      const segIndex = Math.min(sel.segIndex ?? 0, f.segments.length - 1);
      const seg = f.segments[segIndex];
      const chips = f.segments.map((s, i) => `<button type="button" class="seg seg-${s.level}${i === segIndex ? ' active' : ''}" data-seg="${i}" title="${t('Abschnitt')} ${i + 1}: ${esc(t(LEVELS.find((l) => l.id === s.level).label))}">${i + 1}</button>`).join('');
      specific = `
        <label class="field">${t('Strassentyp')}<select id="prop-kind" ${dis}>${options(ROAD_KINDS, f.kind)}</select></label>
        <label class="field">${t('Status')}<select id="prop-status" ${dis}>${options(STATUSES, f.status)}</select></label>
        <label class="check"><input type="checkbox" id="prop-oneway"${f.oneway ? ' checked' : ''} ${dis}> ${t('Einbahn (in Zeichenrichtung)')}</label>
        <label class="field">${t('Zugang')}<select id="prop-access" ${dis}>${options(ROAD_ACCESS, f.access || 'all')}</select></label>
        <label class="field">${t('Tempolimit (km/h)')}
          <div class="speed-row">
            <input type="number" id="prop-maxspeed" min="5" max="200" step="5" value="${f.maxspeed ?? ''}" placeholder="${t('Standard')} ${roadSpeed({ ...f, maxspeed: null }) || '–'}" ${dis}>
            ${[20, 30, 50, 80].map((v) => `<button type="button" class="speed${f.maxspeed === v ? ' active' : ''}" data-speed="${v}" ${dis}>${v}</button>`).join('')}
            <button type="button" class="speed${f.maxspeed ? '' : ' active'}" data-speed="" title="${t('Standard je Strassentyp')}" ${dis}>${t('Std.')}</button>
          </div>
        </label>
        <label class="field">${t('Breite (m)')}<input type="number" id="prop-width" min="1" max="60" step="0.5" value="${f.section ? sectionWidth(f.section) : (f.width ?? '')}" placeholder="${t('Standard')} ${roadWidthMeters({ ...f, width: null, section: null })} m" ${f.section ? `disabled title="${t('Ergibt sich aus dem Querschnitt')}"` : dis}></label>
        ${roadKind(f).motorOnly ? `<p class="muted small">${t('Autobahn/Autostrasse: keine Fussgänger und Velos; zwei getrennte Fahrbahnen ab Zoom 15.')}</p>` : ''}
        ${sectionBlock(f, editable)}
        <div class="btn-row">
          <button type="button" id="prop-smooth" class="btn small" ${dis || f.nodes.length < 3 ? 'disabled' : ''} title="${t('Knicke durch eine Spline ersetzen (fügt Zwischenpunkte ein)')}">${t('Glätten')}</button>
          <button type="button" id="prop-simplify" class="btn small" ${dis || f.nodes.length < 3 ? 'disabled' : ''} title="${t('Überflüssige Punkte entfernen (Toleranz 1 m)')}">${t('Vereinfachen')}</button>
          <span class="muted small">${tn(f.nodes.length, '{n} Punkt', '{n} Punkte')}</span>
        </div>
        ${profileBlock(f)}
        ${parcelsBlock(f, editable)}
        <div class="segments">
          <div class="seg-head">${t('Abschnitte')} <span class="muted">(${f.segments.length}, ${fmtLen(pathLength(f.nodes))})</span></div>
          <div class="seg-chips">${chips}</div>
          <div class="seg-nav">
            <button type="button" id="seg-prev" ${segIndex === 0 ? 'disabled' : ''}>◀</button>
            <span>${t('Abschnitt {i} von {n}', { i: segIndex + 1, n: f.segments.length })}</span>
            <button type="button" id="seg-next" ${segIndex >= f.segments.length - 1 ? 'disabled' : ''}>▶</button>
          </div>
          <div class="radio-row">
            ${LEVELS.map((l) => `<label class="radio"><input type="radio" name="seg-level" value="${l.id}"${seg.level === l.id ? ' checked' : ''} ${dis}> ${esc(t(l.label))}</label>`).join('')}
          </div>
          <button type="button" id="seg-apply-all" class="btn small" ${dis}>${t('Diese Führung auf alle Abschnitte anwenden')}</button>
          <label class="field">${t('Tempolimit dieses Abschnitts (km/h)')}<input type="number" id="seg-maxspeed" min="5" max="200" step="5" value="${seg.maxspeed ?? ''}" placeholder="${t('wie Strasse')} (${segmentSpeed({ ...f, segments: [{ level: 'ground', maxspeed: null }] }, 0) || '–'})" ${dis}></label>
          <label class="field">${t('Zugang dieses Abschnitts')}<select id="seg-access" ${dis}><option value="" ${seg.access ? '' : 'selected'}>${t('wie Strasse')} (${t(ROAD_ACCESS.find((a) => a.id === (f.access || 'all')).label)})</option>${ROAD_ACCESS.map((a) => `<option value="${a.id}" ${seg.access === a.id ? 'selected' : ''}>${t(a.label)}</option>`).join('')}</select></label>
          ${segmentAccess(f, segIndex) === 'bus' ? `<p class="muted small">${t('Busschleuse: für Autos gesperrt, Busse fahren mit höchstens 30 km/h durch.')}</p>` : ''}
          <div class="btn-row">
            <button type="button" id="seg-split-before" class="btn small" ${dis || segIndex < 1 ? 'disabled' : ''} title="${t('Strasse am Anfang dieses Abschnitts in zwei Strassen teilen')}">${t('Vor Abschnitt teilen')}</button>
            <button type="button" id="seg-split-after" class="btn small" ${dis || segIndex > f.segments.length - 2 ? 'disabled' : ''} title="${t('Strasse am Ende dieses Abschnitts in zwei Strassen teilen')}">${t('Nach Abschnitt teilen')}</button>
          </div>
        </div>`;
    } else if (f.type === 'junction') {
      const turns = junctionTurns(f);
      const turnsOn = junctionKind(f).turns;
      specific = `<label class="field">${t('Art')}<select id="prop-jkind" ${dis}>${options(JUNCTION_KINDS, f.kind)}</select></label>
        ${f.kind === 'interchange' ? `<p class="muted small">${t('Kreuzungsfrei: keine Wartezeit und kein Abbiegezuschlag im Routen-Rechner.')}</p>` : ''}
        ${turnsOn ? `
        <div class="field">${t('Abbiegen erlaubt')} <span class="muted small">${t('(bezogen auf die Fahrtrichtung, Routen-Rechner)')}</span>
          <div class="check-row">
            ${[['left', '↰ links'], ['straight', '↑ geradeaus'], ['right', '↱ rechts'], ['uturn', '↶ wenden']].map(([k, l]) => `<label class="check"><input type="checkbox" class="turn" data-turn="${k}" ${turns[k] ? 'checked' : ''} ${dis}> ${t(l)}</label>`).join('')}
          </div>
          ${f.turns ? `<button type="button" id="turns-reset" class="btn small" ${dis}>${t('Standard')}</button>` : ''}
        </div>` : ''}
        ${f.kind === 'busstop' ? `<label class="field">${t('Liniennummern (durch Komma)')}<input type="text" id="prop-lines" value="${esc((f.lines || []).join(', '))}" placeholder="12, 45" ${dis}></label>
        <p class="muted small">${t('Haltestellen lassen sich im Auswahl-Werkzeug am Griff verschieben. Buslinien mit Fahrzeit stehen im Routen-Tab.')}</p>` : ''}`;
    } else if (f.type === 'roundabout') {
      specific = `<label class="field">${t('Radius (m)')}<input type="number" id="prop-radius" min="4" max="200" step="0.5" value="${f.radius}" ${dis}></label>`;
    } else if (f.type === 'zone') {
      const k = ZONE_KINDS.find((z) => z.id === f.kind) || ZONE_KINDS[4];
      specific = `<label class="field">${t('Art der Fläche')}<select id="prop-zkind" ${dis}>${options(ZONE_KINDS, f.kind)}</select></label>
        ${k.speed !== null && k.speed < 30 ? `<label class="check"><input type="checkbox" id="prop-bus-allowed" ${f.busAllowed ? 'checked' : ''} ${dis}> ${t('Busse dürfen durchfahren (20 km/h)')}</label>` : ''}
        <p class="muted small">${k.speed === 0 ? t('Für Autos gesperrt (Routen-Rechner).') : k.speed ? t('Tempolimit {v} km/h für alle Strassen in der Fläche (Routen-Rechner).', { v: k.speed }) : t('Ohne Wirkung auf den Routen-Rechner.')} ${tn(f.nodes.length, '{n} Eckpunkt.', '{n} Eckpunkte.')}</p>`;
    }
    box.innerHTML = `
      <h3>${t({ road: 'Strasse', junction: 'Kreuzung / Punkt', roundabout: 'Kreisel', zone: 'Zone / Fläche' }[f.type])} <span class="muted">${esc(t(featureLabel(f)))}</span></h3>
      <label class="field">${t('Name')}<input type="text" id="prop-name" value="${esc(f.name)}" placeholder="${t('z. B. Hauptstrasse neu')}" ${dis}></label>
      <label class="field">${t('Ebene')}<select id="prop-layer" ${dis}>${options(layerOpts, f.layerId)}</select></label>
      ${(store.doc.phases || []).length ? `<label class="field">${t('Etappe')}<select id="prop-phase" ${dis}><option value="">${t('Alle Etappen')}</option>${store.doc.phases.map((ph, i) => `<option value="${esc(ph.id)}" ${f.phase === ph.id ? 'selected' : ''}>${esc(phaseLabel(ph, i))}</option>`).join('')}</select></label>` : ''}
      ${f.group ? `<p class="group-row small"><span class="group-badge" title="${t('Gruppe')}">⧉</span> ${tn(tools.multi.size, 'Gruppe mit {n} Element – wird zusammen verschoben und gelöscht.', 'Gruppe mit {n} Elementen – wird zusammen verschoben und gelöscht.')} <button type="button" id="prop-ungroup" class="linkish" ${dis}>${t('Gruppe auflösen')}</button></p>` : ''}
      ${specific}
      <label class="field">${t('Notiz')}<textarea id="prop-note" rows="2" placeholder="${t('Begründung, Hinweise…')}" ${dis}>${esc(f.note)}</textarea></label>
      <div class="btn-row">
        <button type="button" id="prop-zoom" class="btn small">${t('Hinzoomen')}</button>
        <button type="button" id="prop-delete" class="btn small danger" ${dis}>${t('Löschen (Entf)')}</button>
      </div>`;
    const patch = (label, fn) => actions.patchFeature(f.id, label, fn);
    if (f.type === 'road') {
      this.$('prop-smooth').onclick = () => actions.smoothRoad(f.id);
      this.$('prop-simplify').onclick = () => actions.simplifyRoad(f.id);
      const loadBtn = this.$('prop-profile-load');
      if (loadBtn) loadBtn.onclick = () => actions.loadProfile(f.id);
      const clearBtn = this.$('prop-profile-clear');
      if (clearBtn) clearBtn.onclick = () => patch('Höhenprofil entfernen', (x) => { x.profile = null; });
      const canvas = this.$('prop-profile-chart');
      if (canvas) drawProfileChart(canvas, f);
      const parcelsLoad = this.$('parcels-load');
      if (parcelsLoad) parcelsLoad.onclick = () => actions.loadParcels(f.id);
      const parcelsClear = this.$('parcels-clear');
      if (parcelsClear) parcelsClear.onclick = () => actions.clearParcels(f.id);
    }
    this.$('prop-name').onchange = (e) => patch('Name ändern', (x) => { x.name = e.target.value.trim(); });
    this.$('prop-layer').onchange = (e) => patch('Ebene wechseln', (x) => { x.layerId = e.target.value; });
    const phaseSel = this.$('prop-phase');
    if (phaseSel) phaseSel.onchange = (e) => actions.setFeaturesPhase([f.id], e.target.value || null);
    const ungroup = this.$('prop-ungroup');
    if (ungroup) ungroup.onclick = () => actions.ungroupFeatures([f.id]);
    this.$('prop-note').onchange = (e) => patch('Notiz ändern', (x) => { x.note = e.target.value; });
    this.$('prop-delete').onclick = () => tools.deleteSelection();
    this.$('prop-zoom').onclick = () => actions.zoomToFeature(f.id);
    if (f.type === 'road') {
      const segIndex = Math.min(sel.segIndex ?? 0, f.segments.length - 1);
      this.$('prop-kind').onchange = (e) => patch('Strassentyp ändern', (x) => { x.kind = e.target.value; });
      this.$('prop-status').onchange = (e) => patch('Status ändern', (x) => { x.status = e.target.value; });
      this.$('prop-oneway').onchange = (e) => patch('Einbahn ändern', (x) => { x.oneway = e.target.checked; });
      this.$('prop-access').onchange = (e) => patch('Zugang ändern', (x) => { x.access = e.target.value; });
      this.$('seg-access').onchange = (e) => patch('Zugang des Abschnitts ändern', (x) => { x.segments[segIndex].access = e.target.value || null; });
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
      this.$('prop-width').onchange = (e) => patch('Breite ändern', (x) => { x.width = e.target.value === '' ? null : Math.max(1, Math.min(60, Math.round(Number(e.target.value) * 2) / 2)); });
      this.wireSection(f, patch);
      this.$('seg-maxspeed').onchange = (e) => patch('Abschnitts-Tempolimit ändern', (x) => { x.segments[segIndex].maxspeed = e.target.value === '' ? null : Math.max(5, Math.min(200, Math.round(Number(e.target.value) / 5) * 5)); });
      const split = (nodeIndex) => {
        let newId = null;
        actions.commitDoc('Strasse teilen', (d) => { newId = splitRoadAtNode(d, f.id, nodeIndex); });
        if (newId) tools.setSelection({ featureId: newId, segIndex: 0 });
      };
      this.$('seg-split-before').onclick = () => split(segIndex);
      this.$('seg-split-after').onclick = () => split(segIndex + 1);
    } else if (f.type === 'junction') {
      this.$('prop-jkind').onchange = (e) => patch('Art ändern', (x) => { x.kind = e.target.value; });
      box.querySelectorAll('.turn').forEach((cb) => {
        cb.onchange = () => patch('Abbiegeregel ändern', (x) => { x.turns = { ...junctionTurns(x), [cb.dataset.turn]: cb.checked }; });
      });
      const reset = this.$('turns-reset');
      if (reset) reset.onclick = () => patch('Abbiegeregeln zurücksetzen', (x) => { x.turns = null; });
      const lines = this.$('prop-lines');
      if (lines) lines.onchange = (e) => patch('Liniennummern ändern', (x) => { x.lines = normalizeLines(e.target.value.split(',')); });
    } else if (f.type === 'zone') {
      this.$('prop-zkind').onchange = (e) => patch('Art der Fläche ändern', (x) => { x.kind = e.target.value; });
      const busAllowed = this.$('prop-bus-allowed');
      if (busAllowed) busAllowed.onchange = (e) => patch('Busdurchfahrt ändern', (x) => { x.busAllowed = e.target.checked; });
    } else if (f.type === 'roundabout') {
      this.$('prop-radius').onchange = (e) => {
        const r = Math.max(4, Math.min(200, Number(e.target.value) || 15));
        patch('Radius ändern', (x) => { x.radius = Math.round(r * 10) / 10; });
      };
    }
  }

  wirePairs() {
    const { actions } = this.ctx;
    const el = this.$('route-panel');
    const add = this.$('pair-add');
    if (add) add.onclick = () => actions.addPair();
    el.querySelectorAll('.pair-name').forEach((inp) => { inp.onchange = () => actions.renamePair(inp.dataset.id, inp.value); });
    el.querySelectorAll('.pair-set').forEach((b) => { b.onclick = () => actions.capturePair(b.dataset.id); });
    el.querySelectorAll('.pair-swap').forEach((b) => { b.onclick = () => actions.swapPair(b.dataset.id); });
    el.querySelectorAll('.pair-del').forEach((b) => { b.onclick = () => actions.removePair(b.dataset.id); });
    el.querySelectorAll('.pair-vehicle').forEach((sel) => { sel.onchange = () => actions.setPairVehicle(sel.dataset.id, sel.value); });
  }

  wireBus() {
    const { actions } = this.ctx;
    const el = this.$('route-panel');
    const add = this.$('bus-add');
    if (add) add.onclick = () => actions.addBusLine();
    el.querySelectorAll('.bus-name').forEach((inp) => { inp.onchange = () => actions.patchBusLine(inp.dataset.id, 'Buslinie umbenennen', (l) => { l.name = inp.value.trim().slice(0, 12); }); });
    el.querySelectorAll('.bus-color').forEach((inp) => { inp.onchange = () => actions.patchBusLine(inp.dataset.id, 'Linienfarbe ändern', (l) => { l.color = inp.value; }); });
    el.querySelectorAll('.bus-dwell').forEach((inp) => { inp.onchange = () => actions.patchBusLine(inp.dataset.id, 'Haltezeit ändern', (l) => { l.dwell = Math.max(0, Math.min(300, Math.round(Number(inp.value) || 0))); }); });
    el.querySelectorAll('.bus-capture').forEach((b) => { b.onclick = () => actions.captureBusStops(b.dataset.id); });
    el.querySelectorAll('.bus-race').forEach((b) => { b.onclick = () => actions.startRace({ kind: 'bus', id: b.dataset.id }); });
    el.querySelectorAll('.bus-del').forEach((b) => { b.onclick = () => actions.removeBusLine(b.dataset.id); });
    el.querySelectorAll('.stop-del').forEach((b) => { b.onclick = () => actions.patchBusLine(b.dataset.id, 'Haltestelle aus Linie entfernen', (l) => { l.stops.splice(Number(b.dataset.i), 1); }); });
    el.querySelectorAll('.stop-up').forEach((b) => {
      b.onclick = () => actions.patchBusLine(b.dataset.id, 'Haltestelle verschieben', (l) => {
        const i = Number(b.dataset.i);
        if (i > 0) [l.stops[i - 1], l.stops[i]] = [l.stops[i], l.stops[i - 1]];
      });
    });
    el.querySelectorAll('.stop-focus').forEach((b) => { b.onclick = () => actions.zoomToFeature(b.dataset.stop); });
    el.querySelectorAll('.bus-timetable').forEach((b) => { b.onclick = () => actions.checkTimetable(b.dataset.id); });
    el.querySelectorAll('.bus-calibrate').forEach((b) => { b.onclick = () => actions.calibrateDwell(b.dataset.id); });
    const load = this.$('transit-load');
    if (load) load.onclick = () => actions.loadTransit();
    el.querySelectorAll('.transit-adopt').forEach((b) => { b.onclick = () => actions.adoptBusRoute(Number(b.dataset.id)); });
  }

  wireIsochrone() {
    const { actions } = this.ctx;
    const set = this.$('iso-set');
    if (set) set.onclick = () => actions.captureIsochrone();
    const minutes = this.$('iso-minutes');
    if (minutes) minutes.onchange = () => actions.setIsochrone({ minutes: minutes.value.split(',').map(Number) });
    const mode = this.$('iso-mode');
    if (mode) mode.onchange = () => actions.setIsochrone({ mode: mode.value });
    const clear = this.$('iso-clear');
    if (clear) clear.onclick = () => actions.clearIsochrone();
  }

  /** Ereignisse des Querschnitt-Editors einer Strasse. */
  wireSection(f, patch) {
    const create = this.$('sec-create');
    if (create) create.onclick = () => patch('Querschnitt festlegen', (x) => { x.section = defaultSection(x.kind); });
    const remove = this.$('sec-remove');
    if (remove) remove.onclick = () => patch('Querschnitt entfernen', (x) => { x.section = null; });
    if (!f.section) return;
    const box = this.$('properties');
    box.querySelectorAll('.sec-num').forEach((inp) => {
      inp.onchange = () => patch('Querschnitt ändern', (x) => {
        if (!x.section) return;
        const [lo, hi] = SECTION_LIMITS[inp.dataset.key];
        const v = Math.max(lo, Math.min(hi, Number(inp.value)));
        x.section[inp.dataset.key] = inp.dataset.key === 'lanes' ? Math.round(v) : Math.round(v * 4) / 4;
      });
    });
    box.querySelectorAll('.sec-flag').forEach((cb) => {
      cb.onchange = () => patch('Querschnitt ändern', (x) => { if (x.section) x.section[cb.dataset.key] = cb.checked; });
    });
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
        <input type="radio" name="layer-active" title="${t('Aktive Ebene (neue Elemente landen hier)')}" ${l.id === actions.activeLayerId() ? 'checked' : ''}>
        <input type="checkbox" class="layer-visible" title="${t('Ein-/ausblenden')}" ${l.visible !== false ? 'checked' : ''}>
        <input type="color" class="layer-color" title="${t('Farbe')}" value="${esc(l.color)}" ${editable ? '' : 'disabled'}>
        <input type="text" class="layer-name" value="${esc(l.name)}" title="${t('Name der Ebene')}" ${editable ? '' : 'readonly'}>
        <span class="muted count" title="${t('Elemente')}">${counts[l.id] || 0}</span>
        <button type="button" class="icon-btn layer-up" title="${t('Nach oben')}" ${i === 0 || !editable ? 'disabled' : ''}>▲</button>
        <button type="button" class="icon-btn layer-down" title="${t('Nach unten')}" ${i === store.doc.layers.length - 1 || !editable ? 'disabled' : ''}>▼</button>
        <button type="button" class="icon-btn layer-delete" title="${t('Ebene löschen')}" ${store.doc.layers.length === 1 || !editable ? 'disabled' : ''}>✕</button>
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
    this.refreshPhases();
  }

  /** Etappen: Liste mit Name und Jahr, Zahl der Elemente, Ansicht „bis Etappe“. */
  refreshPhases() {
    const { store, actions } = this.ctx;
    const box = this.$('phase-box');
    if (!box) return;
    const editable = actions.canEdit();
    const dis = editable ? '' : 'disabled';
    const phases = store.doc.phases || [];
    const counts = {};
    for (const f of store.doc.features) if (f.phase) counts[f.phase] = (counts[f.phase] || 0) + 1;
    const view = actions.phaseView();
    box.innerHTML = `
      ${phases.map((ph, i) => `
      <div class="phase-row" data-id="${esc(ph.id)}">
        <span class="muted">${i + 1}.</span>
        <input type="text" class="phase-name" value="${esc(ph.name)}" placeholder="${t('Etappe')} ${i + 1}" title="${t('Name der Etappe')}" ${editable ? '' : 'readonly'}>
        <input type="number" class="phase-year" value="${ph.year ?? ''}" placeholder="${t('Jahr')}" min="1900" max="2200" title="${t('Jahr')}" ${editable ? '' : 'readonly'}>
        <span class="muted count" title="${t('Elemente')}">${counts[ph.id] || 0}</span>
        <button type="button" class="icon-btn phase-delete" title="${t('Etappe löschen')}" ${dis}>✕</button>
      </div>`).join('')}
      <div class="btn-row"><button type="button" id="phase-add" class="btn small" ${dis}>${t('+ Etappe')}</button></div>
      ${phases.length ? `<label class="field">${t('Ansicht')}<select id="phase-view"><option value="">${t('Endzustand (alle Etappen)')}</option>${phases.map((ph, i) => `<option value="${esc(ph.id)}" ${view === ph.id ? 'selected' : ''}>${t('bis')} ${esc(phaseLabel(ph, i))}</option>`).join('')}</select></label>
      <p class="muted small">${t('Elemente ohne Etappe gehören zu jedem Zustand. Etappe je Element in den Eigenschaften oder per Rechtsklick.')}</p>` : ''}`;
    this.$('phase-add').onclick = () => actions.addPhase();
    box.querySelectorAll('.phase-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.phase-name').onchange = (e) => actions.patchPhase(id, 'Etappe umbenennen', (ph) => { ph.name = e.target.value.trim().slice(0, 40); });
      row.querySelector('.phase-year').onchange = (e) => actions.patchPhase(id, 'Jahr der Etappe ändern', (ph) => { const y = parseInt(e.target.value, 10); ph.year = Number.isInteger(y) && y >= 1900 && y <= 2200 ? y : null; });
      row.querySelector('.phase-delete').onclick = () => actions.removePhase(id);
    });
    const sel = this.$('phase-view');
    if (sel) sel.onchange = (e) => actions.setPhaseView(e.target.value || null);
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
    let badge = `<span class="badge warn">${t('nicht gespeichert')}</span>`;
    if (saved && !editable) badge = `<span class="badge muted">${t('nur Ansicht')}</span>`;
    else if (saved && !dirty) badge = `<span class="badge ok">${t('gespeichert')}</span>`;
    else if (saved) badge = `<span class="badge warn">${t('ungespeicherte Änderungen')}</span>`;
    this.$('draft-current').innerHTML = `
      <h3>${esc(store.doc.name)} ${badge}</h3>
      <p class="muted">${t('{roads} Strassen ({len}), {junctions} Kreuzungen, {roundabouts} Kreisel', { roads: s.roads, len: fmtLen(s.lengthMeters), junctions: s.junctions, roundabouts: s.roundabouts })}${s.zones ? `, ${t('{n} Flächen', { n: s.zones })}` : ''}${s.bridges ? `, ${t('{n} Brückenabschnitte', { n: s.bridges })}` : ''}${s.tunnels ? `, ${t('{n} Tunnelabschnitte', { n: s.tunnels })}` : ''}</p>
      ${saved ? `<p class="muted small">Link: <code>${esc(location.origin)}/d/${esc(actions.draftId())}</code></p>` : ''}
      <div class="btn-row">
        <button type="button" id="d-new" class="btn small">${t('Neu')}</button>
        ${editable ? `<button type="button" id="d-save" class="btn small primary">${t('Speichern')}</button>` : `<button type="button" id="d-own" class="btn small primary">${t('Eigene Kopie anlegen')}</button>`}
        <button type="button" id="d-copy" class="btn small">${t('Als neuen Entwurf speichern')}</button>
      </div>
      <div class="btn-row">
        <button type="button" id="d-share" class="btn small">${t('Teilen…')}</button>
        <button type="button" id="d-export" class="btn small">${t('JSON exportieren')}</button>
        <button type="button" id="d-geojson" class="btn small">${t('GeoJSON exportieren')}</button>
        <button type="button" id="d-import" class="btn small" title="${t('Stadtplaner-JSON ersetzt den Entwurf; eine Sicherung wird als neuer Entwurf eingespielt; GeoJSON, GPX und KML kommen als neue Ebene dazu')}">${t('Importieren (JSON, Sicherung, GeoJSON, GPX, KML)')}</button>
      </div>
      <div class="btn-row">
        <button type="button" id="d-export-map" class="btn small">${t('Karte als PNG / PDF exportieren…')}</button>
        ${saved ? `<button type="button" id="d-backup" class="btn small" title="${t('Vollständige Sicherung vom Server: aktueller Stand, alle Versionen und Kommentare')}">${t('Sicherung herunterladen')}</button>` : ''}
      </div>
      <div id="draft-lifecycle"></div>`;
    this.$('d-new').onclick = () => actions.newDraft();
    if (this.$('d-save')) this.$('d-save').onclick = () => actions.saveDraft();
    if (this.$('d-own')) this.$('d-own').onclick = () => actions.makeOwnCopy();
    this.$('d-copy').onclick = () => actions.saveCopy();
    this.$('d-share').onclick = () => actions.share();
    this.$('d-export').onclick = () => actions.exportJson();
    this.$('d-geojson').onclick = () => actions.exportGeoJson();
    this.$('d-import').onclick = () => this.$('import-file').click();
    this.$('d-export-map').onclick = () => this.openExport();
    if (this.$('d-backup')) this.$('d-backup').onclick = () => actions.downloadBackup();
    this.renderLifecycle();

    const drafts = local.listDrafts();
    const list = this.$('draft-list');
    if (!drafts.length) {
      list.innerHTML = `<p class="muted">${t('Noch keine Entwürfe in diesem Browser. Speichern legt den ersten an.')}</p>`;
    } else {
      list.innerHTML = drafts.map((d) => `
        <div class="list-row${d.id === actions.draftId() ? ' active' : ''}" data-id="${d.id}">
          <div class="grow"><div class="title">${esc(d.name)} ${d.token ? '' : `<span class="badge muted">${t('nur Ansicht')}</span>`}</div><div class="muted">${fmtDate(d.updatedAt)}</div></div>
          <button type="button" class="btn small d-open" ${d.id === actions.draftId() ? 'disabled' : ''}>${t('Öffnen')}</button>
          <button type="button" class="icon-btn d-delete" title="${t('Löschen / entfernen')}">✕</button>
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

  /** Ablaufdatum und E-Mail-Erinnerung (nur für gespeicherte Entwürfe; die Adresse sehen nur Besitzer). */
  renderLifecycle() {
    const { actions } = this.ctx;
    const el = this.$('draft-lifecycle');
    if (!el) return;
    const lc = actions.lifecycle();
    if (!actions.isSaved() || !lc.retentionDays) {
      el.innerHTML = '';
      return;
    }
    let html = `<p class="muted small" id="lifecycle-expiry">${t('Entwürfe werden {days} Tage nach dem letzten Speichern gelöscht.', { days: lc.retentionDays })}${lc.expiresAt ? ` ${t('Dieser Entwurf wird am {date} gelöscht, falls er bis dahin nicht erneut gespeichert wird.', { date: esc(fmtDay(lc.expiresAt)) })}` : ''}</p>`;
    // Die E-Mail-Erinnerung gibt es nur, wenn der Server SMTP konfiguriert hat (Meta-Tag stadtplaner-config)
    if (actions.canEdit() && lc.mail) {
      const r = lc.reminder;
      if (!r) {
        actions.loadReminder().then((loaded) => { if (loaded) this.renderLifecycle(); });
      } else if (r.error) {
        html += `<p class="muted small">${t('Erinnerung konnte nicht geladen werden')}: ${esc(r.error)}</p>`;
      } else {
        html += `
        <label class="small" for="reminder-email">${t('E-Mail für eine Erinnerung zur Sicherung, einen Monat und eine Woche vor dem Löschen (leer = keine)')}</label>
        <div class="link-row"><input type="email" id="reminder-email" value="${esc(r.email || '')}" placeholder="name@example.ch" autocomplete="email"><button type="button" id="reminder-save" class="btn small">${t('Übernehmen')}</button></div>
        ${r.email ? `<p class="muted small" id="reminder-state">${t('Erinnerung geht an {email}.', { email: esc(r.email) })}</p>` : ''}`;
      }
    }
    el.innerHTML = html;
    const save = this.$('reminder-save');
    if (save) {
      const submit = () => actions.setReminderEmail(this.$('reminder-email').value).then(() => this.renderLifecycle()).catch((e) => this.toast(`${t('Erinnerung konnte nicht gespeichert werden')}: ${e.message}`, 'error', 6000));
      save.onclick = submit;
      this.$('reminder-email').onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      };
    }
  }

  // --- Verlauf ---------------------------------------------------------------------------

  refreshHistory() {
    const { store, actions } = this.ctx;
    const undoLabel = store.undoStack.length ? store.undoStack[store.undoStack.length - 1].label : '–';
    const redoLabel = store.redoStack.length ? store.redoStack[store.redoStack.length - 1].label : '–';
    const recent = store.undoStack.slice(-8).reverse();
    this.$('history-undo').innerHTML = `
      <h3>${t('Änderungen in dieser Sitzung')}</h3>
      <div class="btn-row">
        <button type="button" id="h-undo" class="btn small" ${store.canUndo() && actions.canEdit() ? '' : 'disabled'}>↶ ${t('Rückgängig')}: ${esc(t(undoLabel))}</button>
        <button type="button" id="h-redo" class="btn small" ${store.canRedo() && actions.canEdit() ? '' : 'disabled'}>↷ ${t('Wiederholen')}: ${esc(t(redoLabel))}</button>
      </div>
      ${recent.length ? `<ol class="undo-list">${recent.map((e) => `<li>${esc(t(e.label))}</li>`).join('')}</ol>` : `<p class="muted">${t('Noch keine Änderungen.')}</p>`}`;
    this.$('h-undo').onclick = () => actions.undo();
    this.$('h-redo').onclick = () => actions.redo();

    const list = this.$('version-list');
    if (!actions.isSaved()) {
      list.innerHTML = `<h3>${t('Gespeicherte Versionen')}</h3><p class="muted">${t('Jedes Speichern legt auf dem Server eine Version ab, die hier wiederhergestellt werden kann.')}</p>`;
      return;
    }
    const token = ++this.historyToken || (this.historyToken = 1);
    actions.listVersions().then((versions) => {
      if (token !== this.historyToken) return;
      if (!versions.length) {
        list.innerHTML = `<h3>${t('Gespeicherte Versionen')}</h3><p class="muted">${t('Noch keine Versionen.')}</p>`;
        return;
      }
      const opts = (sel) => [`<option value="current" ${sel === 'current' ? 'selected' : ''}>${t('Aktueller Stand')}</option>`].concat(versions.map((v) => `<option value="${v.n}" ${String(v.n) === String(sel) ? 'selected' : ''}>#${v.n} ${esc(t(v.label))}</option>`)).join('');
      const cmp = this.compareState || { a: versions[0] ? String(versions[0].n) : 'current', b: 'current' };
      list.innerHTML = `<h3>${t('Gespeicherte Versionen')}</h3>
        <div class="box compare">
          <div class="compare-row"><label>${t('Vergleichen')} <select id="cmp-a">${opts(cmp.a)}</select></label><label>${t('mit')} <select id="cmp-b">${opts(cmp.b)}</select></label><button type="button" id="cmp-run" class="btn small">${t('Vergleichen')}</button></div>
          <div id="version-diff"></div>
        </div>` + versions.map((v) => `
        <div class="list-row" data-n="${v.n}">
          <div class="grow"><div class="title">${esc(t(v.label))} <span class="muted">#${v.n}</span></div>
            <div class="muted">${fmtDate(v.at)} · ${t('{roads} Strassen, {junctions} Kreuzungen, {roundabouts} Kreisel', { roads: v.stats.roads, junctions: v.stats.junctions, roundabouts: v.stats.roundabouts })}</div></div>
          <button type="button" class="btn small v-compare" title="${t('Mit dem aktuellen Stand vergleichen')}">${t('Vergleichen')}</button>
          <button type="button" class="btn small v-restore" ${actions.canEdit() ? '' : 'disabled'}>${t('Wiederherstellen')}</button>
        </div>`).join('');
      list.querySelectorAll('.v-restore').forEach((b) => {
        b.onclick = () => actions.restoreVersion(Number(b.closest('.list-row').dataset.n));
      });
      list.querySelectorAll('.v-compare').forEach((b) => {
        b.onclick = () => {
          this.compareState = { a: String(b.closest('.list-row').dataset.n), b: 'current' };
          this.$('cmp-a').value = this.compareState.a;
          this.$('cmp-b').value = 'current';
          this.runCompare();
        };
      });
      this.$('cmp-run').onclick = () => {
        this.compareState = { a: this.$('cmp-a').value, b: this.$('cmp-b').value };
        this.runCompare();
      };
      if (actions.diff()) this.renderDiff();
    });
  }

  async runCompare() {
    const { actions } = this.ctx;
    const el = this.$('version-diff');
    if (!el) return;
    el.innerHTML = `<p class="muted small">${t('Vergleiche…')}</p>`;
    try {
      await actions.compareVersions(this.compareState.a, this.compareState.b);
      this.renderDiff();
    } catch (e) {
      el.innerHTML = `<p class="muted small">${t('Vergleich fehlgeschlagen')}: ${esc(e.message)}</p>`;
    }
  }

  /** Ergebnis des Versionsvergleichs: Listen und Karten-Overlay. */
  renderDiff() {
    const { actions, tools } = this.ctx;
    const el = this.$('version-diff');
    const d = actions.diff();
    if (!el) return;
    if (!d) {
      el.innerHTML = '';
      return;
    }
    const r = d.result;
    const title = (n) => (n === 'current' ? t('aktueller Stand') : `${t('Version')} #${n}`);
    const item = (f, cls, extra = '') => `<li class="${cls}"><button type="button" class="linkish diff-row" data-id="${esc(f.id)}">${esc(featureTitle(f))}</button>${extra}</li>`;
    el.innerHTML = `
      <p class="small"><strong>${esc(title(d.a))}</strong> → <strong>${esc(title(d.b))}</strong>: ${r.empty ? t('keine Unterschiede.') : `${t('{a} hinzugefügt, {r} entfernt, {c} geändert', { a: r.counts.added, r: r.counts.removed, c: r.counts.changed })}${r.nameChanged ? `, ${t('Name geändert')}` : ''}.`}</p>
      ${r.layers.added.length || r.layers.removed.length || r.layers.renamed.length ? `<p class="muted small">${t('Ebenen')}: ${[...r.layers.added.map((l) => `„${esc(l.name)}“ ${t('neu')}`), ...r.layers.removed.map((l) => `„${esc(l.name)}“ ${t('entfernt')}`), ...r.layers.renamed.map((x) => `„${esc(x.from)}“ → „${esc(x.to)}“`)].join(', ')}</p>` : ''}
      ${r.empty ? '' : `<ul class="diff-list">
        ${r.added.map((f) => item(f, 'added', ` <span class="muted small">${t('neu')}</span>`)).join('')}
        ${r.changed.map((c) => item(c.after, 'changed', ` <span class="muted small">${esc(c.changes.join('; '))}</span>`)).join('')}
        ${r.removed.map((f) => item(f, 'removed', ` <span class="muted small">${t('entfernt')}</span>`)).join('')}
      </ul>
      <label class="check"><input type="checkbox" id="diff-show" ${actions.showDiff() ? 'checked' : ''}> ${t('Auf der Karte zeigen')} <span class="muted small">${t('(grün neu, orange geändert, rot gestrichelt entfernt)')}</span></label>`}
      <button type="button" id="diff-close" class="btn small">${t('Vergleich schliessen')}</button>`;
    el.querySelectorAll('.diff-row').forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.id;
        const removed = r.removed.find((f) => f.id === id);
        if (removed) actions.zoomToGeometry(removed);
        else {
          tools.setSelection({ featureId: id });
          actions.zoomToFeature(id);
        }
      };
    });
    const show = this.$('diff-show');
    if (show) show.onchange = (e) => actions.setShowDiff(e.target.checked);
    this.$('diff-close').onclick = () => {
      actions.clearDiff();
      this.compareState = null;
      el.innerHTML = '';
    };
  }

  // --- Status, Tooltip, Banner, Toasts, Modal ----------------------------------------

  setStatus(text) {
    this.$('status-hint').textContent = text ? t(text) : '';
  }

  setCoords(latlng, zoom) {
    this.$('status-coords').textContent = latlng ? `${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)} · Zoom ${zoom.toFixed(1)}` : `Zoom ${zoom.toFixed(1)}`;
  }

  setOsmStatus(text, kind = '') {
    const el = this.$('status-osm');
    el.textContent = t(text);
    el.className = kind;
  }

  // --- Fortschritt länger laufender Arbeiten (Statusleiste) ---------------------------------

  /**
   * Meldet eine laufende Arbeit: label, optional done/total (sonst unbestimmt). Mehrere Arbeiten
   * laufen parallel; die Leiste zeigt die zuletzt gemeldete und zählt die übrigen.
   */
  progress(id, { label = '', done = null, total = null } = {}) {
    if (!this.jobs) this.jobs = new Map();
    const prev = this.jobs.get(id);
    this.jobs.delete(id); // ans Ende: zuletzt gemeldete Arbeit steht vorne
    this.jobs.set(id, { label: label || (prev ? prev.label : ''), done, total });
    clearTimeout(this.progressDoneTimer);
    this.renderProgress();
  }

  /** Arbeit beendet; eine kurze Meldung bleibt ein paar Sekunden in der Statusleiste stehen. */
  progressDone(id, message = '', kind = 'ok') {
    if (!this.jobs) this.jobs = new Map();
    this.jobs.delete(id);
    this.renderProgress(message ? { text: message, kind } : null);
  }

  progressBusy(id = null) {
    if (!this.jobs) return false;
    return id ? this.jobs.has(id) : this.jobs.size > 0;
  }

  renderProgress(done = null) {
    const el = this.$('status-progress');
    if (!el) return;
    const label = el.querySelector('.progress-label');
    const bar = el.querySelector('.progress-bar i');
    const jobs = this.jobs ? Array.from(this.jobs.values()) : [];
    clearTimeout(this.progressDoneTimer);
    if (jobs.length) {
      const job = jobs[jobs.length - 1];
      const det = Number.isFinite(job.total) && job.total > 0;
      label.textContent = `${job.label}${det ? ` ${Math.min(job.done || 0, job.total)}/${job.total}` : ''}${jobs.length > 1 ? ` (+${jobs.length - 1})` : ''}`;
      bar.style.width = det ? `${Math.round((Math.min(job.done || 0, job.total) / job.total) * 100)}%` : '';
      el.className = `progress ${det ? '' : 'indeterminate'}`;
      el.hidden = false;
      return;
    }
    if (done && done.text) {
      label.textContent = done.text;
      bar.style.width = '';
      el.className = `progress done ${done.kind || 'ok'}`;
      el.hidden = false;
      this.progressDoneTimer = setTimeout(() => { if (!this.jobs || !this.jobs.size) el.hidden = true; }, 4000);
      return;
    }
    el.hidden = true;
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
    el.innerHTML = `<span>${esc(t(text))}</span>${actionLabel ? `<button type="button" class="btn small primary" id="banner-action">${esc(t(actionLabel))}</button>` : ''}<button type="button" class="icon-btn" id="banner-close" title="${t('Schliessen')}">${icon('close', { size: 14 })}</button>`;
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

  openShare({ viewUrl, editUrl, presentUrl = null, doc }) {
    const subject = encodeURIComponent(`${t('Planungsvorschlag')}: ${doc.name}`);
    const body = encodeURIComponent(t('Hallo\n\nHier ist mein Planungsvorschlag „{name}“, erstellt mit dem Stadtplaner:\n\n{url}\n\nDer Link öffnet den Entwurf direkt im Browser.\n', { name: doc.name, url: viewUrl }));
    this.openModal(`
      <h2>${t('Entwurf teilen')}</h2>
      <p>${t('Der <strong>Ansichtslink</strong> zeigt den Vorschlag; wer ihn öffnet, kann eine eigene Kopie weiterbearbeiten, dein Original bleibt unverändert.')}</p>
      <div class="link-row"><input type="text" id="share-url" readonly value="${esc(viewUrl)}"><button type="button" class="btn primary" data-copy="share-url">${t('Kopieren')}</button></div>
      <div class="qr-row">${safeQr(viewUrl)}<p class="muted small">${t('QR-Code zum Ansichtslink: an der Versammlung zeigen, die Leute öffnen den Vorschlag am Handy und können kommentieren. Der Code steht auch auf jedem PDF-Export.')}</p></div>
      ${presentUrl ? `
      <p>${t('<strong>Präsentationslink</strong> – nur Karte, Legende und Routenvergleich, ohne Werkzeuge. Für Sitzungen, Beamer und Leute, die nur schauen sollen.')}</p>
      <div class="link-row"><input type="text" id="share-present-url" readonly value="${esc(presentUrl)}"><button type="button" class="btn" data-copy="share-present-url">${t('Kopieren')}</button></div>` : ''}
      ${editUrl ? `
      <p>${t('<strong>Bearbeitungslink</strong> – nur an Personen geben, die den Entwurf direkt mitbearbeiten sollen. Wer ihn hat, kann alles ändern und löschen.')}</p>
      <div class="link-row"><input type="text" id="share-edit-url" readonly value="${esc(editUrl)}"><button type="button" class="btn" data-copy="share-edit-url">${t('Kopieren')}</button></div>` : ''}
      <div class="btn-row">
        <a class="btn" href="mailto:?subject=${subject}&body=${body}">${t('Per E-Mail senden')}</a>
        <button type="button" id="share-json" class="btn">${t('JSON herunterladen')}</button>
        <button type="button" id="share-geojson" class="btn">${t('GeoJSON herunterladen')}</button>
        <button type="button" id="share-export" class="btn">${t('Karte als PNG / PDF…')}</button>
        <button type="button" class="btn" data-close>${t('Schliessen')}</button>
      </div>`);
    document.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        const input = this.$(b.dataset.copy);
        try {
          await navigator.clipboard.writeText(input.value);
          this.toast(t('Link kopiert.'), 'ok');
        } catch {
          input.select();
          this.toast(t('Link markiert – mit Ctrl+C kopieren.'));
        }
      };
    });
    this.$('share-json').onclick = () => this.ctx.actions.exportJson();
    this.$('share-geojson').onclick = () => this.ctx.actions.exportGeoJson();
    this.$('share-export').onclick = () => this.openExport();
  }

  // --- Export-Dialog ---------------------------------------------------------------

  openExport() {
    const hasFeatures = this.ctx.store.doc.features.length > 0;
    this.openModal(`
      <h2>${t('Karte exportieren')}</h2>
      <p class="muted small">${t('Die Karte wird für den Export neu in der gewählten Auflösung gezeichnet, mit Titel, Legende, Massstab, Routenvergleich und OSM-Attribution.')}</p>
      <div class="export-grid">
        <label class="field">${t('Ausschnitt')}<select id="export-mode">
          <option value="view">${t('Aktuelle Ansicht (Mitte und Zoom)')}</option>
          <option value="all" ${hasFeatures ? '' : 'disabled'}>${t('Ganzer Entwurf')}</option>
          <option value="scale">${t('Fester Massstab um die Kartenmitte (Planrahmen)')}</option>
        </select></label>
        <label class="field">${t('Massstab')}<select id="export-scale">${SCALES.map((sc) => `<option value="${sc}" ${sc === 2000 ? 'selected' : ''}>1:${sc}</option>`).join('')}</select></label>
        <label class="field">${t('Papier')}<select id="export-paper">${Object.entries(PAPER).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
        <label class="field">${t('Ausrichtung')}<select id="export-orientation"><option value="landscape">${t('Querformat')}</option><option value="portrait">${t('Hochformat')}</option></select></label>
        <label class="field">${t('Auflösung')}<select id="export-dpi">${DPI.map((d) => `<option value="${d}" ${d === 150 ? 'selected' : ''}>${d} dpi${d === 96 ? ` (${t('Bildschirm')})` : d === 300 ? ` (${t('Druck')})` : ''}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" id="export-report"> ${t('Bericht anhängen (nur PDF): Massnahmenliste, Routenvergleich, Kommentare und Link auf weiteren Seiten')}</label>
      <label class="check"><input type="checkbox" id="export-confidence" ${this.ctx.settings.reportConfidence !== false ? 'checked' : ''}> ${t('Zuversicht im Bericht ausweisen (Stufe und Gründe je Ergebnis)')}</label>
      <p class="muted small" id="export-status"></p>
      <div class="btn-row">
        <button type="button" id="export-png" class="btn primary">${t('PNG herunterladen')}</button>
        <button type="button" id="export-pdf" class="btn primary">${t('PDF herunterladen')}</button>
        <button type="button" id="export-dxf" class="btn" title="${t('CAD-Übergabe: Strassen, Flächen, Punkte und Kreisel in Landeskoordinaten LV95, eine DXF-Ebene je Entwurfsebene')}">${t('DXF (LV95)')}</button>
        <button type="button" class="btn" data-close>${t('Schliessen')}</button>
      </div>`);
    const opts = () => ({
      mode: this.$('export-mode').value,
      paper: this.$('export-paper').value,
      orientation: this.$('export-orientation').value,
      dpi: Number(this.$('export-dpi').value),
      scale: Number(this.$('export-scale').value),
      report: this.$('export-report').checked,
      confidence: this.$('export-confidence').checked,
    });
    this.$('export-confidence').onchange = (e) => this.ctx.actions.updateSettings({ reportConfidence: e.target.checked });
    const syncScale = () => { this.$('export-scale').disabled = this.$('export-mode').value !== 'scale'; };
    this.$('export-mode').onchange = syncScale;
    syncScale();
    const run = async (format) => {
      const status = this.$('export-status');
      const buttons = [this.$('export-png'), this.$('export-pdf'), this.$('export-dxf')];
      buttons.forEach((b) => { b.disabled = true; });
      status.textContent = t('Kacheln werden geladen und die Karte gezeichnet…');
      try {
        await this.ctx.actions.runExport({ format, ...opts() });
        status.textContent = t('Export erstellt.');
      } catch (e) {
        status.textContent = `${t('Export fehlgeschlagen')}: ${e.message}`;
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    };
    this.$('export-png').onclick = () => run('png');
    this.$('export-pdf').onclick = () => run('pdf');
    this.$('export-dxf').onclick = () => run('dxf');
  }

  // --- Kommentare ------------------------------------------------------------------

  refreshComments() {
    const { actions, tools, settings } = this.ctx;
    const el = this.$('comments-panel');
    if (!el) return;
    const comments = actions.comments();
    const draft = tools.commentDraft;
    const saved = actions.isSaved();
    const active = actions.activeCommentId();
    const replyTo = actions.replyTo();
    const fmt = (c) => `${esc(c.author)} · ${fmtDate(c.at)}`;
    const tops = comments.filter((c) => !c.parentId);
    const repliesOf = (id) => comments.filter((c) => c.parentId === id);

    // Benachrichtigungen
    const ps = actions.pushStatus();
    let pushText;
    let toggle = '';
    if (!saved) pushText = t('Benachrichtigungen gibt es, sobald der Entwurf gespeichert ist.');
    else if (!ps.serverEnabled) pushText = t('Push-Benachrichtigungen sind auf diesem Server nicht aktiviert.');
    else if (!ps.supported) pushText = t('Dieser Browser unterstützt keine Push-Benachrichtigungen (HTTPS und Service Worker nötig).');
    else if (ps.permission === 'denied') pushText = t('Benachrichtigungen sind in den Browser-Einstellungen für diese Seite blockiert.');
    else {
      const what = actions.canEdit() ? t('bei jedem neuen Kommentar oder jeder Antwort') : t('bei Antworten auf meine Kommentare');
      toggle = `<label class="check"><input type="checkbox" id="push-toggle" ${ps.subscribed ? 'checked' : ''}> ${t('Push-Benachrichtigung')} ${what}</label>`;
      pushText = ps.subscribed ? t('Aktiv auf diesem Gerät. Nachrichten kommen auch, wenn die Seite geschlossen ist.') : t('Aus. Nach dem Einschalten fragt der Browser einmal um Erlaubnis.');
    }
    const notify = `
      <div class="box notify">
        <h3>${t('Benachrichtigungen')}</h3>
        ${toggle}
        <p class="muted small">${esc(pushText)} ${saved ? t('Solange der Entwurf offen ist, prüft die Seite ausserdem regelmässig auf neue Kommentare.') : ''}</p>
      </div>`;

    let form = '';
    if (draft) {
      form = `
        <div class="box comment-form">
          <h3>${t('Neuer Kommentar')}</h3>
          <label class="field">${t('Name')}<input type="text" id="comment-author" value="${esc(settings.author)}" placeholder="${t('Dein Name')}" maxlength="80"></label>
          <label class="field">${t('Kommentar')}<textarea id="comment-text" rows="3" placeholder="${t('Was soll hier anders sein?')}" maxlength="2000"></textarea></label>
          <div class="btn-row">
            <button type="button" id="comment-send" class="btn small primary">${t('Senden')}</button>
            <button type="button" id="comment-cancel" class="btn small">${t('Abbrechen')}</button>
          </div>
        </div>`;
    }
    const replyForm = (top) => `
      <div class="reply-form" data-parent="${top.id}">
        <input type="text" class="reply-author" value="${esc(settings.author)}" placeholder="${t('Dein Name')}" maxlength="80">
        <textarea class="reply-text" rows="2" placeholder="${t('Antwort…')}" maxlength="2000"></textarea>
        <div class="btn-row">
          <button type="button" class="btn small primary reply-send">${t('Antworten')}</button>
          <button type="button" class="btn small reply-cancel">${t('Abbrechen')}</button>
        </div>
      </div>`;
    const renderReply = (r) => `
      <div class="comment-row reply" data-id="${r.id}">
        <div class="grow">
          <div class="muted small">${fmt(r)}</div>
          <div class="c-text">${esc(r.text)}</div>
        </div>
        ${actions.canManageComment(r) ? `<button type="button" class="icon-btn c-delete" title="${t('Antwort löschen')}">✕</button>` : ''}
      </div>`;
    const list = tops.length
      ? tops.map((c, i) => {
        const replies = repliesOf(c.id);
        return `
        <div class="thread${c.resolved ? ' resolved' : ''}${c.id === active ? ' active' : ''}" data-id="${c.id}">
          <div class="comment-row" data-id="${c.id}">
            <button type="button" class="c-focus" title="${t('Auf der Karte zeigen')}"><span class="c-index">${i + 1}</span></button>
            <div class="grow">
              <div class="muted small">${fmt(c)}${c.resolved ? ` · ${t('erledigt')}` : ''}</div>
              <div class="c-text">${esc(c.text)}</div>
              <div class="thread-actions">
                <button type="button" class="link c-reply" ${saved ? '' : 'disabled'}>${t('Antworten')}${replies.length ? ` (${replies.length})` : ''}</button>
              </div>
            </div>
            ${actions.canManageComment(c) ? `<button type="button" class="icon-btn c-resolve" title="${c.resolved ? t('Wieder öffnen') : t('Als erledigt markieren')}">${c.resolved ? '↺' : '✓'}</button><button type="button" class="icon-btn c-delete" title="${t('Kommentar samt Antworten löschen')}">✕</button>` : ''}
          </div>
          ${replies.map(renderReply).join('')}
          ${replyTo === c.id ? replyForm(c) : ''}
        </div>`;
      }).join('')
      : `<p class="muted">${saved ? t('Noch keine Kommentare. Mit „Kommentar setzen“ einen Punkt auf der Karte anklicken.') : t('Kommentare gibt es, sobald der Entwurf gespeichert ist und einen Link hat.')}</p>`;
    el.innerHTML = `
      <p class="muted small">${t('Wer den Ansichtslink hat, kann Kommentare an eine Stelle der Karte heften und auf Kommentare antworten. Der Besitzer des Entwurfs kann Kommentare erledigen oder löschen, Verfasser ihre eigenen.')}</p>
      <div class="btn-row">
        <button type="button" id="comment-add" class="btn small ${tools.tool === 'comment' ? 'primary' : ''}" ${saved ? '' : 'disabled'}>${t('Kommentar setzen')}</button>
        <button type="button" id="comment-refresh" class="btn small" ${saved ? '' : 'disabled'}>${t('Aktualisieren')}</button>
        <label class="check small"><input type="checkbox" id="comment-show" ${settings.showComments ? 'checked' : ''}> ${t('Auf der Karte zeigen')}</label>
      </div>
      ${form}
      ${notify}
      <div id="comment-list">${list}</div>`;
    this.$('comment-add').onclick = () => tools.setTool('comment');
    this.$('comment-refresh').onclick = () => actions.refreshComments();
    this.$('comment-show').onchange = (e) => actions.updateSettings({ showComments: e.target.checked });
    const pushToggle = this.$('push-toggle');
    if (pushToggle) pushToggle.onchange = (e) => (e.target.checked ? actions.enablePush() : actions.disablePush());
    if (draft) {
      this.$('comment-send').onclick = () => actions.submitComment({ author: this.$('comment-author').value, text: this.$('comment-text').value });
      this.$('comment-cancel').onclick = () => actions.cancelComment();
      this.$('comment-text').onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.$('comment-send').click();
      };
      setTimeout(() => this.$('comment-text') && this.$('comment-text').focus(), 50);
    }
    el.querySelectorAll('.thread').forEach((thread) => {
      const id = thread.dataset.id;
      thread.querySelector('.c-focus').onclick = () => actions.focusComment(id);
      thread.querySelector('.c-reply').onclick = () => actions.startReply(id);
      const resolve = thread.querySelector('.comment-row:not(.reply) .c-resolve');
      if (resolve) resolve.onclick = () => actions.resolveComment(id, !comments.find((c) => c.id === id).resolved);
      thread.querySelectorAll('.comment-row').forEach((row) => {
        const del = row.querySelector('.c-delete');
        if (del) del.onclick = () => actions.deleteComment(row.dataset.id);
      });
      const rf = thread.querySelector('.reply-form');
      if (rf) {
        rf.querySelector('.reply-send').onclick = () => actions.submitComment({ author: rf.querySelector('.reply-author').value, text: rf.querySelector('.reply-text').value, parentId: id });
        rf.querySelector('.reply-cancel').onclick = () => actions.cancelReply();
        rf.querySelector('.reply-text').onkeydown = (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) rf.querySelector('.reply-send').click();
        };
        setTimeout(() => rf.querySelector('.reply-text').focus(), 50);
      }
    });
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
    const geometry = this.ctx.settings.speedModel === 'geometry';
    const band = (r) => (geometry && r && r.sd > 0 ? `<div class="muted small">${formatDuration(r.p15)} – ${formatDuration(r.p85)}</div>` : '');
    let body = '';
    if (!q) {
      body = `<p class="muted">${tools.routeDraft ? t('Start gesetzt – jetzt das Ziel auf der Karte anklicken.') : t('Start und Ziel auf der Karte anklicken (Werkzeug „Route“, Taste T).')}</p>`;
    } else if (!routes) {
      body = `<p class="muted">${t('Berechne…')}</p>`;
    } else {
      body = `
        <table class="route-table">
          <thead><tr><th></th><th><span class="dot" style="background:#1b6ac9"></span>${t('Heute')}</th><th><span class="dot" style="background:#2a9d3f"></span>${t('Neu')}</th><th>${t('Differenz')}</th></tr></thead>
          <tbody>
            <tr><td>${t('Distanz')}</td><td>${cur ? fmtKm(cur.dist) : '–'}</td><td>${neu ? fmtKm(neu.dist) : '–'}</td><td>${diff(cur && cur.dist, neu && neu.dist, fmtKm)}</td></tr>
            <tr><td>${t('Fahrzeit')}${geometry ? ` <span class="muted small">${t('(typisch, P15–P85)')}</span>` : ''}</td><td>${cur ? formatDuration(cur.time) + band(cur) : '–'}</td><td>${neu ? formatDuration(neu.time) + band(neu) : '–'}</td><td>${diff(cur && cur.time, neu && neu.time, formatDuration)}</td></tr>
            ${unsafeShare(cur) !== null || unsafeShare(neu) !== null ? `<tr><td>${t('Unsicher')} <span class="muted small">${t('(schnelle Strassen ohne Velostreifen/Trottoir)')}</span></td><td>${unsafeShare(cur) === null ? '–' : `${unsafeShare(cur)} %`}</td><td>${unsafeShare(neu) === null ? '–' : `${unsafeShare(neu)} %`}</td><td>${unsafeShare(cur) !== null && unsafeShare(neu) !== null ? `${unsafeShare(neu) - unsafeShare(cur) > 0 ? '+' : ''}${unsafeShare(neu) - unsafeShare(cur)} %` : '–'}</td></tr>` : ''}
          </tbody>
        </table>
        ${confidenceBlock(actions.confidence('route'))}
        ${routes.current && routes.current.error ? `<p class="muted small">${t('Heute')}: ${esc(t(routes.current.error))}</p>` : ''}
        ${routes.proposed && routes.proposed.error ? `<p class="muted small">${t('Neu')}: ${esc(t(routes.proposed.error))}</p>` : ''}`;
    }
    const race = actions.race();
    el.innerHTML = `
      <p class="muted small">${t('Schnellste Fahrroute im heutigen Strassennetz (OpenStreetMap) verglichen mit dem Netz inklusive deiner Änderungen: neue Strassen kommen dazu, Rückbau fällt weg, übernommene Strassen zählen mit ihren Änderungen, Zonen deckeln das Tempo. Fahrzeit aus Tempolimits (OSM maxspeed oder Standard je Strassentyp); gezeichnete Ampeln +20 s, Stop +8 s, Vortritt +3 s, Fussgängerstreifen +2 s.')} ${t('Velo (17 km/h, Wege und Velostreifen) und zu Fuss (4.8 km/h, auch Treppen und Fusswege, ohne Einbahnen) mit Anteil unsicherer Strecke: schnelle Strassen ohne Velostreifen bzw. Trottoir.')}</p>
      ${body}
      <div id="race-box" class="race-box">${raceBlock(race, actions, { canStart: !!(q && routes) })}</div>
      <label class="check"><input type="checkbox" id="route-model" ${geometry ? 'checked' : ''}> ${t('Fahrzeit aus der Strassenführung (Kurvenradien, Steigung aus Höhenprofil, Wartezeiten mit Streuung)')}</label>
      <div class="btn-row">
        <label class="field inline">${t('Verkehrsmittel')}<select id="route-vehicle">${VEHICLES.map((v) => `<option value="${v.id}" ${actions.routeVehicle() === v.id ? 'selected' : ''}>${esc(t(v.label))}</option>`).join('')}</select></label>
        <button type="button" id="route-tool" class="btn small ${tools.tool === 'route' ? 'primary' : ''}">${t('Punkte setzen')}</button>
        <button type="button" id="route-swap" class="btn small" ${q ? '' : 'disabled'}>A ↔ B</button>
        <button type="button" id="route-clear" class="btn small" ${q || tools.routeDraft ? '' : 'disabled'}>${t('Löschen')}</button>
        <button type="button" id="route-load" class="btn small">${t('Netz für Ansicht laden')}</button>
      </div>
      <p class="muted small" id="route-net">${esc(t(net))}</p>
      ${actions.phaseView() ? `<p class="muted small"><strong>${t('Ansicht bis Etappe {name}: Fahrzeiten und Erreichbarkeit gelten für diesen Zustand.', { name: phaseLabel(store.doc.phases.find((ph) => ph.id === actions.phaseView()) || {}, store.doc.phases.findIndex((ph) => ph.id === actions.phaseView())) })}</strong></p>` : ''}
      ${pairsSection(store.doc, actions, tools, geometry)}
      ${busSection(store.doc, actions, tools)}
      ${isochroneSection(store.doc, actions, tools)}`;
    this.wirePairs();
    this.wireBus();
    this.wireIsochrone();
    this.wireRace(this.$('race-box'));
    this.$('route-tool').onclick = () => tools.setTool('route');
    this.$('route-vehicle').onchange = (e) => actions.setRouteVehicle(e.target.value);
    this.$('route-model').onchange = (e) => actions.updateSettings({ speedModel: e.target.checked ? 'geometry' : 'limit' });
    this.$('route-swap').onclick = () => actions.swapRoute();
    this.$('route-clear').onclick = () => actions.clearRoute();
    this.$('route-load').onclick = () => actions.loadRouteNetwork();
  }
}
