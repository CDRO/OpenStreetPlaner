// OSM-Strassen im Sichtbereich (über das Backend geladen) und Tag-Zuordnung.

export const OSM_MIN_ZOOM = 16;
/** Grösster Bereich (Grad), den der Server pro Anfrage liefert (siehe internal/osm). */
export const OSM_MAX_SPAN = 0.06;

/** Erweitert einen Bereich um Faktor und mindestens minMeters, und prüft die Servergrenze. */
export function routeBounds(from, to, { factor = 0.3, minMeters = 400 } = {}) {
  const south = Math.min(from[0], to[0]);
  const north = Math.max(from[0], to[0]);
  const west = Math.min(from[1], to[1]);
  const east = Math.max(from[1], to[1]);
  const dLat = Math.max((north - south) * factor, minMeters / 111320);
  const dLng = Math.max((east - west) * factor, minMeters / (111320 * Math.cos(((south + north) / 2) * Math.PI / 180)));
  const b = { south: south - dLat, north: north + dLat, west: west - dLng, east: east + dLng };
  // Auf die Servergrenze stutzen: der Bereich darf pro Anfrage nicht grösser sein.
  b.tooLarge = b.north - b.south > OSM_MAX_SPAN || b.east - b.west > OSM_MAX_SPAN;
  return b;
}

/** Zuordnung OSM highway-Tag -> Strassentyp des Entwurfs. */
export function roadKindFromHighway(tag) {
  switch (tag) {
    case 'motorway': case 'trunk': case 'primary': case 'motorway_link': case 'trunk_link': case 'primary_link':
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

function contains(outer, inner) {
  return !!outer && inner.south >= outer.south && inner.west >= outer.west && inner.north <= outer.north && inner.east <= outer.east;
}

function expand(b, factor) {
  const dLat = (b.north - b.south) * factor;
  const dLng = (b.east - b.west) * factor;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

/**
 * Hält geladene Strassen im Speicher. loader(bounds) -> Promise<Way[]>.
 * Ein Bereich innerhalb eines bereits geladenen wird nicht erneut angefragt.
 */
export class OsmRoadCache {
  constructor(loader) {
    this.loader = loader;
    this.ways = new Map();
    this.loadedBoxes = [];
    this.pending = null;
    this.queued = null;
    this.listeners = new Set();
    this.lastError = null;
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

  ensure(bounds, zoom) {
    if (zoom < OSM_MIN_ZOOM) return;
    this.ensureArea(bounds);
  }

  /** Lädt einen Bereich unabhängig vom Zoom (Routen-Rechner). */
  ensureArea(bounds) {
    if (this.loadedBoxes.some((b) => contains(b, bounds))) return;
    const target = expand(bounds, 0.25);
    if (this.pending) {
      this.queued = target;
      return;
    }
    this.pending = this.load(target).finally(() => {
      this.pending = null;
      if (this.queued) {
        const next = this.queued;
        this.queued = null;
        if (!this.loadedBoxes.some((b) => contains(b, next))) this.ensureArea(next);
      }
    });
  }

  async load(b) {
    this.emit({ status: 'loading' });
    try {
      const ways = await this.loader(b);
      for (const w of ways) {
        if (!Array.isArray(w.geometry) || w.geometry.length < 2) continue;
        this.ways.set(w.id, { id: w.id, tags: w.tags || {}, geometry: w.geometry });
      }
      this.loadedBoxes.push(b);
      if (this.loadedBoxes.length > 12) this.loadedBoxes.shift();
      this.lastError = null;
      this.emit({ status: 'ready', count: this.ways.size });
    } catch (e) {
      this.lastError = e;
      this.emit({ status: 'error', error: e });
    }
  }
}
