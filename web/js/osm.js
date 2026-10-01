// OSM-Strassen im Speicher: Der Bereich wird in feste Zellen zerlegt und jede
// Zelle einmal über das Backend geladen. So bleiben die Anfragen klein (Server-
// Limit pro Abfrage) und trotzdem lassen sich grössere Gebiete abdecken.

export const OSM_MIN_ZOOM = 16;
/** Zellgrösse in Grad (etwa 2,8 km × 1,9 km auf 47° Breite). */
export const CELL_DEG = 0.025;
/** Höchstzahl Zellen pro Anforderung (etwa 30 km × 20 km). */
export const MAX_CELLS = 100;

/** Zuordnung OSM highway-Tag -> Strassentyp des Entwurfs. */
export function roadKindFromHighway(tag) {
  switch (tag) {
    case 'motorway':
      return 'motorway';
    case 'trunk':
      return 'trunk';
    case 'primary': case 'motorway_link': case 'trunk_link': case 'primary_link':
      return 'main';
    case 'secondary': case 'tertiary': case 'secondary_link': case 'tertiary_link': case 'unclassified':
      return 'secondary';
    case 'residential': case 'living_street':
      return 'residential';
    case 'service': case 'track':
      return 'service';
    case 'footway': case 'path': case 'cycleway': case 'pedestrian': case 'steps': case 'bridleway':
      return 'path';
    default:
      return 'other';
  }
}

/** Zellen, die einen Bereich { south, west, north, east } abdecken. */
export function cellsFor(bounds) {
  const cells = [];
  const r0 = Math.floor(bounds.south / CELL_DEG);
  const r1 = Math.floor(bounds.north / CELL_DEG);
  const c0 = Math.floor(bounds.west / CELL_DEG);
  const c1 = Math.floor(bounds.east / CELL_DEG);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      cells.push({
        key: `${r}:${c}`,
        bounds: { south: r * CELL_DEG, north: (r + 1) * CELL_DEG, west: c * CELL_DEG, east: (c + 1) * CELL_DEG },
      });
    }
  }
  return cells;
}

/** Bereich um Start und Ziel einer Route (mit Rand). */
export function routeBounds(from, to, { factor = 0.3, minMeters = 400 } = {}) {
  const south = Math.min(from[0], to[0]);
  const north = Math.max(from[0], to[0]);
  const west = Math.min(from[1], to[1]);
  const east = Math.max(from[1], to[1]);
  const dLat = Math.max((north - south) * factor, minMeters / 111320);
  const dLng = Math.max((east - west) * factor, minMeters / (111320 * Math.cos(((south + north) / 2) * Math.PI / 180)));
  const b = { south: south - dLat, north: north + dLat, west: west - dLng, east: east + dLng };
  b.cells = cellsFor(b).length;
  b.tooLarge = b.cells > MAX_CELLS;
  return b;
}

/**
 * Hält geladene Strassen im Speicher. loader(bounds) -> Promise<Way[]>.
 * Zustandsmeldungen über subscribe(): { status: 'loading', remaining } |
 * { status: 'ready', count } | { status: 'error', error }.
 */
export class OsmRoadCache {
  constructor(loader, { concurrency = 2, delayMs = 150 } = {}) {
    this.loader = loader;
    this.concurrency = concurrency;
    this.delayMs = delayMs;
    this.ways = new Map();
    this.loadedCells = new Set();
    this.inFlight = new Set();
    this.queue = [];
    this.active = 0;
    this.listeners = new Set();
    this.lastError = null;
    this.pending = null; // Promise, bis die Warteschlange leer ist
    this.resolvePending = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(state) {
    for (const fn of this.listeners) fn(state);
  }

  list() {
    return Array.from(this.ways.values());
  }

  get(id) {
    return this.ways.get(id) || null;
  }

  /** Automatisches Laden beim Bewegen der Karte (nur ab OSM_MIN_ZOOM). */
  ensure(bounds, zoom) {
    if (zoom < OSM_MIN_ZOOM) return false;
    return this.ensureArea(bounds);
  }

  /** Lädt alle noch fehlenden Zellen eines Bereichs. Liefert false, wenn der Bereich zu gross ist. */
  ensureArea(bounds) {
    const cells = cellsFor(bounds);
    if (cells.length > MAX_CELLS) {
      this.lastError = new Error(`Bereich zu gross (${cells.length} Zellen, erlaubt ${MAX_CELLS})`);
      this.emit({ status: 'error', error: this.lastError });
      return false;
    }
    let added = 0;
    for (const cell of cells) {
      if (this.loadedCells.has(cell.key) || this.inFlight.has(cell.key) || this.queue.some((c) => c.key === cell.key)) continue;
      this.queue.push(cell);
      added++;
    }
    if (added) this.pump();
    return true;
  }

  /** Lädt die Zellen eines Bereichs erneut (z. B. auf ausdrücklichen Wunsch oder nach einem Fehler). */
  refreshArea(bounds) {
    for (const cell of cellsFor(bounds)) this.loadedCells.delete(cell.key);
    return this.ensureArea(bounds);
  }

  get remaining() {
    return this.queue.length + this.active;
  }

  pump() {
    if (!this.pending) {
      this.pending = new Promise((resolve) => { this.resolvePending = resolve; });
      this.lastError = null;
    }
    while (this.active < this.concurrency && this.queue.length) {
      const cell = this.queue.shift();
      this.active++;
      this.inFlight.add(cell.key);
      this.emit({ status: 'loading', remaining: this.remaining });
      this.loadCell(cell);
    }
  }

  /** Übernimmt die Antwort einer Zelle in den Speicher. */
  absorb(ways) {
    for (const w of ways) {
      if (!Array.isArray(w.geometry) || w.geometry.length < 2) continue;
      this.ways.set(w.id, { id: w.id, tags: w.tags || {}, geometry: w.geometry });
    }
  }

  async loadCell(cell) {
    try {
      this.absorb(await this.loader(cell.bounds));
      this.loadedCells.add(cell.key);
    } catch (e) {
      this.lastError = e;
      this.emit({ status: 'error', error: e });
    } finally {
      this.inFlight.delete(cell.key);
      this.active--;
      if (this.queue.length) {
        await new Promise((r) => setTimeout(r, this.delayMs));
        this.pump();
      } else if (this.active === 0) {
        const resolve = this.resolvePending;
        this.pending = null;
        this.resolvePending = null;
        if (!this.lastError) this.emit({ status: 'ready', count: this.ways.size });
        if (resolve) resolve();
      }
    }
  }
}

/**
 * Haltestellen und Buslinien aus OSM, zellenweise wie die Strassen. loader(bounds) -> Promise<{ stops, routes }>.
 * stops: Map id -> { id, name, at, lines }, routes: Map id -> { id, ref, name, from, to, operator, colour, stops }.
 */
export class OsmTransitCache extends OsmRoadCache {
  constructor(loader, opts) {
    super(loader, opts);
    this.stops = new Map();
    this.routes = new Map();
  }

  absorb(data) {
    for (const s of (data && data.stops) || []) if (s && Number.isInteger(s.id) && Array.isArray(s.at)) this.stops.set(s.id, s);
    for (const r of (data && data.routes) || []) if (r && Number.isInteger(r.id) && Array.isArray(r.stops) && r.stops.length >= 2) this.routes.set(r.id, r);
    this.ways = this.stops; // Zähler (ways.size) der Basisklasse: geladene Haltestellen
  }

  stopList() {
    return Array.from(this.stops.values());
  }

  /** Linien natürlich nach Nummer sortiert (2 vor 10). */
  routeList() {
    const num = (s) => { const m = /^\d+/.exec(s || ''); return m ? Number(m[0]) : Infinity; };
    return Array.from(this.routes.values()).sort((a, b) => (num(a.ref) - num(b.ref)) || String(a.ref || '').localeCompare(String(b.ref || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  }
}
