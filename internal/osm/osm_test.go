package osm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
