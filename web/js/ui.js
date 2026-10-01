// Seitenleiste, Kopfzeile, Statuszeile, Dialoge. Reine DOM-Arbeit; die Logik
// steckt in app.js (actions) und den Modulen.

import { JUNCTION_KINDS, LEVELS, ROAD_KINDS, SECTION_LIMITS, STATUSES, ZONE_KINDS, defaultSection, docStats, featureLabel, getFeature, junctionKind, junctionTurns, roadKind, roadSpeed, roadWidthMeters, sectionSummary, sectionWidth, segmentSpeed, splitRoadAtNode, validProfile } from './model.js';
import { DPI, PAPER, SCALES } from './export.js';
import { qrSvg } from './qr.js';
import { featureTitle } from './diff.js';
import { COST_ITEMS, costValue, formatChf } from './costs.js';
import { parcelLabel, validParcels } from './parcels.js';
import { ISO_COLORS, ISO_DIFF_COLORS } from './draw.js';
import { ISOCHRONE_PRESETS } from './model.js';
import { haversine, pathLength } from './geometry.js';
import { segmentGrades } from './speedmodel.js';
import { TOOLS } from './tools.js';
import { formatDuration } from './routing.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
};
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const options = (list, value) => list.map((o) => `<option value="${o.id}"${o.id === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

function safeQr(url) {
  try {
    return `<span class="qr">${qrSvg(url, { size: 128 })}</span>`;
  } catch {
    return '';
  }
}

/** Weitere Routenpaare mit Ergebnistabelle und Summen. */
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
    const state = !p.from || !p.to ? '<span class="muted small">Start und Ziel setzen</span>' : '';
    return `<tr class="${capturing === p.id ? 'active' : ''}">
      <td>${i + 1}</td>
      <td><input type="text" class="pair-name" data-id="${esc(p.id)}" value="${esc(p.name)}" ${dis}> ${state}</td>
      <td class="num">${cur ? `${fmtKm(cur.dist)}<br>${formatDuration(cur.time)}` : '–'}</td>
      <td class="num">${neu ? `${fmtKm(neu.dist)}<br>${formatDuration(neu.time)}` : '–'}</td>
      <td class="num">${delta}</td>
      <td class="pair-actions"><button type="button" class="icon-btn pair-set" data-id="${esc(p.id)}" title="Start und Ziel auf der Karte setzen" ${dis}>◎</button><button type="button" class="icon-btn pair-swap" data-id="${esc(p.id)}" title="A ↔ B" ${dis || !p.from || !p.to ? 'disabled' : ''}>⇄</button><button type="button" class="icon-btn pair-del" data-id="${esc(p.id)}" title="Löschen" ${dis}>✕</button></td>
    </tr>`;
  }).join('');
  const total = count ? `<tr class="total"><td colspan="4">Summe über ${count} Paar${count === 1 ? '' : 'e'} · Ø ${formatDuration(Math.abs(sumDelta / count))} je Fahrt</td><td class="num"><strong>${sumDelta > 0 ? '+' : sumDelta < 0 ? '−' : '±'}${formatDuration(Math.abs(sumDelta))}</strong></td><td></td></tr>` : '';
  return `
    <h4>Weitere Routenpaare</h4>
    <p class="muted small">Feste Verbindungen wie Schule, Bahnhof oder Nachbardorf: heute gegen neu${geometry ? ' (typische Zeit)' : ''}, dazu die Summe der Zeitgewinne. Nummerierte Marker auf der Karte.</p>
    ${pairs.length ? `<table class="route-table pairs"><thead><tr><th>#</th><th>Name</th><th class="num">Heute</th><th class="num">Neu</th><th class="num">Δ</th><th></th></tr></thead><tbody>${rows}${total}</tbody></table>` : ''}
    <div class="btn-row"><button type="button" id="pair-add" class="btn small" ${dis}>+ Paar hinzufügen</button>${capturing ? '<span class="muted small">Start und Ziel auf der Karte anklicken (Esc bricht ab).</span>' : ''}</div>`;
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
  if (res && res.error) stats = `<p class="muted small">${esc(res.error)}</p>`;
  else if (res && res.mode === 'diff') {
    stats = `<table class="route-table"><tbody>
      <tr><td><span class="dot" style="background:${ISO_DIFF_COLORS.gained}"></span>Neu erreichbar (nur mit Entwurf)</td><td class="num">${res.stats.gainedKm} km</td></tr>
      <tr><td><span class="dot" style="background:${ISO_DIFF_COLORS.lost}"></span>Nicht mehr erreichbar (nur heute)</td><td class="num">${res.stats.lostKm} km</td></tr>
      <tr><td><span class="dot" style="background:#777"></span>In beiden Fällen</td><td class="num">${res.stats.bothKm} km</td></tr></tbody></table>
      <p class="muted small">Strassennetz, das innerhalb von ${iso.minutes[iso.minutes.length - 1]} Minuten ab dem Ursprung erreichbar ist.</p>`;
  } else if (res) {
    stats = `<table class="route-table"><thead><tr><th>bis</th><th class="num">erreichbares Netz</th></tr></thead><tbody>
      ${res.minutes.map((m, i) => `<tr><td><span class="dot" style="background:${ISO_COLORS[Math.min(i, ISO_COLORS.length - 1)]}"></span>${m} min</td><td class="num">${res.stats.km[i]} km</td></tr>`).join('')}</tbody></table>`;
  }
  return `
    <h4>Erreichbarkeit (Isochronen)</h4>
    <p class="muted small">Welches Strassennetz ist ab einem Punkt in 5, 10 oder 15 Minuten erreichbar – heute, mit dem Entwurf oder als Differenz (grün: nur neu, rot: nur heute).</p>
    <div class="btn-row">
      <button type="button" id="iso-set" class="btn small ${capturing ? 'primary' : ''}" ${dis}>${iso ? 'Ursprung verschieben' : 'Ursprung setzen'}</button>
      ${iso ? `
      <select id="iso-minutes" ${dis}>${presets.map((p) => `<option value="${p}" ${p === presetValue ? 'selected' : ''}>${p.split(',').join(' / ')} min</option>`).join('')}</select>
      <select id="iso-mode" ${dis}>${[['proposed', 'Neu (mit Entwurf)'], ['current', 'Heute'], ['diff', 'Differenz']].map(([v, l]) => `<option value="${v}" ${iso.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" id="iso-clear" class="btn small" ${dis}>Löschen</button>` : ''}
    </div>
    ${capturing ? '<p class="muted small">Ursprung auf der Karte anklicken (Esc bricht ab).</p>' : ''}
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
         <p class="muted small">${valid.items.length} Parzelle${valid.items.length === 1 ? '' : 'n'}, ${total.toFixed(0)} m Strasse auf Privat- oder Gemeindeland (Liegenschaften der amtlichen Vermessung).</p>`
      : '<p class="muted small">Keine Parzellen berührt (oder ausserhalb der Schweiz).</p>';
  } else if (stale) {
    body = '<p class="muted small">Die Strasse wurde seit der Abfrage verändert; die Parzellenliste ist veraltet.</p>';
  } else {
    body = '<p class="muted small">Ermittelt über die amtliche Vermessung (geo.admin), welche Liegenschaften die Strasse berührt und wie viele Meter darauf liegen. Nur Schweiz.</p>';
  }
  return `
    <details class="box" ${valid ? 'open' : ''}>
      <summary>Betroffene Parzellen${valid ? ` <span class="muted">(${valid.items.length})</span>` : stale ? ' <span class="muted">(veraltet)</span>' : ''}</summary>
      ${body}
      <div class="btn-row">
        <button type="button" id="parcels-load" class="btn small" ${dis}>${valid || stale ? 'Neu ermitteln' : 'Betroffene Parzellen ermitteln'}</button>
        ${road.parcels ? `<button type="button" id="parcels-clear" class="btn small" ${dis}>Entfernen</button>` : ''}
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
        <summary>Querschnitt <span class="muted">(Standard)</span></summary>
        <p class="muted small">Standard für ${esc(roadKind(road).label)}: ${esc(sectionSummary(defaultSection(road.kind)))}. Ein eigener Querschnitt legt Fahrstreifen, Velostreifen, Trottoirs und Parkstreifen mit Breiten fest; ab Zoom 17 werden sie als Bänder gezeichnet.</p>
        <button type="button" id="sec-create" class="btn small" ${dis}>Querschnitt festlegen</button>
      </details>`;
  }
  const num = (key, label, step = 0.25) => `<label class="field">${label}<input type="number" class="sec-num" data-key="${key}" min="${SECTION_LIMITS[key][0]}" max="${SECTION_LIMITS[key][1]}" step="${step}" value="${s[key]}" ${dis}></label>`;
  const side = (name, label) => `
    <div class="sec-row">
      <span>${label}</span>
      <label class="check"><input type="checkbox" class="sec-flag" data-key="${name}Left" ${s[`${name}Left`] ? 'checked' : ''} ${dis}> links</label>
      <label class="check"><input type="checkbox" class="sec-flag" data-key="${name}Right" ${s[`${name}Right`] ? 'checked' : ''} ${dis}> rechts</label>
      <input type="number" class="sec-num" data-key="${name}Width" min="${SECTION_LIMITS[`${name}Width`][0]}" max="${SECTION_LIMITS[`${name}Width`][1]}" step="0.25" value="${s[`${name}Width`]}" title="Breite in m" ${dis}> m
    </div>`;
  return `
    <details class="box" open>
      <summary>Querschnitt <span class="muted">(${sectionWidth(s)} m gesamt)</span></summary>
      <div class="sec-grid">
        ${num('lanes', 'Fahrstreifen', 1)}
        ${num('laneWidth', 'Breite je Streifen (m)')}
        ${num('median', 'Mittelstreifen (m)')}
        ${num('shoulder', 'Pannenstreifen (m)')}
      </div>
      ${side('bike', 'Velostreifen')}
      ${side('walk', 'Trottoir')}
      ${side('park', 'Parkstreifen')}
      <p class="muted small">${esc(sectionSummary(s))}. Links/rechts in Zeichenrichtung; ein Mittelstreifen teilt die Fahrstreifen in zwei Fahrbahnen.</p>
      <button type="button" id="sec-remove" class="btn small" ${dis}>Querschnitt entfernen</button>
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
      <div class="btn-row"><button type="button" id="prop-profile-load" class="btn small">Höhenprofil laden</button>
      <span class="muted small">${stale ? 'Profil veraltet (Geometrie geändert).' : 'swisstopo-Höhenmodell, nur Schweiz.'}</span></div>
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
    <div class="muted small">↑ ${Math.round(up)} m · ↓ ${Math.round(down)} m · max. Steigung ${maxGrade.toFixed(1)} %</div>
    <div class="btn-row"><button type="button" id="prop-profile-load" class="btn small">Neu laden</button><button type="button" id="prop-profile-clear" class="btn small">Profil entfernen</button></div>
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
    this.refreshComments();
    this.refreshDrawActions();
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
      <h3>Kostenschätzung</h3>
      <p class="muted small">Grobe Richtwerte für Schweizer Verhältnisse: Strassen pro Kilometer (mit der Breite skaliert), Brücken und Tunnel als Zuschlag pro Meter, Knoten und Flächen pauschal. Bestehende Strassen werden nicht gerechnet; ein Umbau wird als „Neu“ markiert. Die Summe zählt nur sichtbare Ebenen, Varianten also per Ein-/Ausblenden.</p>
      <table class="route-table">
        <thead><tr><th>Ebene</th><th class="num">Kosten</th></tr></thead>
        <tbody>
          ${est.layers.map((l) => `<tr class="${l.visible ? '' : 'muted'}"><td>${esc(l.name)}${l.visible ? '' : ' (ausgeblendet)'}</td><td class="num">${formatChf(l.amount)}</td></tr>`).join('')}
          <tr class="total"><td>Total (sichtbare Ebenen)</td><td class="num"><strong>${formatChf(est.total)}</strong></td></tr>
        </tbody>
      </table>
      <details class="box">
        <summary>Positionen (${est.rows.length})</summary>
        ${est.rows.length ? `<ul class="cost-list">${est.rows.map((r) => `<li><button type="button" class="linkish cost-row" data-id="${esc(r.featureId)}">${esc(r.label)}</button> <span class="muted small">${esc(r.detail)}</span><span class="num">${formatChf(r.amount)}</span></li>`).join('')}</ul>` : '<p class="muted small">Keine Elemente.</p>'}
      </details>
      <details class="box">
        <summary>Einheitskosten anpassen${overridden ? ` <span class="muted">(${overridden} geändert)</span>` : ''}</summary>
        ${groups.map((g) => `<div class="cost-group"><div class="muted small">${esc(g.name)}</div>${g.items.map((it) => `
          <label class="cost-item"><span>${esc(it.label)}</span><input type="number" class="cost-input" data-key="${it.key}" min="0" step="${it.value >= 1e6 ? 100000 : it.value >= 10000 ? 10000 : 10}" value="${costValue(doc, it.key)}" ${dis}><span class="muted small">${esc(it.unit)}</span></label>`).join('')}</div>`).join('')}
        <button type="button" id="cost-reset" class="btn small" ${dis || !overridden ? 'disabled' : ''}>Alle auf Standard</button>
      </details>
      <h3>Normen-Check</h3>
      <p class="muted small">Richtwerte nach VSS: Kurvenradius zum Tempo, Steigung aus dem Höhenprofil, Kreiselgrösse, Fahrstreifenbreite, Tempo in Zonen, nicht angeschlossene Enden. ${checks.length ? `${warns} Warnung${warns === 1 ? '' : 'en'}, ${checks.length - warns} Hinweis${checks.length - warns === 1 ? '' : 'e'}.` : 'Keine Auffälligkeiten.'}</p>
      ${checks.length ? `<ul class="check-list">${checks.map((c) => `<li class="${c.severity}"><button type="button" class="linkish check-row" data-id="${esc(c.id)}">${esc(c.text)}</button></li>`).join('')}</ul>` : ''}
      <h3>Betroffene Gebäude</h3>
      <p class="muted small">Gebäude aus OpenStreetMap im Umkreis der heutigen Route, der neuen Route und aller neuen Strassen (sichtbare Ebenen). Lärm- und Sicherheitsargument in einer Zahl.</p>
      <div class="btn-row">
        <label class="field inline">Umkreis<select id="exp-radius">${[25, 50, 100].map((r) => `<option value="${r}" ${settings.exposureRadius === r ? 'selected' : ''}>${r} m</option>`).join('')}</select></label>
        <button type="button" id="exp-load" class="btn small">Gebäude für die Ansicht laden</button>
      </div>
      <p class="muted small" id="exp-status">${esc(actions.buildingsStatus())}</p>
      ${exp ? `
      <table class="route-table">
        <thead><tr><th></th><th class="num">Gebäude ≤ ${exp.radius} m</th></tr></thead>
        <tbody>
          ${exp.hasRoutes ? `
          <tr><td><span class="dot" style="background:#1b6ac9"></span>Route heute</td><td class="num">${exp.current.count}</td></tr>
          <tr><td><span class="dot" style="background:#2a9d3f"></span>Route neu</td><td class="num">${exp.proposed.count}</td></tr>
          <tr class="total"><td>Differenz</td><td class="num"><strong>${exp.delta > 0 ? '+' : ''}${exp.delta}</strong></td></tr>` : '<tr><td colspan="2" class="muted">Für heute/neu Start und Ziel im Routen-Tab setzen.</td></tr>'}
          <tr><td>Entlang neuer Strassen</td><td class="num">${exp.roads.count}</td></tr>
        </tbody>
      </table>
      <label class="check"><input type="checkbox" id="exp-show" ${actions.showExposure() ? 'checked' : ''}> Auf der Karte hervorheben <span class="muted small">(rot: neu betroffen, grün: entlastet, orange: beides)</span></label>` : ''}`;
    el.querySelectorAll('details').forEach((d, i) => { if (openState[i]) d.open = true; });
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
    this.$('da-finish').textContent = tools.tool === 'zone' ? 'Fläche schliessen' : 'Strasse fertig';
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
    ROAD_KINDS.filter((k) => roadKinds.has(k.id)).forEach((k) => legend.push(`<li><span class="swatch ground"></span> ${esc(k.label)}${k.speed ? ` · ${k.speed} km/h` : ''}</li>`));
    if (visible.some((f) => f.type === 'road' && f.segments.some((sg) => sg.level === 'bridge'))) legend.push('<li><span class="swatch bridge"></span> Brücke</li>');
    if (visible.some((f) => f.type === 'road' && f.segments.some((sg) => sg.level === 'tunnel'))) legend.push('<li><span class="swatch tunnel"></span> Tunnel</li>');
    if (visible.some((f) => f.status === 'remove')) legend.push('<li><span class="swatch remove"></span> Rückbau</li>');
    ZONE_KINDS.filter((k) => zoneKinds.has(k.id)).forEach((k) => legend.push(`<li><span class="swatch zone" style="${k.color ? `background:${k.color}33;border-color:${k.color}` : ''}"></span> ${esc(k.label)}</li>`));
    const layers = doc.layers.map((l) => `<li><span class="dot" style="background:${esc(l.color)}"></span>${esc(l.name)}${l.visible === false ? ' <span class="muted">(ausgeblendet)</span>' : ''}</li>`).join('');
    const routes = actions.routes();
    let route = '';
    if (doc.route && routes) {
      const cur = routes.current && !routes.current.error ? routes.current : null;
      const neu = routes.proposed && !routes.proposed.error ? routes.proposed : null;
      const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
      const geometry = settings.speedModel === 'geometry';
      const band = (r) => (geometry && r && r.sd > 0 ? `<div class="muted small">${formatDuration(r.p15)} – ${formatDuration(r.p85)}</div>` : '');
      route = `
        <h3>Route: heute vs. neu</h3>
        <table class="route-table">
          <thead><tr><th></th><th><span class="dot" style="background:#1b6ac9"></span>Heute</th><th><span class="dot" style="background:#2a9d3f"></span>Neu</th></tr></thead>
          <tbody>
            <tr><td>Distanz</td><td>${cur ? fmtKm(cur.dist) : '–'}</td><td>${neu ? fmtKm(neu.dist) : '–'}</td></tr>
            <tr><td>Fahrzeit</td><td>${cur ? formatDuration(cur.time) + band(cur) : '–'}</td><td>${neu ? formatDuration(neu.time) + band(neu) : '–'}</td></tr>
          </tbody>
        </table>`;
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
      if (rows) route += `<h3>Weitere Verbindungen</h3><table class="route-table"><thead><tr><th></th><th>Heute</th><th>Neu</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const stats = [counts.road && `${counts.road} Strasse${counts.road > 1 ? 'n' : ''}`, counts.junction && `${counts.junction} Punkt${counts.junction > 1 ? 'e' : ''}`, counts.roundabout && `${counts.roundabout} Kreisel`, counts.zone && `${counts.zone} Fläche${counts.zone > 1 ? 'n' : ''}`].filter(Boolean).join(' · ');
    panel.innerHTML = `
      <h2>${esc(doc.name)}</h2>
      <p class="muted small">${esc(stats || 'Noch keine Elemente')}</p>
      ${legend.length ? `<ul class="legend">${legend.join('')}</ul>` : ''}
      ${doc.layers.length > 1 ? `<details><summary>Ebenen (${doc.layers.length})</summary><ul class="legend">${layers}</ul></details>` : ''}
      ${route}
      <div class="btn-row">
        <button type="button" id="present-edit" class="btn small">Zum Editor</button>
        <button type="button" id="present-export" class="btn small">PNG / PDF</button>
      </div>`;
    this.$('present-edit').onclick = () => actions.exitPresent();
    this.$('present-export').onclick = () => this.openExport();
  }

  /** Speicherkonflikt: jemand anderes hat inzwischen gespeichert. Liefert 'overwrite' | 'reload' | 'cancel'. */
  openConflict({ updatedAt, versionCount }) {
    return new Promise((resolve) => {
      this.openModal(`
        <h2>Entwurf wurde inzwischen geändert</h2>
        <p>Jemand anderes hat diesen Entwurf ${updatedAt ? `am ${esc(fmtDate(updatedAt))} ` : ''}gespeichert${versionCount ? ` (Version ${versionCount})` : ''}. Welche Fassung soll gelten?</p>
        <div class="btn-row">
          <button type="button" id="conflict-overwrite" class="btn primary">Meine Fassung speichern</button>
          <button type="button" id="conflict-reload" class="btn">Serverstand übernehmen</button>
          <button type="button" id="conflict-cancel" class="btn" data-close>Abbrechen</button>
        </div>
        <p class="muted small">„Meine Fassung speichern“ überschreibt die fremde Änderung; sie bleibt im Verlauf als eigene Version erhalten. „Serverstand übernehmen“ ersetzt deine Fassung, die du mit Rückgängig zurückholen kannst.</p>`);
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
    const zoneSel = this.$('default-zone-kind');
    zoneSel.innerHTML = options(ZONE_KINDS, actions.defaultZoneKind());
    zoneSel.onchange = () => actions.setDefaultZoneKind(zoneSel.value);

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
    const sources = actions.tileSources();
    const bases = sources.filter((t) => !t.overlay);
    const overlays = sources.filter((t) => t.overlay);
    const mapBox = this.$('map-settings');
    mapBox.innerHTML = `
      <label class="field">Grundkarte<select id="set-basemap">${bases.map((t) => `<option value="${esc(t.id)}"${t.id === settings.basemap ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
      ${overlays.map((t) => `<label class="check"><input type="checkbox" class="set-overlay" data-id="${esc(t.id)}" ${settings.overlays.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}${t.minZoom ? ` <span class="muted small">(ab Zoom ${t.minZoom})</span>` : ''}</label>`).join('')}
      ${bases.length <= 1 ? '<p class="muted small">Weitere Kartenquellen lassen sich auf dem Server über TILE_SOURCES einrichten.</p>' : ''}`;
    this.$('set-basemap').onchange = (e) => actions.updateSettings({ basemap: e.target.value });
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
        <label class="field">Breite (m)<input type="number" id="prop-width" min="1" max="60" step="0.5" value="${f.section ? sectionWidth(f.section) : (f.width ?? '')}" placeholder="Standard ${roadWidthMeters({ ...f, width: null, section: null })} m" ${f.section ? 'disabled title="Ergibt sich aus dem Querschnitt"' : dis}></label>
        ${roadKind(f).motorOnly ? '<p class="muted small">Autobahn/Autostrasse: keine Fussgänger und Velos; zwei getrennte Fahrbahnen ab Zoom 15.</p>' : ''}
        ${sectionBlock(f, editable)}
        <div class="btn-row">
          <button type="button" id="prop-smooth" class="btn small" ${dis || f.nodes.length < 3 ? 'disabled' : ''} title="Knicke durch eine Spline ersetzen (fügt Zwischenpunkte ein)">Glätten</button>
          <button type="button" id="prop-simplify" class="btn small" ${dis || f.nodes.length < 3 ? 'disabled' : ''} title="Überflüssige Punkte entfernen (Toleranz 1 m)">Vereinfachen</button>
          <span class="muted small">${f.nodes.length} Punkte</span>
        </div>
        ${profileBlock(f)}
        ${parcelsBlock(f, editable)}
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
          <label class="field">Tempolimit dieses Abschnitts (km/h)<input type="number" id="seg-maxspeed" min="5" max="200" step="5" value="${seg.maxspeed ?? ''}" placeholder="wie Strasse (${segmentSpeed({ ...f, segments: [{ level: 'ground', maxspeed: null }] }, 0) || '–'})" ${dis}></label>
          <div class="btn-row">
            <button type="button" id="seg-split-before" class="btn small" ${dis || segIndex < 1 ? 'disabled' : ''} title="Strasse am Anfang dieses Abschnitts in zwei Strassen teilen">Vor Abschnitt teilen</button>
            <button type="button" id="seg-split-after" class="btn small" ${dis || segIndex > f.segments.length - 2 ? 'disabled' : ''} title="Strasse am Ende dieses Abschnitts in zwei Strassen teilen">Nach Abschnitt teilen</button>
          </div>
        </div>`;
    } else if (f.type === 'junction') {
      const turns = junctionTurns(f);
      const turnsOn = junctionKind(f).turns;
      specific = `<label class="field">Art<select id="prop-jkind" ${dis}>${options(JUNCTION_KINDS, f.kind)}</select></label>
        ${f.kind === 'interchange' ? '<p class="muted small">Kreuzungsfrei: keine Wartezeit und kein Abbiegezuschlag im Routen-Rechner.</p>' : ''}
        ${turnsOn ? `
        <div class="field">Abbiegen erlaubt <span class="muted small">(bezogen auf die Fahrtrichtung, Routen-Rechner)</span>
          <div class="check-row">
            ${[['left', '↰ links'], ['straight', '↑ geradeaus'], ['right', '↱ rechts'], ['uturn', '↶ wenden']].map(([k, l]) => `<label class="check"><input type="checkbox" class="turn" data-turn="${k}" ${turns[k] ? 'checked' : ''} ${dis}> ${l}</label>`).join('')}
          </div>
          ${f.turns ? `<button type="button" id="turns-reset" class="btn small" ${dis}>Standard</button>` : ''}
        </div>` : ''}`;
    } else if (f.type === 'roundabout') {
      specific = `<label class="field">Radius (m)<input type="number" id="prop-radius" min="4" max="200" step="0.5" value="${f.radius}" ${dis}></label>`;
    } else if (f.type === 'zone') {
      const k = ZONE_KINDS.find((z) => z.id === f.kind) || ZONE_KINDS[4];
      specific = `<label class="field">Art der Fläche<select id="prop-zkind" ${dis}>${options(ZONE_KINDS, f.kind)}</select></label>
        <p class="muted small">${k.speed === 0 ? 'Für Autos gesperrt (Routen-Rechner).' : k.speed ? `Tempolimit ${k.speed} km/h für alle Strassen in der Fläche (Routen-Rechner).` : 'Ohne Wirkung auf den Routen-Rechner.'} ${f.nodes.length} Eckpunkte.</p>`;
    }
    box.innerHTML = `
      <h3>${{ road: 'Strasse', junction: 'Kreuzung / Punkt', roundabout: 'Kreisel', zone: 'Zone / Fläche' }[f.type]} <span class="muted">${esc(featureLabel(f))}</span></h3>
      <label class="field">Name<input type="text" id="prop-name" value="${esc(f.name)}" placeholder="z. B. Hauptstrasse neu" ${dis}></label>
      <label class="field">Ebene<select id="prop-layer" ${dis}>${options(layerOpts, f.layerId)}</select></label>
      ${specific}
      <label class="field">Notiz<textarea id="prop-note" rows="2" placeholder="Begründung, Hinweise…" ${dis}>${esc(f.note)}</textarea></label>
      <div class="btn-row">
        <button type="button" id="prop-zoom" class="btn small">Hinzoomen</button>
        <button type="button" id="prop-delete" class="btn small danger" ${dis}>Löschen (Entf)</button>
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
    } else if (f.type === 'zone') {
      this.$('prop-zkind').onchange = (e) => patch('Art der Fläche ändern', (x) => { x.kind = e.target.value; });
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
      <p class="muted">${s.roads} Strassen (${fmtLen(s.lengthMeters)}), ${s.junctions} Kreuzungen, ${s.roundabouts} Kreisel${s.zones ? `, ${s.zones} Flächen` : ''}${s.bridges ? `, ${s.bridges} Brückenabschnitte` : ''}${s.tunnels ? `, ${s.tunnels} Tunnelabschnitte` : ''}</p>
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
        <button type="button" id="d-import" class="btn small" title="Stadtplaner-JSON ersetzt den Entwurf; GeoJSON, GPX und KML kommen als neue Ebene dazu">Importieren (JSON, GeoJSON, GPX, KML)</button>
      </div>
      <div class="btn-row">
        <button type="button" id="d-export-map" class="btn small">Karte als PNG / PDF exportieren…</button>
      </div>`;
    this.$('d-new').onclick = () => actions.newDraft();
    if (this.$('d-save')) this.$('d-save').onclick = () => actions.saveDraft();
    if (this.$('d-own')) this.$('d-own').onclick = () => actions.makeOwnCopy();
    this.$('d-copy').onclick = () => actions.saveCopy();
    this.$('d-share').onclick = () => actions.share();
    this.$('d-export').onclick = () => actions.exportJson();
    this.$('d-geojson').onclick = () => actions.exportGeoJson();
    this.$('d-import').onclick = () => this.$('import-file').click();
    this.$('d-export-map').onclick = () => this.openExport();

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
      const opts = (sel) => [`<option value="current" ${sel === 'current' ? 'selected' : ''}>Aktueller Stand</option>`].concat(versions.map((v) => `<option value="${v.n}" ${String(v.n) === String(sel) ? 'selected' : ''}>#${v.n} ${esc(v.label)}</option>`)).join('');
      const cmp = this.compareState || { a: versions[0] ? String(versions[0].n) : 'current', b: 'current' };
      list.innerHTML = `<h3>Gespeicherte Versionen</h3>
        <div class="box compare">
          <div class="compare-row"><label>Vergleichen <select id="cmp-a">${opts(cmp.a)}</select></label><label>mit <select id="cmp-b">${opts(cmp.b)}</select></label><button type="button" id="cmp-run" class="btn small">Vergleichen</button></div>
          <div id="version-diff"></div>
        </div>` + versions.map((v) => `
        <div class="list-row" data-n="${v.n}">
          <div class="grow"><div class="title">${esc(v.label)} <span class="muted">#${v.n}</span></div>
            <div class="muted">${fmtDate(v.at)} · ${v.stats.roads} Strassen, ${v.stats.junctions} Kreuzungen, ${v.stats.roundabouts} Kreisel</div></div>
          <button type="button" class="btn small v-compare" title="Mit dem aktuellen Stand vergleichen">Vergleichen</button>
          <button type="button" class="btn small v-restore" ${actions.canEdit() ? '' : 'disabled'}>Wiederherstellen</button>
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
    el.innerHTML = '<p class="muted small">Vergleiche…</p>';
    try {
      await actions.compareVersions(this.compareState.a, this.compareState.b);
      this.renderDiff();
    } catch (e) {
      el.innerHTML = `<p class="muted small">Vergleich fehlgeschlagen: ${esc(e.message)}</p>`;
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
    const title = (n) => (n === 'current' ? 'aktueller Stand' : `Version #${n}`);
    const item = (f, cls, extra = '') => `<li class="${cls}"><button type="button" class="linkish diff-row" data-id="${esc(f.id)}">${esc(featureTitle(f))}</button>${extra}</li>`;
    el.innerHTML = `
      <p class="small"><strong>${esc(title(d.a))}</strong> → <strong>${esc(title(d.b))}</strong>: ${r.empty ? 'keine Unterschiede.' : `${r.counts.added} hinzugefügt, ${r.counts.removed} entfernt, ${r.counts.changed} geändert${r.nameChanged ? ', Name geändert' : ''}.`}</p>
      ${r.layers.added.length || r.layers.removed.length || r.layers.renamed.length ? `<p class="muted small">Ebenen: ${[...r.layers.added.map((l) => `„${esc(l.name)}“ neu`), ...r.layers.removed.map((l) => `„${esc(l.name)}“ entfernt`), ...r.layers.renamed.map((x) => `„${esc(x.from)}“ → „${esc(x.to)}“`)].join(', ')}</p>` : ''}
      ${r.empty ? '' : `<ul class="diff-list">
        ${r.added.map((f) => item(f, 'added', ' <span class="muted small">neu</span>')).join('')}
        ${r.changed.map((c) => item(c.after, 'changed', ` <span class="muted small">${esc(c.changes.join('; '))}</span>`)).join('')}
        ${r.removed.map((f) => item(f, 'removed', ' <span class="muted small">entfernt</span>')).join('')}
      </ul>
      <label class="check"><input type="checkbox" id="diff-show" ${actions.showDiff() ? 'checked' : ''}> Auf der Karte zeigen <span class="muted small">(grün neu, orange geändert, rot gestrichelt entfernt)</span></label>`}
      <button type="button" id="diff-close" class="btn small">Vergleich schliessen</button>`;
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

  openShare({ viewUrl, editUrl, presentUrl = null, doc }) {
    const subject = encodeURIComponent(`Planungsvorschlag: ${doc.name}`);
    const body = encodeURIComponent(`Hallo\n\nHier ist mein Planungsvorschlag „${doc.name}“, erstellt mit dem Stadtplaner:\n\n${viewUrl}\n\nDer Link öffnet den Entwurf direkt im Browser.\n`);
    this.openModal(`
      <h2>Entwurf teilen</h2>
      <p>Der <strong>Ansichtslink</strong> zeigt den Vorschlag; wer ihn öffnet, kann eine eigene Kopie weiterbearbeiten, dein Original bleibt unverändert.</p>
      <div class="link-row"><input type="text" id="share-url" readonly value="${esc(viewUrl)}"><button type="button" class="btn primary" data-copy="share-url">Kopieren</button></div>
      <div class="qr-row">${safeQr(viewUrl)}<p class="muted small">QR-Code zum Ansichtslink: an der Versammlung zeigen, die Leute öffnen den Vorschlag am Handy und können kommentieren. Der Code steht auch auf jedem PDF-Export.</p></div>
      ${presentUrl ? `
      <p><strong>Präsentationslink</strong> – nur Karte, Legende und Routenvergleich, ohne Werkzeuge. Für Sitzungen, Beamer und Leute, die nur schauen sollen.</p>
      <div class="link-row"><input type="text" id="share-present-url" readonly value="${esc(presentUrl)}"><button type="button" class="btn" data-copy="share-present-url">Kopieren</button></div>` : ''}
      ${editUrl ? `
      <p><strong>Bearbeitungslink</strong> – nur an Personen geben, die den Entwurf direkt mitbearbeiten sollen. Wer ihn hat, kann alles ändern und löschen.</p>
      <div class="link-row"><input type="text" id="share-edit-url" readonly value="${esc(editUrl)}"><button type="button" class="btn" data-copy="share-edit-url">Kopieren</button></div>` : ''}
      <div class="btn-row">
        <a class="btn" href="mailto:?subject=${subject}&body=${body}">Per E-Mail senden</a>
        <button type="button" id="share-json" class="btn">JSON herunterladen</button>
        <button type="button" id="share-geojson" class="btn">GeoJSON herunterladen</button>
        <button type="button" id="share-export" class="btn">Karte als PNG / PDF…</button>
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
    this.$('share-export').onclick = () => this.openExport();
  }

  // --- Export-Dialog ---------------------------------------------------------------

  openExport() {
    const hasFeatures = this.ctx.store.doc.features.length > 0;
    this.openModal(`
      <h2>Karte exportieren</h2>
      <p class="muted small">Die Karte wird für den Export neu in der gewählten Auflösung gezeichnet, mit Titel, Legende, Massstab, Routenvergleich und OSM-Attribution.</p>
      <div class="export-grid">
        <label class="field">Ausschnitt<select id="export-mode">
          <option value="view">Aktuelle Ansicht (Mitte und Zoom)</option>
          <option value="all" ${hasFeatures ? '' : 'disabled'}>Ganzer Entwurf</option>
          <option value="scale">Fester Massstab um die Kartenmitte (Planrahmen)</option>
        </select></label>
        <label class="field">Massstab<select id="export-scale">${SCALES.map((sc) => `<option value="${sc}" ${sc === 2000 ? 'selected' : ''}>1:${sc}</option>`).join('')}</select></label>
        <label class="field">Papier<select id="export-paper">${Object.entries(PAPER).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
        <label class="field">Ausrichtung<select id="export-orientation"><option value="landscape">Querformat</option><option value="portrait">Hochformat</option></select></label>
        <label class="field">Auflösung<select id="export-dpi">${DPI.map((d) => `<option value="${d}" ${d === 150 ? 'selected' : ''}>${d} dpi${d === 96 ? ' (Bildschirm)' : d === 300 ? ' (Druck)' : ''}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" id="export-report"> Bericht anhängen (nur PDF): Massnahmenliste, Routenvergleich, Kommentare und Link auf weiteren Seiten</label>
      <p class="muted small" id="export-status"></p>
      <div class="btn-row">
        <button type="button" id="export-png" class="btn primary">PNG herunterladen</button>
        <button type="button" id="export-pdf" class="btn primary">PDF herunterladen</button>
        <button type="button" class="btn" data-close>Schliessen</button>
      </div>`);
    const opts = () => ({
      mode: this.$('export-mode').value,
      paper: this.$('export-paper').value,
      orientation: this.$('export-orientation').value,
      dpi: Number(this.$('export-dpi').value),
      scale: Number(this.$('export-scale').value),
      report: this.$('export-report').checked,
    });
    const syncScale = () => { this.$('export-scale').disabled = this.$('export-mode').value !== 'scale'; };
    this.$('export-mode').onchange = syncScale;
    syncScale();
    const run = async (format) => {
      const status = this.$('export-status');
      const buttons = [this.$('export-png'), this.$('export-pdf')];
      buttons.forEach((b) => { b.disabled = true; });
      status.textContent = 'Kacheln werden geladen und die Karte gezeichnet…';
      try {
        await this.ctx.actions.runExport({ format, ...opts() });
        status.textContent = 'Export erstellt.';
      } catch (e) {
        status.textContent = `Export fehlgeschlagen: ${e.message}`;
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    };
    this.$('export-png').onclick = () => run('png');
    this.$('export-pdf').onclick = () => run('pdf');
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
    if (!saved) pushText = 'Benachrichtigungen gibt es, sobald der Entwurf gespeichert ist.';
    else if (!ps.serverEnabled) pushText = 'Push-Benachrichtigungen sind auf diesem Server nicht aktiviert.';
    else if (!ps.supported) pushText = 'Dieser Browser unterstützt keine Push-Benachrichtigungen (HTTPS und Service Worker nötig).';
    else if (ps.permission === 'denied') pushText = 'Benachrichtigungen sind in den Browser-Einstellungen für diese Seite blockiert.';
    else {
      const what = actions.canEdit() ? 'bei jedem neuen Kommentar oder jeder Antwort' : 'bei Antworten auf meine Kommentare';
      toggle = `<label class="check"><input type="checkbox" id="push-toggle" ${ps.subscribed ? 'checked' : ''}> Push-Benachrichtigung ${what}</label>`;
      pushText = ps.subscribed ? 'Aktiv auf diesem Gerät. Nachrichten kommen auch, wenn die Seite geschlossen ist.' : 'Aus. Nach dem Einschalten fragt der Browser einmal um Erlaubnis.';
    }
    const notify = `
      <div class="box notify">
        <h3>Benachrichtigungen</h3>
        ${toggle}
        <p class="muted small">${esc(pushText)} ${saved ? 'Solange der Entwurf offen ist, prüft die Seite ausserdem regelmässig auf neue Kommentare.' : ''}</p>
      </div>`;

    let form = '';
    if (draft) {
      form = `
        <div class="box comment-form">
          <h3>Neuer Kommentar</h3>
          <label class="field">Name<input type="text" id="comment-author" value="${esc(settings.author)}" placeholder="Dein Name" maxlength="80"></label>
          <label class="field">Kommentar<textarea id="comment-text" rows="3" placeholder="Was soll hier anders sein?" maxlength="2000"></textarea></label>
          <div class="btn-row">
            <button type="button" id="comment-send" class="btn small primary">Senden</button>
            <button type="button" id="comment-cancel" class="btn small">Abbrechen</button>
          </div>
        </div>`;
    }
    const replyForm = (top) => `
      <div class="reply-form" data-parent="${top.id}">
        <input type="text" class="reply-author" value="${esc(settings.author)}" placeholder="Dein Name" maxlength="80">
        <textarea class="reply-text" rows="2" placeholder="Antwort…" maxlength="2000"></textarea>
        <div class="btn-row">
          <button type="button" class="btn small primary reply-send">Antworten</button>
          <button type="button" class="btn small reply-cancel">Abbrechen</button>
        </div>
      </div>`;
    const renderReply = (r) => `
      <div class="comment-row reply" data-id="${r.id}">
        <div class="grow">
          <div class="muted small">${fmt(r)}</div>
          <div class="c-text">${esc(r.text)}</div>
        </div>
        ${actions.canManageComment(r) ? `<button type="button" class="icon-btn c-delete" title="Antwort löschen">✕</button>` : ''}
      </div>`;
    const list = tops.length
      ? tops.map((c, i) => {
        const replies = repliesOf(c.id);
        return `
        <div class="thread${c.resolved ? ' resolved' : ''}${c.id === active ? ' active' : ''}" data-id="${c.id}">
          <div class="comment-row" data-id="${c.id}">
            <button type="button" class="c-focus" title="Auf der Karte zeigen"><span class="c-index">${i + 1}</span></button>
            <div class="grow">
              <div class="muted small">${fmt(c)}${c.resolved ? ' · erledigt' : ''}</div>
              <div class="c-text">${esc(c.text)}</div>
              <div class="thread-actions">
                <button type="button" class="link c-reply" ${saved ? '' : 'disabled'}>Antworten${replies.length ? ` (${replies.length})` : ''}</button>
              </div>
            </div>
            ${actions.canManageComment(c) ? `<button type="button" class="icon-btn c-resolve" title="${c.resolved ? 'Wieder öffnen' : 'Als erledigt markieren'}">${c.resolved ? '↺' : '✓'}</button><button type="button" class="icon-btn c-delete" title="Kommentar samt Antworten löschen">✕</button>` : ''}
          </div>
          ${replies.map(renderReply).join('')}
          ${replyTo === c.id ? replyForm(c) : ''}
        </div>`;
      }).join('')
      : `<p class="muted">${saved ? 'Noch keine Kommentare. Mit „Kommentar setzen“ einen Punkt auf der Karte anklicken.' : 'Kommentare gibt es, sobald der Entwurf gespeichert ist und einen Link hat.'}</p>`;
    el.innerHTML = `
      <p class="muted small">Wer den Ansichtslink hat, kann Kommentare an eine Stelle der Karte heften und auf Kommentare antworten. Der Besitzer des Entwurfs kann Kommentare erledigen oder löschen, Verfasser ihre eigenen.</p>
      <div class="btn-row">
        <button type="button" id="comment-add" class="btn small ${tools.tool === 'comment' ? 'primary' : ''}" ${saved ? '' : 'disabled'}>Kommentar setzen</button>
        <button type="button" id="comment-refresh" class="btn small" ${saved ? '' : 'disabled'}>Aktualisieren</button>
        <label class="check small"><input type="checkbox" id="comment-show" ${settings.showComments ? 'checked' : ''}> Auf der Karte zeigen</label>
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
      body = `<p class="muted">${tools.routeDraft ? 'Start gesetzt – jetzt das Ziel auf der Karte anklicken.' : 'Start und Ziel auf der Karte anklicken (Werkzeug „Route“, Taste T).'}</p>`;
    } else if (!routes) {
      body = '<p class="muted">Berechne…</p>';
    } else {
      body = `
        <table class="route-table">
          <thead><tr><th></th><th><span class="dot" style="background:#1b6ac9"></span>Heute</th><th><span class="dot" style="background:#2a9d3f"></span>Neu</th><th>Differenz</th></tr></thead>
          <tbody>
            <tr><td>Distanz</td><td>${cur ? fmtKm(cur.dist) : '–'}</td><td>${neu ? fmtKm(neu.dist) : '–'}</td><td>${diff(cur && cur.dist, neu && neu.dist, fmtKm)}</td></tr>
            <tr><td>Fahrzeit${geometry ? ' <span class="muted small">(typisch, P15–P85)</span>' : ''}</td><td>${cur ? formatDuration(cur.time) + band(cur) : '–'}</td><td>${neu ? formatDuration(neu.time) + band(neu) : '–'}</td><td>${diff(cur && cur.time, neu && neu.time, formatDuration)}</td></tr>
          </tbody>
        </table>
        ${routes.current && routes.current.error ? `<p class="muted small">Heute: ${esc(routes.current.error)}</p>` : ''}
        ${routes.proposed && routes.proposed.error ? `<p class="muted small">Neu: ${esc(routes.proposed.error)}</p>` : ''}`;
    }
    el.innerHTML = `
      <p class="muted small">Schnellste Fahrroute im heutigen Strassennetz (OpenStreetMap) verglichen mit dem Netz inklusive deiner Änderungen: neue Strassen kommen dazu, Rückbau fällt weg, übernommene Strassen zählen mit ihren Änderungen, Zonen deckeln das Tempo. Fahrzeit aus Tempolimits (OSM maxspeed oder Standard je Strassentyp); gezeichnete Ampeln +20 s, Stop +8 s, Vortritt +3 s, Fussgängerstreifen +2 s.</p>
      ${body}
      <label class="check"><input type="checkbox" id="route-model" ${geometry ? 'checked' : ''}> Fahrzeit aus der Strassenführung (Kurvenradien, Steigung aus Höhenprofil, Wartezeiten mit Streuung)</label>
      <div class="btn-row">
        <button type="button" id="route-tool" class="btn small ${tools.tool === 'route' ? 'primary' : ''}">Punkte setzen</button>
        <button type="button" id="route-swap" class="btn small" ${q ? '' : 'disabled'}>A ↔ B</button>
        <button type="button" id="route-clear" class="btn small" ${q || tools.routeDraft ? '' : 'disabled'}>Löschen</button>
        <button type="button" id="route-load" class="btn small">Netz für Ansicht laden</button>
      </div>
      <p class="muted small" id="route-net">${esc(net)}</p>
      ${pairsSection(store.doc, actions, tools, geometry)}
      ${isochroneSection(store.doc, actions, tools)}`;
    this.wirePairs();
    this.wireIsochrone();
    this.$('route-tool').onclick = () => tools.setTool('route');
    this.$('route-model').onchange = (e) => actions.updateSettings({ speedModel: e.target.checked ? 'geometry' : 'limit' });
    this.$('route-swap').onclick = () => actions.swapRoute();
    this.$('route-clear').onclick = () => actions.clearRoute();
    this.$('route-load').onclick = () => actions.loadRouteNetwork();
  }
}
