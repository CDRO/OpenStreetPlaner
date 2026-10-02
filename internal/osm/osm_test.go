package osm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseBBox(t *testing.T) {
	if _, err := ParseBBox("46.99,7.99,47.01,8.01"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"1,2,3", "a,b,c,d", "47.01,8,46.99,8.01", "46,7,47,8", "-91,0,1,1"} {
		if _, err := ParseBBox(bad); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%q sollte abgelehnt werden, bekam %v", bad, err)
		}
	}
}

func TestSearchCachesAndThrottles(t *testing.T) {
	var calls int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		if r.Header.Get("User-Agent") != DefaultUserAgent {
			t.Errorf("User-Agent fehlt: %q", r.Header.Get("User-Agent"))
		}
		if r.URL.Query().Get("q") != "Bern" {
			t.Errorf("q falsch: %q", r.URL.Query().Get("q"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"display_name":"Bern, Schweiz","lat":"46.948","lon":"7.447","type":"city","boundingbox":["46.9","47.0","7.3","7.5"]}]`))
	}))
	defer up.Close()
	c := New("")
	c.NominatimURL = up.URL
	ctx := context.Background()
	start := time.Now()
	res, err := c.Search(ctx, "Bern", 5)
	if err != nil || len(res) != 1 || res[0].Lat != 46.948 || res[0].BBox == nil || res[0].BBox[3] != 7.5 {
		t.Fatalf("Search: %v %+v", err, res)
	}
	if _, err := c.Search(ctx, "bern", 5); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("zweite Suche sollte aus dem Cache kommen, calls=%d", calls)
	}
	if _, err := c.Search(ctx, "Bern", 6); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != 2 || time.Since(start) < nominatimMinGap {
		t.Fatalf("Drosselung greift nicht: calls=%d dauer=%v", calls, time.Since(start))
	}
	if _, err := c.Search(ctx, "", 5); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("leere Suche: %v", err)
	}
}

func TestRoads(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.Form.Get("data") == "" {
			t.Errorf("Overpass-Query fehlt")
		}
		_, _ = w.Write([]byte(`{"elements":[{"type":"way","id":7,"tags":{"highway":"primary","name":"Dorfstrasse"},"geometry":[{"lat":47,"lon":8},{"lat":47.001,"lon":8.001}]},{"type":"node","id":1},{"type":"way","id":8,"geometry":[{"lat":1,"lon":1}]}]}`))
	}))
	defer up.Close()
	c := New("")
	c.OverpassURL = up.URL
	b, _ := ParseBBox("46.99,7.99,47.01,8.01")
	ways, err := c.Roads(context.Background(), b)
	if err != nil || len(ways) != 1 || ways[0].Tags["name"] != "Dorfstrasse" || ways[0].Geometry[1][1] != 8.001 {
		t.Fatalf("Roads: %v %+v", err, ways)
	}
}

func TestTileProxyCachesOnDisk(t *testing.T) {
	var calls int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		if r.URL.Path != "/16/34000/23000.png" {
			t.Errorf("Pfad falsch: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("PNGDATA"))
	}))
	defer up.Close()
	dir := t.TempDir()
	c := New(dir)
	c.TileURL = up.URL + "/{z}/{x}/{y}.png"
	ctx := context.Background()
	data, ctype, err := c.Tile(ctx, 16, 34000, 23000)
	if err != nil || string(data) != "PNGDATA" || ctype != "image/png" {
		t.Fatalf("Tile: %v %q %q", err, data, ctype)
	}
	if _, err := filepath.Glob(filepath.Join(dir, "16", "34000", "23000.png")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Tile(ctx, 16, 34000, 23000); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("Kachel nicht aus dem Cache: calls=%d", calls)
	}
	if _, _, err := c.Tile(ctx, 20, 0, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("Zoom 20 sollte abgelehnt werden: %v", err)
	}
	if _, _, err := c.Tile(ctx, 3, 8, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("x ausserhalb sollte abgelehnt werden: %v", err)
	}
}

func TestTileSourcesAndWMSBBox(t *testing.T) {
	minx, miny, maxx, maxy := TileBBox3857(0, 0, 0)
	if minx != -mercatorHalf || maxx != mercatorHalf || miny != -mercatorHalf || maxy != mercatorHalf {
		t.Fatalf("Weltkachel: %v %v %v %v", minx, miny, maxx, maxy)
	}
	minx, miny, maxx, maxy = TileBBox3857(1, 1, 0)
	if minx != 0 || maxx != mercatorHalf || miny != 0 || maxy != mercatorHalf {
		t.Fatalf("Kachel 1/1/0: %v %v %v %v", minx, miny, maxx, maxy)
	}
	var gotURL string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("JPG"))
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.SetSources(DefaultTileSources())
	c.SetSources([]TileSource{
		{ID: "wms", Label: "WMS", URL: up.URL + "/wms?BBOX={bbox}&SIZE=256", MaxZoom: 20, Overlay: true, Ext: "png"},
		{ID: "osm", Label: "OSM lokal", URL: up.URL + "/{z}/{x}/{y}.jpeg", MaxZoom: 19, Ext: "jpeg"},
	})
	srcs := c.Sources()
	if len(srcs) != 6 || srcs[0].ID != "osm" || srcs[0].Label != "OSM lokal" || srcs[0].URL != "" || !srcs[5].Overlay {
		t.Fatalf("Quellen: %+v", srcs)
	}
	data, ctype, err := c.TileFrom(context.Background(), "wms", 1, 1, 0)
	if err != nil || string(data) != "JPG" || ctype != "image/jpeg" {
		t.Fatalf("WMS-Kachel: %v %q %s", err, data, ctype)
	}
	if !strings.Contains(gotURL, "BBOX=0.0000,0.0000,20037508.3428,20037508.3428") {
		t.Fatalf("BBOX nicht eingesetzt: %s", gotURL)
	}
	if _, _, err := c.TileFrom(context.Background(), "osm", 5, 3, 4); err != nil || !strings.HasSuffix(gotURL, "/5/3/4.jpeg") {
		t.Fatalf("z/x/y-Vorlage: %v %s", err, gotURL)
	}
	if _, _, err := c.TileFrom(context.Background(), "nope", 1, 0, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("unbekannte Quelle: %v", err)
	}
	if _, _, err := c.TileFrom(context.Background(), "osm", 20, 0, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("Zoom über MaxZoom der Quelle: %v", err)
	}
	if _, err := filepath.Glob(filepath.Join(c.TileDir, "osm", "5", "3", "4.jpeg")); err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseTileSources(`[{"id":"x","label":"X","url":"https://t/{z}/{x}/{y}.png"}]`)
	if err != nil || parsed[0].MaxZoom != 19 || parsed[0].Ext != "png" {
		t.Fatalf("ParseTileSources: %v %+v", err, parsed)
	}
	if _, err := ParseTileSources(`[{"id":"x"}]`); err == nil {
		t.Fatalf("Quelle ohne URL akzeptiert")
	}
}

func TestProfile(t *testing.T) {
	var calls int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = r.ParseForm()
		// Landeskoordinaten LV95 (sr 2056), nicht WGS84 – sonst antwortet swisstopo mit 400
		if !strings.Contains(r.Form.Get("geom"), `"coordinates":[[2642695.43,1205590.52],[2642770.68,1205702.23]]`) || r.Form.Get("sr") != "2056" {
			t.Errorf("Anfrage: %v", r.Form)
		}
		_, _ = w.Write([]byte(`[{"dist":0,"alts":{"COMB":500.5,"DTM2":500.4}},{"dist":70,"alts":{"DTM25":510}},{"dist":140,"alts":{}}]`))
	}))
	defer up.Close()
	c := New("")
	c.ProfileURL = up.URL
	pts, err := c.Profile(context.Background(), [][2]float64{{47, 8}, {47.001, 8.001}})
	if err != nil || len(pts) != 2 || pts[0].Height != 500.5 || pts[1].Height != 510 || pts[1].Dist != 70 {
		t.Fatalf("Profile: %v %+v", err, pts)
	}
	if _, err := c.Profile(context.Background(), [][2]float64{{47, 8}, {47.001, 8.001}}); err != nil || atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("Cache: %v calls=%d", err, calls)
	}
	if _, err := c.Profile(context.Background(), [][2]float64{{47, 8}}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("ein Punkt: %v", err)
	}
	c.ProfileURL = ""
	if _, err := c.Profile(context.Background(), [][2]float64{{47, 8}, {47.001, 8.001}}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("deaktiviert: %v", err)
	}
}

func TestParcelsChunksAndDedupes(t *testing.T) {
	calls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("geometryType") != "esriGeometryPolyline" || r.URL.Query().Get("layers") != "all:"+ParcelLayer {
			t.Errorf("Parameter: %s", r.URL.RawQuery)
		}
		var geom struct {
			Paths [][][2]float64 `json:"paths"`
		}
		if err := json.Unmarshal([]byte(r.URL.Query().Get("geometry")), &geom); err != nil || len(geom.Paths) != 1 || len(geom.Paths[0]) > parcelChunk {
			t.Errorf("Geometrie: %s", r.URL.Query().Get("geometry"))
		}
		// Jede Anfrage liefert dieselbe Parzelle 1 und eine eigene Parzelle je Aufruf
		fmt.Fprintf(w, `{"results":[
		  {"featureId":"P1","attributes":{"egris_egrid":"CH1","number":"101","ak":"BE","label":"Liegenschaft"},"geometry":{"type":"Polygon","coordinates":[[[8.0,47.0],[8.01,47.0],[8.01,47.01],[8.0,47.01],[8.0,47.0]]]}},
		  {"featureId":"P%d","attributes":{"egris_egrid":"CH%d","number":"%d"},"geometry":{"type":"MultiPolygon","coordinates":[[[[8.0,47.0],[8.001,47.0],[8.001,47.001],[8.0,47.0]]]]}}
		]}`, calls+1, calls+1, calls+1)
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.ParcelURL = up.URL
	coords := make([][2]float64, 60)
	for i := range coords {
		coords[i] = [2]float64{47, 8 + float64(i)*0.0001}
	}
	got, err := c.Parcels(context.Background(), coords)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("60 Punkte in Blöcken zu %d: %d Aufrufe", parcelChunk, calls)
	}
	if len(got) != 4 {
		t.Fatalf("Parzellen (dedupliziert): %d", len(got))
	}
	if got[0].Egrid != "CH1" || got[0].Number != "101" || got[0].Canton != "BE" || len(got[0].Polygons) != 1 || len(got[0].Polygons[0][0]) != 5 {
		t.Fatalf("Parzelle 1: %+v", got[0])
	}
	if got[0].Polygons[0][0][1] != [2]float64{47.0, 8.01} {
		t.Fatalf("lat/lng vertauscht: %v", got[0].Polygons[0][0][1])
	}
	if len(got[1].Polygons) != 1 || got[1].Number != "2" {
		t.Fatalf("MultiPolygon: %+v", got[1])
	}
	// Cache: zweite Abfrage ohne Aufruf
	_, _ = c.Parcels(context.Background(), coords)
	if calls != 3 {
		t.Fatalf("Cache nicht genutzt: %d", calls)
	}
	c.ParcelURL = ""
	if _, err := c.Parcels(context.Background(), coords); err == nil {
		t.Fatal("deaktiviert sollte einen Fehler liefern")
	}
}

func TestBuildings(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"elements":[
		  {"type":"way","id":5,"tags":{"building":"house","name":"Haus","source":"x"},"geometry":[{"lat":47,"lon":8},{"lat":47,"lon":8.0001},{"lat":47.0001,"lon":8.0001},{"lat":47,"lon":8}]},
		  {"type":"way","id":6,"tags":{"building":"yes"},"geometry":[{"lat":47,"lon":8},{"lat":47,"lon":8.0001}]}
		]}`)
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.OverpassURL = up.URL
	got, err := c.Buildings(context.Background(), BBox{South: 47, West: 8, North: 47.01, East: 8.01})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != 5 || len(got[0].Geometry) != 4 || got[0].Tags["name"] != "Haus" || got[0].Tags["source"] != "" {
		t.Fatalf("Gebäude: %+v", got)
	}
}

func TestTransit(t *testing.T) {
	var query string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		query = r.Form.Get("data")
		fmt.Fprint(w, `{"elements":[
		  {"type":"node","id":1,"lat":47.001,"lon":8.001,"tags":{"highway":"bus_stop","name":"Dorf","route_ref":"12;7"}},
		  {"type":"node","id":2,"lat":47.002,"lon":8.002,"tags":{"public_transport":"stop_position","bus":"yes","name":"Post"}},
		  {"type":"node","id":3,"lat":47.003,"lon":8.003,"tags":{"public_transport":"platform","bus":"yes","name":"Post"}},
		  {"type":"node","id":4,"lat":48,"lon":9,"tags":{"highway":"bus_stop","name":"Weit weg"}},
		  {"type":"node","id":5,"lat":47.004,"lon":8.004,"tags":{"public_transport":"platform","train":"yes","name":"Bahn"}},
		  {"type":"relation","id":100,"tags":{"route":"bus","ref":"12","name":"Bus 12: Dorf - Weit weg","colour":"#FF0000","operator":"PostAuto"},
		   "members":[{"type":"way","ref":900,"role":""},{"type":"node","ref":1,"role":"stop"},{"type":"node","ref":3,"role":"platform"},{"type":"node","ref":2,"role":"stop"},{"type":"node","ref":2,"role":"stop_exit_only"},{"type":"node","ref":4,"role":"stop"},{"type":"node","ref":99,"role":"stop"}]},
		  {"type":"relation","id":101,"tags":{"route":"bus","ref":"7"},"members":[{"type":"node","ref":3,"role":"platform"},{"type":"node","ref":1,"role":"platform"}]},
		  {"type":"relation","id":102,"tags":{"route":"bus","ref":"1"},"members":[{"type":"node","ref":1,"role":"stop"}]},
		  {"type":"relation","id":103,"tags":{"route":"tram","ref":"2"},"members":[{"type":"node","ref":1,"role":"stop"},{"type":"node","ref":2,"role":"stop"}]}
		]}`)
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.OverpassURL = up.URL
	got, err := c.Transit(context.Background(), BBox{South: 47, West: 8, North: 47.01, East: 8.01})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(query, `relation["route"="bus"]`) || !strings.Contains(query, `node(r.r)`) {
		t.Fatalf("Query: %s", query)
	}
	// Haltestellen: nur Bus-Knoten im Bereich (1, 2, 3), nicht 4 (ausserhalb) und 5 (Bahn)
	if len(got.Stops) != 3 || got.Stops[0].ID != 1 || got.Stops[2].ID != 3 {
		t.Fatalf("Haltestellen: %+v", got.Stops)
	}
	if strings.Join(got.Stops[0].Lines, ",") != "12,7" || got.Stops[0].At != [2]float64{47.001, 8.001} {
		t.Fatalf("Linien an Haltestelle 1: %+v", got.Stops[0])
	}
	if strings.Join(got.Stops[2].Lines, ",") != "7" {
		t.Fatalf("Linien an Haltestelle 3 (nur Plattform-Linie): %+v", got.Stops[2])
	}
	// Linien: 7 (Plattformen) vor 12 (natürliche Sortierung); Tram und Einzelhalt fliegen raus
	if len(got.Routes) != 2 || got.Routes[0].Ref != "7" || got.Routes[1].Ref != "12" {
		t.Fatalf("Linien: %+v", got.Routes)
	}
	r12 := got.Routes[1]
	ids := []int64{}
	for _, s := range r12.Stops {
		ids = append(ids, s.ID)
	}
	if fmt.Sprint(ids) != "[1 2 4]" || r12.Colour != "#ff0000" || r12.Operator != "PostAuto" || r12.Stops[0].Name != "Dorf" {
		t.Fatalf("Linie 12: %+v", r12)
	}
	if len(got.Routes[0].Stops) != 2 || got.Routes[0].Stops[0].ID != 3 || got.Routes[0].Source != "platform" || r12.Source != "stop" {
		t.Fatalf("Linie 7 (Plattformen): %+v", got.Routes[0])
	}
	// Zweiter Aufruf aus dem Cache
	query = ""
	if again, err := c.Transit(context.Background(), BBox{South: 47, West: 8, North: 47.01, East: 8.01}); err != nil || len(again.Routes) != 2 || query != "" {
		t.Fatalf("Cache: %v %q", err, query)
	}
}

func TestParking(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if !strings.Contains(r.Form.Get("data"), `way["amenity"="parking"]`) {
			t.Errorf("Query: %s", r.Form.Get("data"))
		}
		fmt.Fprint(w, `{"elements":[
		  {"type":"way","id":5,"tags":{"amenity":"parking","capacity":"40","parking":"surface","source":"x"},"geometry":[{"lat":47,"lon":8},{"lat":47,"lon":8.001},{"lat":47.001,"lon":8.001},{"lat":47,"lon":8}]},
		  {"type":"way","id":6,"tags":{"amenity":"parking"},"geometry":[{"lat":47,"lon":8},{"lat":47,"lon":8.001}]}
		]}`)
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.OverpassURL = up.URL
	got, err := c.Parking(context.Background(), BBox{South: 47, West: 8, North: 47.01, East: 8.01})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != 5 || got[0].Tags["capacity"] != "40" || got[0].Tags["source"] != "" || len(got[0].Geometry) != 4 {
		t.Fatalf("Parkplätze: %+v", got)
	}
}

func TestTimetable(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/locations":
			if r.URL.Query().Get("x") == "47.050000" {
				fmt.Fprint(w, `{"stations":[{"id":"8500001","name":"Dorf, Post","distance":42}]}`)
			} else {
				fmt.Fprint(w, `{"stations":[{"id":"8500002","name":"Dorf, Bahnhof","distance":12}]}`)
			}
		case "/connections":
			if r.URL.Query().Get("from") != "8500001" || r.URL.Query().Get("to") != "8500002" || r.URL.Query().Get("transportations[]") != "bus" {
				t.Errorf("Parameter: %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `{"connections":[
			  {"duration":"00d00:14:00","transfers":0,"sections":[{"journey":{"name":"B 12","category":"B","number":"12"},"departure":{"departure":"2026-10-01T06:15:00+0200"},"arrival":{"arrival":"2026-10-01T06:29:00+0200"}}]},
			  {"duration":"00d00:16:00","transfers":0,"sections":[{"journey":null,"walk":{"duration":120},"departure":{"departure":"x"},"arrival":{"arrival":"y"}},{"journey":{"name":"B 12","category":"B","number":"12"},"departure":{"departure":"2026-10-01T06:45:00+0200"},"arrival":{"arrival":"2026-10-01T06:59:00+0200"}}]},
			  {"duration":"00d00:12:00","transfers":0,"sections":[{"journey":{"name":"B 7","category":"B","number":"7"},"departure":{"departure":"d"},"arrival":{"arrival":"e"}}]},
			  {"duration":"00d00:30:00","transfers":1,"sections":[{"journey":{"name":"B 12","category":"B","number":"12"},"departure":{"departure":"d"},"arrival":{"arrival":"e"}}]},
			  {"duration":"00d00:09:00","transfers":0,"sections":[{"journey":{"name":"S 1","category":"S","number":"1"},"departure":{"departure":"d"},"arrival":{"arrival":"e"}}]}
			]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()
	c := New(t.TempDir())
	c.TimetableURL = up.URL
	got, err := c.Timetable(context.Background(), [2]float64{47.05, 8.3}, [2]float64{47.06, 8.31}, "12")
	if err != nil {
		t.Fatal(err)
	}
	if got.From.Name != "Dorf, Post" || got.To.ID != "8500002" || got.Trips != 2 || got.Median != 900 || got.Min != 840 || got.Max != 960 {
		t.Fatalf("Fahrplan Linie 12: %+v", got)
	}
	all, err := c.Timetable(context.Background(), [2]float64{47.05, 8.3}, [2]float64{47.06, 8.31}, "")
	if err != nil || all.Trips != 3 || all.Median != 840 {
		t.Fatalf("alle Linien: %v %+v", err, all)
	}
	if _, err := c.Timetable(context.Background(), [2]float64{47.05, 8.3}, [2]float64{47.06, 8.31}, "99"); err == nil || !strings.Contains(err.Error(), "Linie 99") {
		t.Fatalf("unbekannte Linie: %v", err)
	}
	c.TimetableURL = ""
	if _, err := c.Timetable(context.Background(), [2]float64{47.05, 8.3}, [2]float64{47.06, 8.31}, ""); err == nil {
		t.Fatal("abgeschalteter Dienst muss einen Fehler liefern")
	}
}

func TestWGS84ToLV95(t *testing.T) {
	// Beispiel aus der swisstopo-Dokumentation der Näherungsformeln
	e, n := WGS84ToLV95(46.0441305, 8.7304972) // 46°02'38.87" N, 8°43'49.79" E
	if math.Abs(e-2699999.76) > 0.5 || math.Abs(n-1099999.97) > 0.5 {
		t.Fatalf("LV95: %.2f %.2f", e, n)
	}
	e, n = WGS84ToLV95(46.9524056, 7.4395833) // Bern, alte Sternwarte: Nullpunkt der Formel
	if math.Abs(e-2600072.37) > 0.5 || math.Abs(n-1200147.07) > 0.5 {
		t.Fatalf("Bern: %.2f %.2f", e, n)
	}
}

func TestUpstreamErrorExcerpt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error": {"message": "Please provide a valid number for the spatial reference system model 21781 or 2056", "code": 400}}`, http.StatusBadRequest)
	}))
	defer srv.Close()
	c := New(t.TempDir())
	c.ProfileURL = srv.URL
	_, err := c.Profile(context.Background(), [][2]float64{{47, 8}, {47.001, 8.001}})
	if err == nil || !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "spatial reference") {
		t.Fatalf("Fehlertext ohne Erklärung des Dienstes: %v", err)
	}
	if got := bodyExcerpt([]byte("  viel \n Text  hier "), 8); got != "viel Tex…" {
		t.Fatalf("Kurzfassung: %q", got)
	}
}
