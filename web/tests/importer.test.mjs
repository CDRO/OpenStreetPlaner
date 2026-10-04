import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseGeoJSON, parseGPX, parseKML, parseImport, applyImport } from '../js/importer.js';
import { createDocument, deserialize, serialize } from '../js/model.js';

test('Format erkennen', () => {
  assert.equal(detectFormat('{"type":"FeatureCollection","features":[]}'), 'geojson');
  assert.equal(detectFormat('{"version":1,"layers":[],"features":[]}'), 'stadtplaner');
  assert.equal(detectFormat('{"format":"stadtplaner-backup","formatVersion":1,"doc":{"layers":[],"features":[]},"versions":[]}'), 'backup');
  assert.equal(parseImport('{"format":"stadtplaner-backup","doc":{"layers":[],"features":[]}}', 'x.json').format, 'backup');
  assert.equal(detectFormat('<?xml version="1.0"?><gpx version="1.1"></gpx>'), 'gpx');
  assert.equal(detectFormat('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>'), 'kml');
  assert.equal(detectFormat('hallo', 'x.txt'), null);
  assert.equal(detectFormat('{kaputt', 'x.json'), null);
});

test('GeoJSON: Linien, Punkte, Polygone, Multi-Geometrien, Eigenschaften', () => {
  const items = parseGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'Weg', highway: 'residential', maxspeed: '30', oneway: 'yes' }, geometry: { type: 'LineString', coordinates: [[8, 47], [8.001, 47.001]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[8, 47], [8.002, 47]], [[8, 47.002], [8.002, 47.002], [8.003, 47.002]]] } },
      { type: 'Feature', properties: { name: 'Halt', kind: 'busstop' }, geometry: { type: 'Point', coordinates: [8.5, 47.5] } },
      { type: 'Feature', properties: { name: 'Zone', kind: 'tempo30' }, geometry: { type: 'Polygon', coordinates: [[[8, 47], [8.01, 47], [8.01, 47.01], [8, 47.01], [8, 47]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[8, 47]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [200, 47] } },
    ],
  });
  assert.equal(items.length, 5);
  assert.deepEqual(items[0].coords, [[47, 8], [47.001, 8.001]]);
  assert.equal(items[3].type, 'point');
  assert.equal(items[4].type, 'polygon');
  assert.equal(items[4].coords.length, 4, 'Schlusspunkt entfernt');
  const doc = createDocument();
  const counts = applyImport(doc, items, { layerName: 'Import test' });
  assert.deepEqual([counts.roads, counts.junctions, counts.zones], [3, 1, 1]);
  assert.equal(doc.layers.length, 2);
  const road = doc.features[0];
  assert.deepEqual([road.kind, road.maxspeed, road.oneway, road.status, road.name, road.layerId], ['residential', 30, true, 'existing', 'Weg', counts.layerId]);
  assert.equal(doc.features[3].kind, 'busstop');
  assert.equal(doc.features[4].kind, 'tempo30');
  const back = deserialize(serialize(doc));
  assert.equal(back.features.length, 5);
});

test('GPX: Tracks mit Segmenten, Routen, Wegpunkte', () => {
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <wpt lat="47.5" lon="8.5"><name>Start &amp; Ziel</name></wpt>
  <trk><name>Spaziergang</name>
    <trkseg><trkpt lat="47" lon="8"><ele>500</ele></trkpt><trkpt lat="47.001" lon="8.001"/></trkseg>
    <trkseg><trkpt lat="47.1" lon="8.1"/><trkpt lat="47.2" lon="8.2"/><trkpt lat="47.3" lon="8.3"/></trkseg>
  </trk>
  <rte><name>Route</name><rtept lat="46" lon="7"/><rtept lat="46.1" lon="7.1"/></rte>
</gpx>`;
  const items = parseGPX(gpx);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { type: 'line', coords: [[47, 8], [47.001, 8.001]], name: 'Spaziergang', props: {} });
  assert.equal(items[1].coords.length, 3);
  assert.equal(items[2].name, 'Route');
  assert.deepEqual(items[3], { type: 'point', coords: [[47.5, 8.5]], name: 'Start & Ziel', props: {} });
  assert.equal(parseImport(gpx, 'tour.gpx').format, 'gpx');
});

test('KML: Placemarks mit LineString, Point und Polygon', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Placemark><name>Linie</name><LineString><coordinates>8,47,0 8.001,47.001,0
      8.002,47.002</coordinates></LineString></Placemark>
    <Placemark><name><![CDATA[Punkt <A>]]></name><Point><coordinates>8.5,47.5</coordinates></Point></Placemark>
    <Placemark><name>Fläche</name><Polygon><outerBoundaryIs><LinearRing><coordinates>8,47 8.01,47 8.01,47.01 8,47.01 8,47</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  </Document></kml>`;
  const items = parseKML(kml);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].coords, [[47, 8], [47.001, 8.001], [47.002, 8.002]]);
  assert.equal(items[1].name, 'Punkt <A>');
  assert.equal(items[2].type, 'polygon');
  assert.equal(items[2].coords.length, 4);
  assert.throws(() => parseImport('<html></html>', 'x.html'), /Format nicht erkannt/);
});
