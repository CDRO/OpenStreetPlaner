// OSM-Strassen im Sichtbereich (über das Backend geladen) und Tag-Zuordnung.

export const OSM_MIN_ZOOM = 16;

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
        if (!this.loadedBoxes.some((b) => contains(b, next))) this.ensure(next, zoom);
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
