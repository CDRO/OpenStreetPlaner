package server

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"stadtplaner/internal/osm"
	"stadtplaner/internal/push"
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
		"web/sw.js":       {Data: []byte("self.addEventListener('push', () => {});")},
	}
	client := osm.New(t.TempDir())
	s, err := New(st, client, web, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	lastServer = s
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, client
}

var lastServer *Server

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
	client.SetSources([]osm.TileSource{{ID: "alt", Label: "Alt", URL: up.URL + "/alt/{z}/{x}/{y}.png", MaxZoom: 19, Ext: "png"}})
	res, _ = http.Get(ts.URL + "/tiles/alt/16/34000/23001.png")
	data, _ = io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(data) != "PNG" {
		t.Fatalf("benannte Quelle: %d %q", res.StatusCode, data)
	}
	res, _ = http.Get(ts.URL + "/tiles/nope/16/1/1.png")
	if res.StatusCode != 404 {
		t.Fatalf("unbekannte Quelle: %d", res.StatusCode)
	}
	req, _ = http.NewRequest("GET", ts.URL+"/api/tiles/sources", nil)
	res, _ = http.DefaultClient.Do(req)
	var sources []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&sources)
	if len(sources) != 1 || sources[0]["id"] != "alt" || sources[0]["url"] != nil {
		t.Fatalf("Quellenliste: %+v", sources)
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

func TestCommentsAPIAndRateLimit(t *testing.T) {
	ts, _ := newTestServer(t)
	res, out := call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	if res.StatusCode != 201 {
		t.Fatalf("create: %d %+v", res.StatusCode, out)
	}
	id := out["id"].(string)
	editToken := out["editToken"].(string)

	res, out = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"lat": 47, "lng": 8, "author": "Anna", "text": "Hier bitte Tempo 30"}, nil)
	if res.StatusCode != 201 || out["commentToken"] == nil {
		t.Fatalf("addComment: %d %+v", res.StatusCode, out)
	}
	comment := out["comment"].(map[string]any)
	cid := comment["id"].(string)
	ctoken := out["commentToken"].(string)
	if _, has := comment["tokenHash"]; has {
		t.Fatalf("tokenHash darf nicht ausgeliefert werden: %+v", comment)
	}
	res, out = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"lat": 47, "lng": 8, "text": ""}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("leerer Kommentar: %d %+v", res.StatusCode, out)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/drafts/"+id+"/comments", nil)
	lres, _ := http.DefaultClient.Do(req)
	var list []map[string]any
	_ = json.NewDecoder(lres.Body).Decode(&list)
	if len(list) != 1 || list[0]["author"] != "Anna" {
		t.Fatalf("list: %+v", list)
	}
	res, _ = call(t, "PATCH", ts.URL+"/api/drafts/"+id+"/comments/"+cid, map[string]any{"resolved": true}, nil)
	if res.StatusCode != 403 {
		t.Fatalf("resolve ohne Token: %d", res.StatusCode)
	}
	res, _ = call(t, "PATCH", ts.URL+"/api/drafts/"+id+"/comments/"+cid, map[string]any{"resolved": true}, map[string]string{"X-Comment-Token": ctoken})
	if res.StatusCode != 204 {
		t.Fatalf("resolve mit Kommentar-Token: %d", res.StatusCode)
	}
	res, _ = call(t, "DELETE", ts.URL+"/api/drafts/"+id+"/comments/"+cid, nil, map[string]string{"X-Edit-Token": editToken})
	if res.StatusCode != 204 {
		t.Fatalf("delete als Besitzer: %d", res.StatusCode)
	}
	res, _ = call(t, "DELETE", ts.URL+"/api/drafts/"+id+"/comments/"+cid, nil, map[string]string{"X-Edit-Token": editToken})
	if res.StatusCode != 404 {
		t.Fatalf("delete doppelt: %d", res.StatusCode)
	}

	// Drosselung: 3 Schreibzugriffe pro Minute, Burst 2
	st, _ := store.Open(t.TempDir())
	web := fstest.MapFS{"web/index.html": {Data: []byte("<title>Stadtplaner</title>")}}
	srv, _ := New(st, osm.New(t.TempDir()), web, log.New(io.Discard, "", 0))
	srv.SetRateLimit(RateLimit{PerMinute: 3, Burst: 2})
	lts := httptest.NewServer(srv.Handler())
	defer lts.Close()
	codes := []int{}
	for i := 0; i < 3; i++ {
		r, _ := call(t, "POST", lts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
		codes = append(codes, r.StatusCode)
	}
	if codes[0] != 201 || codes[1] != 201 || codes[2] != 429 {
		t.Fatalf("Drosselung: %v", codes)
	}
	r, _ := http.Get(lts.URL + "/healthz")
	if r.StatusCode != 200 {
		t.Fatalf("GET wird nicht gedrosselt: %d", r.StatusCode)
	}
}

func TestRepliesAndPushNotifications(t *testing.T) {
	ts, _ := newTestServer(t)
	srv := lastServer
	keys, _ := push.GenerateKeys()
	sender := push.NewSender(keys, "mailto:test@example.org")
	srv.SetPush(sender)

	// Fake-Push-Dienst zählt Zustellungen und entschlüsselt sie
	uaPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := []byte("0123456789abcdef")
	var mu sync.Mutex
	var delivered []string
	svc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(r.Body)
		plain, err := push.Decrypt(buf, uaPriv, auth)
		if err != nil {
			t.Errorf("Entschlüsseln: %v", err)
		}
		mu.Lock()
		delivered = append(delivered, r.URL.Path+" "+string(plain))
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/gone") {
			w.WriteHeader(410)
			return
		}
		w.WriteHeader(201)
	}))
	defer svc.Close()
	b64 := base64.RawURLEncoding
	subJSON := func(endpoint string) map[string]any {
		return map[string]any{"endpoint": endpoint, "keys": map[string]string{"p256dh": b64.EncodeToString(uaPriv.PublicKey().Bytes()), "auth": b64.EncodeToString(auth)}}
	}

	res, out := call(t, "GET", ts.URL+"/api/push/key", nil, nil)
	if res.StatusCode != 200 || out["enabled"] != true || out["publicKey"] != keys.PublicKey {
		t.Fatalf("push key: %d %+v", res.StatusCode, out)
	}
	res, _ = http.Get(ts.URL + "/sw.js")
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("sw.js: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}

	_, out = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	id := out["id"].(string)
	editToken := out["editToken"].(string)

	// Besitzer abonniert alles (braucht Edit-Token), Anna nur Antworten auf ihre Kommentare
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "owner", "subscription": subJSON(svc.URL + "/owner"), "role": "all"}, nil)
	if res.StatusCode != 403 {
		t.Fatalf("Rolle all ohne Token: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "owner", "subscription": subJSON(svc.URL + "/owner"), "role": "all"}, map[string]string{"X-Edit-Token": editToken})
	if res.StatusCode != 200 || out["role"] != "all" {
		t.Fatalf("Besitzer-Abo: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "anna", "subscription": map[string]any{"endpoint": "x"}, "role": "replies"}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("kaputtes Abo: %d", res.StatusCode)
	}

	// Anna kommentiert: nur der Besitzer wird benachrichtigt
	res, out = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"lat": 47, "lng": 8, "author": "Anna", "text": "Frage?", "clientId": "anna"}, nil)
	if res.StatusCode != 201 {
		t.Fatalf("Kommentar: %d %+v", res.StatusCode, out)
	}
	annaComment := out["comment"].(map[string]any)["id"].(string)
	srv.WaitPush()
	mu.Lock()
	n := len(delivered)
	mu.Unlock()
	if n != 1 || !strings.Contains(delivered[0], "/owner ") || !strings.Contains(delivered[0], "Neuer Kommentar") || !strings.Contains(delivered[0], "#comment="+annaComment) {
		t.Fatalf("Besitzer-Benachrichtigung: %+v", delivered)
	}

	// Anna abonniert Antworten auf ihren Kommentar; Besitzer antwortet -> Anna bekommt Push, Besitzer (Verfasser) nicht
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "anna", "subscription": subJSON(svc.URL + "/anna"), "role": "all", "threads": []string{annaComment}}, nil)
	if res.StatusCode != 403 {
		t.Fatalf("Anna darf nicht alles abonnieren: %d", res.StatusCode)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "anna", "subscription": subJSON(svc.URL + "/anna"), "role": "replies", "threads": []string{annaComment}}, nil)
	if res.StatusCode != 200 || out["role"] != "replies" {
		t.Fatalf("Anna-Abo: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"parentId": annaComment, "author": "Gemeinde", "text": "Antwort", "clientId": "owner"}, nil)
	if res.StatusCode != 201 || out["comment"].(map[string]any)["parentId"] != annaComment {
		t.Fatalf("Antwort: %d %+v", res.StatusCode, out)
	}
	srv.WaitPush()
	mu.Lock()
	n = len(delivered)
	last := delivered[len(delivered)-1]
	mu.Unlock()
	if n != 2 || !strings.Contains(last, "/anna ") || !strings.Contains(last, "Antwort zu") {
		t.Fatalf("Antwort-Benachrichtigung: %+v", delivered)
	}

	// Antwort auf eine Antwort ist nicht erlaubt
	replyID := out["comment"].(map[string]any)["id"].(string)
	res, _ = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"parentId": replyID, "text": "verschachtelt"}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("verschachtelte Antwort: %d", res.StatusCode)
	}

	// Abgelaufenes Abo (410) wird entfernt
	_, _ = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/push", map[string]any{"clientId": "old", "subscription": subJSON(svc.URL + "/gone"), "role": "all"}, map[string]string{"X-Edit-Token": editToken})
	_, _ = call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"lat": 47, "lng": 8, "text": "noch einer", "clientId": "someone"}, nil)
	srv.WaitPush()
	subs, _ := srv.store.PushSubs(id)
	for _, sub := range subs {
		if sub.ClientID == "old" {
			t.Fatalf("410-Abo nicht entfernt: %+v", subs)
		}
	}
	res, _ = call(t, "DELETE", ts.URL+"/api/drafts/"+id+"/push?clientId=owner", nil, nil)
	if res.StatusCode != 204 {
		t.Fatalf("Abo löschen: %d", res.StatusCode)
	}
	subs, _ = srv.store.PushSubs(id)
	if len(subs) != 1 || subs[0].ClientID != "anna" {
		t.Fatalf("nach Löschen: %+v", subs)
	}
}
