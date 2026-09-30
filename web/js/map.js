// Slippy-Map auf einem Canvas, ohne Kartenbibliothek: Kacheln laden und
// zeichnen, Verschieben, Zoomen (Rad, Doppelklick, Pinch, Tasten), Ereignisse
// mit Karten-Koordinaten für die Werkzeuge, Overlay-Zeichenfunktion.

import { EARTH_RADIUS, project, unitsPerPixel, unproject } from './geometry.js';

const TILE = 256;
const HALF = Math.PI * EARTH_RADIUS; // halbe Weltbreite in Mercator-Metern
const MAX_TILES = 700;
const D2R = Math.PI / 180;

export class SlippyMap {
  constructor(container, opts = {}) {
    this.container = container;
    this.tileUrl = opts.tileUrl || '/tiles/{z}/{x}/{y}.png';
    this.minZoom = opts.minZoom ?? 2;
    this.maxZoom = opts.maxZoom ?? 20;
    this.maxNativeZoom = opts.maxNativeZoom ?? 19;
    this.center = project(opts.center || [46.8, 8.23]);
    this.zoom = this.clampZoom(opts.zoom ?? 8);
    this.listeners = new Map();
    this.overlay = null;
    this.dragEnabled = true;
    this.tiles = new Map();
    this.tileSeq = 0;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.lastClick = null;
    this.anim = null;
    this.moveEndTimer = null;
    this.dirty = false;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    container.classList.add('smap');
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'smap-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.buildControls(opts.attribution || '');
    this.bindEvents();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(container);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
  }

  // --- Ereignisse ------------------------------------------------------------

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }

  emit(name, ev) {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of set) fn(ev);
  }

  // --- Koordinaten -----------------------------------------------------------

  clampZoom(z) {
    return Math.max(this.minZoom, Math.min(this.maxZoom, z));
  }

  toPoint(m) {
    const upp = unitsPerPixel(this.zoom);
    return { x: this.width / 2 + (m.x - this.center.x) / upp, y: this.height / 2 - (m.y - this.center.y) / upp };
  }

  fromPoint(p) {
    const upp = unitsPerPixel(this.zoom);
    return { x: this.center.x + (p.x - this.width / 2) * upp, y: this.center.y - (p.y - this.height / 2) * upp };
  }

  /** [lat, lng] -> Container-Pixel {x, y}. */
  project(latlng) {
    return this.toPoint(project(latlng));
  }

  /** Container-Pixel {x, y} -> [lat, lng]. */
  unproject(p) {
    return unproject(this.fromPoint(p));
  }

  getCenter() {
    return unproject(this.center);
  }

  getZoom() {
    return this.zoom;
  }

  getSize() {
    return { x: this.width, y: this.height };
  }

  getBounds() {
    const sw = this.unproject({ x: 0, y: this.height });
    const ne = this.unproject({ x: this.width, y: 0 });
    return { south: sw[0], west: sw[1], north: ne[0], east: ne[1] };
  }

  /** Echte Meter pro Bildschirm-Pixel in der Kartenmitte. */
  metersPerPixel() {
    return unitsPerPixel(this.zoom) * Math.cos(this.getCenter()[0] * D2R);
  }

  normalize() {
    this.center.y = Math.max(-HALF, Math.min(HALF, this.center.y));
    if (this.center.x > HALF || this.center.x < -HALF) {
      this.center.x = ((this.center.x + HALF) % (2 * HALF) + 2 * HALF) % (2 * HALF) - HALF;
    }
  }

  // --- Ansicht steuern -------------------------------------------------------

  setView(latlng, zoom = this.zoom) {
    this.stopAnim();
    this.center = project(latlng);
    this.zoom = this.clampZoom(zoom);
    this.normalize();
    this.requestRender();
    this.emit('move');
    this.scheduleMoveEnd(0);
  }

  /** Verschiebt die Ansicht um dx/dy Pixel (positiv = Karte wandert nach rechts/unten). */
  panBy(dx, dy) {
    const upp = unitsPerPixel(this.zoom);
    this.center.x -= dx * upp;
    this.center.y += dy * upp;
    this.normalize();
    this.requestRender();
    this.emit('move');
    this.scheduleMoveEnd(150);
  }

  setZoomAround(point, zoom) {
    const before = this.fromPoint(point);
    this.zoom = this.clampZoom(zoom);
    const after = this.fromPoint(point);
    this.center.x += before.x - after.x;
    this.center.y += before.y - after.y;
    this.normalize();
    this.requestRender();
    this.emit('move');
    this.emit('zoom');
    this.scheduleMoveEnd(150);
  }

  zoomIn(delta = 1) {
    this.animateTo(this.getCenter(), this.zoom + delta, 250);
  }

  flyTo(latlng, zoom = this.zoom, duration = 600) {
    this.animateTo(latlng, zoom, duration);
  }

  animateTo(latlng, zoom, duration) {
    this.stopAnim();
    const from = { x: this.center.x, y: this.center.y, z: this.zoom };
    const target = project(latlng);
    const to = { x: target.x, y: target.y, z: this.clampZoom(zoom) };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      this.center = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      this.zoom = from.z + (to.z - from.z) * k;
      this.normalize();
      this.render();
      this.emit('move');
      if (t < 1) {
        this.anim = requestAnimationFrame(step);
      } else {
        this.anim = null;
        this.emit('zoom');
        this.scheduleMoveEnd(0);
      }
    };
    this.anim = requestAnimationFrame(step);
  }

  stopAnim() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = null;
  }

  /** bounds = { south, west, north, east } */
  fitBounds(b, { padding = 40, maxZoom = this.maxZoom } = {}) {
    const sw = project([b.south, b.west]);
    const ne = project([b.north, b.east]);
    const w = Math.max(1e-9, ne.x - sw.x);
    const h = Math.max(1e-9, ne.y - sw.y);
    const availW = Math.max(50, this.width - 2 * padding);
    const availH = Math.max(50, this.height - 2 * padding);
    const upp = Math.max(w / availW, h / availH);
    const zoom = Math.log2((2 * Math.PI * EARTH_RADIUS) / (TILE * upp));
    this.setView(unproject({ x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 }), Math.min(maxZoom, Math.floor(zoom * 100) / 100));
  }

  scheduleMoveEnd(ms) {
    clearTimeout(this.moveEndTimer);
    this.moveEndTimer = setTimeout(() => this.emit('moveend'), ms);
  }

  setDragEnabled(enabled) {
    this.dragEnabled = enabled;
  }

  setCursor(cursor) {
    this.container.style.cursor = cursor || '';
  }

  setOverlay(fn) {
    this.overlay = fn;
    this.requestRender();
  }

  // --- Zeichnen --------------------------------------------------------------

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.requestRender();
  }

  invalidateSize() {
    this.resize();
  }

  requestRender() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#e8ecf0';
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawTiles(ctx);
    if (this.overlay) {
      ctx.save();
      try {
        this.overlay(ctx, this);
      } finally {
        ctx.restore();
      }
    }
    this.updateScale();
    this.emit('render');
  }

  drawTiles(ctx) {
    const z = Math.max(0, Math.min(this.maxNativeZoom, Math.round(this.zoom)));
    const scale = Math.pow(2, this.zoom - z);
    const n = 1 << z;
    const worldPx = TILE * n;
    const cx = ((this.center.x + HALF) / (2 * HALF)) * worldPx;
    const cy = ((HALF - this.center.y) / (2 * HALF)) * worldPx;
    const tileSize = TILE * scale;
    const left = cx - this.width / 2 / scale;
    const right = cx + this.width / 2 / scale;
    const top = cy - this.height / 2 / scale;
    const bottom = cy + this.height / 2 / scale;
    const tx0 = Math.floor(left / TILE);
    const tx1 = Math.floor(right / TILE);
    const ty0 = Math.max(0, Math.floor(top / TILE));
    const ty1 = Math.min(n - 1, Math.floor(bottom / TILE));
    const visible = new Set();
    ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const sx = this.width / 2 + (tx * TILE - cx) * scale;
        const sy = this.height / 2 + (ty * TILE - cy) * scale;
        const wx = ((tx % n) + n) % n;
        const key = `${z}/${wx}/${ty}`;
        visible.add(key);
        const t = this.getTile(z, wx, ty, key);
        const dx = Math.round(sx);
        const dy = Math.round(sy);
        const dw = Math.round(sx + tileSize) - dx;
        const dh = Math.round(sy + tileSize) - dy;
        if (t.ok) {
          ctx.drawImage(t.img, dx, dy, dw, dh);
        } else {
          this.drawFallback(ctx, z, wx, ty, dx, dy, dw, dh);
        }
      }
    }
    this.pruneTiles(visible);
  }

  drawFallback(ctx, z, x, y, dx, dy, dw, dh) {
    for (let d = 1; d <= 5 && z - d >= 0; d++) {
      const f = 1 << d;
      const px = Math.floor(x / f);
      const py = Math.floor(y / f);
      const t = this.tiles.get(`${z - d}/${px}/${py}`);
      if (t && t.ok) {
        const sub = TILE / f;
        ctx.drawImage(t.img, (x - px * f) * sub, (y - py * f) * sub, sub, sub, dx, dy, dw, dh);
        return;
      }
    }
    ctx.fillStyle = '#e3e7eb';
    ctx.fillRect(dx, dy, dw, dh);
  }

  getTile(z, x, y, key) {
    let t = this.tiles.get(key);
    if (!t) {
      const img = new Image();
      t = { img, ok: false, err: false, seq: 0 };
      img.onload = () => {
        t.ok = true;
        this.requestRender();
      };
      img.onerror = () => {
        t.err = true;
      };
      img.src = this.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      this.tiles.set(key, t);
    }
    t.seq = ++this.tileSeq;
    return t;
  }

  pruneTiles(visible) {
    if (this.tiles.size <= MAX_TILES) return;
    const entries = [...this.tiles.entries()].filter(([k]) => !visible.has(k)).sort((a, b) => a[1].seq - b[1].seq);
    const drop = entries.length - Math.floor(MAX_TILES * 0.6);
    for (let i = 0; i < drop; i++) {
      const [k, t] = entries[i];
      if (!t.ok && !t.err) {
        t.img.onload = null;
        t.img.onerror = null;
        t.img.src = '';
      }
      this.tiles.delete(k);
    }
  }

  // --- Bedienelemente --------------------------------------------------------

  buildControls(attribution) {
    const zoomBox = document.createElement('div');
    zoomBox.className = 'smap-zoom';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.title = 'Hineinzoomen';
    plus.setAttribute('aria-label', 'Hineinzoomen');
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.title = 'Herauszoomen';
    minus.setAttribute('aria-label', 'Herauszoomen');
    plus.addEventListener('click', () => this.zoomIn(1));
    minus.addEventListener('click', () => this.zoomIn(-1));
    zoomBox.append(plus, minus);
    this.container.appendChild(zoomBox);

    this.scaleEl = document.createElement('div');
    this.scaleEl.className = 'smap-scale';
    this.container.appendChild(this.scaleEl);

    const attr = document.createElement('div');
    attr.className = 'smap-attribution';
    attr.innerHTML = attribution;
    this.container.appendChild(attr);
  }

  updateScale() {
    if (!this.scaleEl) return;
    const mpp = this.metersPerPixel();
    const maxMeters = 100 * mpp;
    const pow = Math.pow(10, Math.floor(Math.log10(maxMeters)));
    let nice = pow;
    for (const m of [5, 2, 1]) {
      if (pow * m <= maxMeters) {
        nice = pow * m;
        break;
      }
    }
    const px = nice / mpp;
    this.scaleEl.style.width = `${Math.round(px)}px`;
    this.scaleEl.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  }

  // --- Maus, Touch, Tastatur -------------------------------------------------

  bindEvents() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e, false));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    c.addEventListener('pointerleave', (e) => this.emit('pointerleave', this.eventFor(e)));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.emit('contextmenu', this.eventFor(e));
    });
    c.addEventListener('dblclick', (e) => e.preventDefault());
    this.container.addEventListener('keydown', (e) => this.onKey(e));
  }

  pointOf(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  eventFor(e, point = this.pointOf(e)) {
    return {
      point,
      latlng: this.unproject(point),
      originalEvent: e,
      consumed: false,
      consume() {
        this.consumed = true;
      },
    };
  }

  onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.container.focus({ preventScroll: true });
    const p = this.pointOf(e);
    this.pointers.set(e.pointerId, p);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // ältere Browser
    }
    if (this.pointers.size === 2) {
      this.drag = null;
      this.pinch = this.pinchState();
      return;
    }
    const ev = this.eventFor(e, p);
    this.emit('pointerdown', ev);
    this.drag = { id: e.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false, pan: this.dragEnabled && !ev.consumed };
  }

  onPointerMove(e) {
    const p = this.pointOf(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (this.drag && this.drag.id === e.pointerId) {
      const dx = p.x - this.drag.lastX;
      const dy = p.y - this.drag.lastY;
      if (!this.drag.moved && Math.hypot(p.x - this.drag.startX, p.y - this.drag.startY) > 4) this.drag.moved = true;
      if (this.drag.moved && this.drag.pan) {
        this.stopAnim();
        this.panBy(dx, dy);
        this.emit('drag');
      }
      this.drag.lastX = p.x;
      this.drag.lastY = p.y;
    }
    this.emit('pointermove', this.eventFor(e, p));
  }

  onPointerUp(e, cancelled) {
    const p = this.pointOf(e);
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // nichts
    }
    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.scheduleMoveEnd(100);
      }
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    this.drag = null;
    const ev = this.eventFor(e, p);
    this.emit('pointerup', ev);
    if (cancelled || drag.moved) return;
    const now = performance.now();
    this.emit('click', ev);
    if (this.lastClick && now - this.lastClick.t < 400 && Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) < 8) {
      this.lastClick = null;
      const dev = this.eventFor(e, p);
      this.emit('dblclick', dev);
      if (!dev.consumed) this.setZoomAround(p, Math.round(this.zoom) + 1);
    } else {
      this.lastClick = { t: now, x: p.x, y: p.y };
    }
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom: this.zoom };
  }

  updatePinch() {
    const s = this.pinchState();
    const dz = Math.log2(s.dist / this.pinch.dist);
    this.panBy(s.mid.x - this.pinch.mid.x, s.mid.y - this.pinch.mid.y);
    this.setZoomAround(s.mid, this.pinch.zoom + dz);
    this.pinch.mid = s.mid;
  }

  onWheel(e) {
    e.preventDefault();
    const factor = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0025;
    const dz = Math.max(-1, Math.min(1, -e.deltaY * factor));
    this.stopAnim();
    this.setZoomAround(this.pointOf(e), this.zoom + dz);
    this.scheduleMoveEnd(200);
  }

  onKey(e) {
    if (e.target !== this.container) return;
    const step = 80;
    switch (e.key) {
      case 'ArrowLeft': this.panBy(step, 0); break;
      case 'ArrowRight': this.panBy(-step, 0); break;
      case 'ArrowUp': this.panBy(0, step); break;
      case 'ArrowDown': this.panBy(0, -step); break;
      case '+': case '=': this.zoomIn(1); break;
      case '-': this.zoomIn(-1); break;
      default: return;
    }
    e.preventDefault();
  }
}
