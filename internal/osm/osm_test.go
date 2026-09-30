package osm

import (
	"context"
	"errors"
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
		if !strings.Contains(r.Form.Get("geom"), `"coordinates":[[8,47],[8.001,47.001]]`) || r.Form.Get("sr") != "4326" {
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
