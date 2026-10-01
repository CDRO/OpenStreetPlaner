// Variantenvergleich: jede Ebene allein sichtbar; Kosten, Fahrzeiten, Parzellen, Gebäude und Prüfungen je Ebene.
import { estimateCosts } from './costs.js';
import { computeRoutes, computeRoutesMany } from './routing.js';
import { runChecks } from './checks.js';
import { validParcels } from './parcels.js';
import { exposure } from './buildings.js';
import { pathLength } from './geometry.js';

/**
 * Liefert { layers: [{ id, name, visible, features, lengthNew, costs, routeTime, routeDelta, pairsDelta, pairsCount,
 * parcels, buildings, warnings }], currentTime }.
 */
export function compareVariants({ doc, osmWays = [], model = 'limit', buildings = [], radiusM = 50 }) {
  const out = { layers: [], currentTime: null };
  for (const layer of doc.layers) {
    const vdoc = { ...doc, layers: doc.layers.map((l) => ({ ...l, visible: l.id === layer.id })) };
    const feats = doc.features.filter((f) => f.layerId === layer.id);
    const roads = feats.filter((f) => f.type === 'road');
    const row = {
      id: layer.id,
      name: layer.name,
      visible: layer.visible !== false,
      features: feats.length,
      lengthNew: roads.filter((r) => r.status === 'new').reduce((s, r) => s + pathLength(r.nodes), 0),
      costs: (estimateCosts(vdoc).layers.find((l) => l.layerId === layer.id) || {}).amount || 0,
      routeTime: null,
      routeDelta: null,
      pairsDelta: null,
      pairsCount: 0,
      parcels: 0,
      buildings: null,
      warnings: runChecks(vdoc, { osmWays }).filter((c) => c.severity === 'warn').length,
    };
    const parcelIds = new Set();
    for (const r of roads) {
      const pc = validParcels(r);
      if (pc) for (const it of pc.items) parcelIds.add(it.egrid || it.id || `${r.id}:${it.number}`);
    }
    row.parcels = parcelIds.size;
    if (buildings.length) row.buildings = exposure({ buildings, routes: null, roads, radiusM }).roads.count;
    if (doc.route && osmWays.length) {
      const r = computeRoutes({ osmWays, doc: vdoc, from: doc.route.from, to: doc.route.to, model });
      if (r.proposed && !r.proposed.error) row.routeTime = r.proposed.time;
      if (r.current && !r.current.error) out.currentTime = r.current.time;
      if (row.routeTime !== null && out.currentTime !== null) row.routeDelta = row.routeTime - out.currentTime;
    }
    const pairs = (doc.routePairs || []).filter((p) => p.from && p.to);
    if (pairs.length && osmWays.length) {
      const res = computeRoutesMany({ osmWays, doc: vdoc, pairs, model });
      let sum = 0;
      let n = 0;
      for (const x of res) {
        if (x.current && !x.current.error && x.proposed && !x.proposed.error) {
          sum += x.proposed.time - x.current.time;
          n++;
        }
      }
      row.pairsDelta = n ? sum : null;
      row.pairsCount = n;
    }
    out.layers.push(row);
  }
  return out;
}
