package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"stadtplaner/internal/osm"
	"stadtplaner/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *osm.Client) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	web := fstest.MapFS{
		"web/index.html":  {Data: []byte("<!doctype html><title>Stadtplaner</title>")},
		"web/css/app.css": {Data: []byte("body{}")},
	}
	client := osm.New(t.TempDir())
	s, err := New(st, client, web, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, client
}

func call(t *testing.T, method, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if s, ok := body.(string); ok {
			buf.WriteString(s)
		} else {
			_ = json.NewEncoder(&buf).Encode(body)
		}
	}
	req, _ := http.NewRequest(method, url, &buf)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return res, out
}

func sampleDoc() map[string]any {
	return map[string]any{
		"name":   "Hauptstrasse neu",
		"layers": []map[string]any{{"id": "l1", "name": "A", "color": "#123456", "visible": true}},
		"features": []map[string]any{
			{"id": "r1", "type": "road", "layerId": "l1", "kind": "main", "nodes": [][2]float64{{47, 8}, {47, 8.001}}, "segments": []map[string]any{{"level": "tunnel"}}},
		},
	}
}

func TestDraftLifecycle(t *testing.T) {
	ts, _ := newTestServer(t)
	res, out := call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	if res.StatusCode != 201 || out["id"] == nil || out["editToken"] == nil {
		t.Fatalf("create: %d %+v", res.StatusCode, out)
	}
	id := out["id"].(string)
	token := out["editToken"].(string)

	res, out = call(t, "GET", ts.URL+"/api/drafts/"+id, nil, nil)
	if res.StatusCode != 200 || out["name"] != "Hauptstrasse neu" || out["versionCount"].(float64) != 1 {
		t.Fatalf("get: %d %+v", res.StatusCode, out)
	}
	if strings.Contains(res.Header.Get("Content-Security-Policy"), "unsafe-eval") || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("Sicherheits-Header fehlen: %v", res.Header)
	}

	doc := sampleDoc()
	doc["name"] = "Variante B"
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id, map[string]any{"doc": doc, "label": "B"}, nil)
	if res.StatusCode != 403 {
		t.Fatalf("save ohne Token: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id, map[string]any{"doc": doc, "label": "B"}, map[string]string{"X-Edit-Token": token})
	if res.StatusCode != 200 || out["versionCount"].(float64) != 2 {
		t.Fatalf("save: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "POST", ts.URL+"/api/drafts/"+id+"/auth", nil, map[string]string{"X-Edit-Token": token})
	if res.StatusCode != 204 {
		t.Fatalf("auth: %d", res.StatusCode)
	}
	res, _ = call(t, "POST", ts.URL+"/api/drafts/"+id+"/auth", nil, map[string]string{"X-Edit-Token": "nope"})
	if res.StatusCode != 403 {
		t.Fatalf("auth falsch: %d", res.StatusCode)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/drafts/"+id+"/versions", nil)
	vres, _ := http.DefaultClient.Do(req)
	var versions []map[string]any
	_ = json.NewDecoder(vres.Body).Decode(&versions)
	if len(versions) != 2 || versions[0]["label"] != "B" || versions[1]["n"].(float64) != 1 {
		t.Fatalf("versions: %+v", versions)
	}
	res, out = call(t, "GET", ts.URL+"/api/drafts/"+id+"/versions/1", nil, nil)
	if res.StatusCode != 200 || out["doc"].(map[string]any)["name"] != "Hauptstrasse neu" {
		t.Fatalf("version 1: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "GET", ts.URL+"/api/drafts/"+id+"/versions/99", nil, nil)
	if res.StatusCode != 404 {
		t.Fatalf("version 99: %d", res.StatusCode)
	}

	res, out = call(t, "POST", ts.URL+"/api/drafts/"+id+"/fork", map[string]any{"name": "Kopie"}, nil)
	if res.StatusCode != 201 || out["id"] == id || out["doc"].(map[string]any)["name"] != "Kopie" {
		t.Fatalf("fork: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "POST", ts.URL+"/api/drafts/"+id+"/fork", nil, nil)
	if res.StatusCode != 201 {
		t.Fatalf("fork ohne Body: %d", res.StatusCode)
	}

	res, _ = call(t, "DELETE", ts.URL+"/api/drafts/"+id, nil, map[string]string{"X-Edit-Token": token})
	if res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	res, _ = call(t, "GET", ts.URL+"/api/drafts/"+id, nil, nil)
	if res.StatusCode != 404 {
		t.Fatalf("nach delete: %d", res.StatusCode)
	}
}

func TestValidationAndLimits(t *testing.T) {
	ts, _ := newTestServer(t)
	res, out := call(t, "POST", ts.URL+"/api/drafts", "{not json", nil)
	if res.StatusCode != 400 {
		t.Fatalf("kaputtes JSON: %d %+v", res.StatusCode, out)
	}
	bad := sampleDoc()
	bad["features"] = []map[string]any{{"id": "x", "type": "road", "layerId": "l1", "nodes": [][2]float64{{1, 1}}}}
	res, out = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": bad}, nil)
	if res.StatusCode != 400 || !strings.Contains(out["error"].(string), "zwei Punkte") {
		t.Fatalf("ungültiger Entwurf: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"label": "x"}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("ohne doc: %d", res.StatusCode)
	}
	huge := strings.Repeat("x", maxBodyBytes+10)
	res, _ = call(t, "POST", ts.URL+"/api/drafts", `{"doc":{"name":"`+huge+`"}}`, nil)
	if res.StatusCode != 413 {
		t.Fatalf("zu gross: %d", res.StatusCode)
	}
	res, _ = call(t, "GET", ts.URL+"/api/drafts/../etc", nil, nil)
	if res.StatusCode != 404 && res.StatusCode != 400 && res.StatusCode != 301 {
		t.Fatalf("Pfad-Trick: %d", res.StatusCode)
	}
	res, _ = call(t, "GET", ts.URL+"/api/drafts/UPPERCASE", nil, nil)
	if res.StatusCode != 404 {
		t.Fatalf("ungültige ID: %d", res.StatusCode)
	}
}

func TestOsmProxiesAndStatic(t *testing.T) {
	ts, client := newTestServer(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/search"):
			_, _ = w.Write([]byte(`[{"display_name":"Testdorf","lat":"47.2","lon":"8.5","type":"village"}]`))
		case strings.HasPrefix(r.URL.Path, "/overpass"):
			_, _ = w.Write([]byte(`{"elements":[{"type":"way","id":1,"tags":{"highway":"primary"},"geometry":[{"lat":47,"lon":8},{"lat":47.001,"lon":8.001}]}]}`))
		default:
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("PNG"))
		}
	}))
	defer up.Close()
	client.NominatimURL = up.URL + "/search"
	client.OverpassURL = up.URL + "/overpass"
	client.TileURL = up.URL + "/t/{z}/{x}/{y}.png"

	req, _ := http.NewRequest("GET", ts.URL+"/api/search?q=Testdorf", nil)
	res, _ := http.DefaultClient.Do(req)
	var places []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&places)
	if res.StatusCode != 200 || len(places) != 1 || places[0]["label"] != "Testdorf" {
		t.Fatalf("search: %d %+v", res.StatusCode, places)
	}
	res, out := call(t, "GET", ts.URL+"/api/search?q=", nil, nil)
	if res.StatusCode != 400 {
		t.Fatalf("leere Suche: %d %+v", res.StatusCode, out)
	}

	req, _ = http.NewRequest("GET", ts.URL+"/api/roads?bbox=46.99,7.99,47.01,8.01", nil)
	res, _ = http.DefaultClient.Do(req)
	var ways []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&ways)
	if res.StatusCode != 200 || len(ways) != 1 {
		t.Fatalf("roads: %d %+v", res.StatusCode, ways)
	}
	res, _ = call(t, "GET", ts.URL+"/api/roads?bbox=0,0,10,10", nil, nil)
	if res.StatusCode != 400 {
		t.Fatalf("bbox zu gross: %d", res.StatusCode)
	}

	res, err := http.Get(ts.URL + "/tiles/16/34000/23000.png")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(data) != "PNG" || res.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("tile: %d %q %s", res.StatusCode, data, res.Header.Get("Content-Type"))
	}
	res, _ = http.Get(ts.URL + "/tiles/25/0/0.png")
	if res.StatusCode != 404 {
		t.Fatalf("tile zoom 25: %d", res.StatusCode)
	}

	for _, path := range []string{"/", "/d/abcdefghjkmn"} {
		res, _ = http.Get(ts.URL + path)
		data, _ = io.ReadAll(res.Body)
		if res.StatusCode != 200 || !strings.Contains(string(data), "Stadtplaner") {
			t.Fatalf("index %s: %d %q", path, res.StatusCode, data)
		}
	}
	res, _ = http.Get(ts.URL + "/static/css/app.css")
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") == "" {
		t.Fatalf("static: %d", res.StatusCode)
	}
	res, _ = http.Get(ts.URL + "/nope")
	if res.StatusCode != 404 {
		t.Fatalf("unbekannter Pfad: %d", res.StatusCode)
	}
	res, _ = http.Get(ts.URL + "/healthz")
	if res.StatusCode != 200 {
		t.Fatalf("healthz: %d", res.StatusCode)
	}
}
