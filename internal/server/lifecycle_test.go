package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"stadtplaner/internal/store"
)

type fakeMailer struct {
	mu   sync.Mutex
	sent []string
}

func (f *fakeMailer) Send(to, subject, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, to+"|"+subject+"|"+body)
	return nil
}

func TestReminderEndpoints(t *testing.T) {
	ts, _ := newTestServer(t)
	mailer := &fakeMailer{}
	lastServer.SetLifecycle(Lifecycle{Retention: 365 * 24 * time.Hour, Reminders: []time.Duration{30 * 24 * time.Hour, 7 * 24 * time.Hour}, PublicURL: "https://plan.example.ch/", Mailer: mailer})
	_, out := call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	id := out["id"].(string)
	token := out["editToken"].(string)
	auth := map[string]string{"X-Edit-Token": token}

	res, out := call(t, "GET", ts.URL+"/api/drafts/"+id, nil, nil)
	if res.StatusCode != 200 || out["retentionDays"].(float64) != 365 || out["expiresAt"] == nil {
		t.Fatalf("Ablauf fehlt in GET: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "GET", ts.URL+"/api/drafts/"+id+"/reminder", nil, nil)
	if res.StatusCode != 403 {
		t.Fatalf("Reminder ohne Token: %d", res.StatusCode)
	}
	res, out = call(t, "GET", ts.URL+"/api/drafts/"+id+"/reminder", nil, auth)
	if res.StatusCode != 200 || out["email"] != "" || out["mailEnabled"] != true || out["retentionDays"].(float64) != 365 {
		t.Fatalf("Reminder leer: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/reminder", map[string]any{"email": "nicht-gueltig"}, auth)
	if res.StatusCode != 400 {
		t.Fatalf("ungültige Adresse: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/reminder", map[string]any{"email": "Anna@Example.ch"}, auth)
	if res.StatusCode != 200 || out["email"] != "anna@example.ch" {
		t.Fatalf("Adresse setzen: %d %+v", res.StatusCode, out)
	}
	res, _ = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/reminder", map[string]any{"email": "x@y.ch"}, map[string]string{"X-Edit-Token": "falsch"})
	if res.StatusCode != 403 {
		t.Fatalf("fremdes Token: %d", res.StatusCode)
	}
	res, _ = call(t, "PUT", ts.URL+"/api/drafts/"+id+"/reminder", "{kein json", auth)
	if res.StatusCode != 400 {
		t.Fatalf("kaputtes JSON: %d", res.StatusCode)
	}

	// Aufräum-Lauf: Entwurf künstlich altern lassen, dann muss eine Mail mit Link rausgehen
	ageDraft(t, lastServer.store, id, 340)
	resSweep := lastServer.Sweep(time.Now())
	if len(resSweep.Reminded) != 1 || len(mailer.sent) != 1 {
		t.Fatalf("Sweep: %+v %v", resSweep, mailer.sent)
	}
	msg := mailer.sent[0]
	if !strings.HasPrefix(msg, "anna@example.ch|") || !strings.Contains(msg, "https://plan.example.ch/d/"+id) || !strings.Contains(msg, "Hauptstrasse neu") || !strings.Contains(msg, "Sicherung herunterladen") {
		t.Fatalf("Mail: %s", msg)
	}
	if !strings.Contains(msg, "in 25 Tagen") {
		t.Fatalf("Resttage fehlen: %s", msg)
	}
	ageDraft(t, lastServer.store, id, 400)
	resSweep = lastServer.Sweep(time.Now())
	if len(resSweep.Deleted) != 1 {
		t.Fatalf("Löschen: %+v", resSweep)
	}
	if res, _ := call(t, "GET", ts.URL+"/api/drafts/"+id, nil, nil); res.StatusCode != 404 {
		t.Fatalf("nach Löschen: %d", res.StatusCode)
	}

	// Ohne SMTP: Adresse wird nicht angenommen (die Oberfläche bietet das Feld dann gar nicht an), leer geht
	lastServer.SetLifecycle(Lifecycle{Retention: 365 * 24 * time.Hour})
	_, out = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	id2, auth2 := out["id"].(string), map[string]string{"X-Edit-Token": out["editToken"].(string)}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id2+"/reminder", map[string]any{"email": "x@y.ch"}, auth2)
	if res.StatusCode != 400 || out["error"] != ErrMailDisabled.Error() {
		t.Fatalf("Adresse ohne SMTP angenommen: %d %+v", res.StatusCode, out)
	}
	res, out = call(t, "PUT", ts.URL+"/api/drafts/"+id2+"/reminder", map[string]any{"email": ""}, auth2)
	if res.StatusCode != 200 || out["mailEnabled"] != false {
		t.Fatalf("leere Adresse ohne SMTP: %d %+v", res.StatusCode, out)
	}

	// Ohne Aufbewahrung: keine Ablaufangaben, und ein Mailer bleibt ohne Wirkung
	lastServer.SetLifecycle(Lifecycle{Mailer: mailer})
	_, out = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	_, out = call(t, "GET", ts.URL+"/api/drafts/"+out["id"].(string), nil, nil)
	if out["expiresAt"] != nil || out["retentionDays"].(float64) != 0 {
		t.Fatalf("Ablauf trotz Retention 0: %+v", out)
	}
	if lastServer.lifecycle.Mailer != nil {
		t.Fatalf("Mailer ohne Aufbewahrung muss aus sein")
	}
}

// Die Oberfläche bietet die E-Mail-Erinnerung nur an, wenn der Server sie kann: die Konfiguration
// steht fest in der Startseite, und die Schalen-Version wechselt mit ihr (kein veraltetes 304).
func TestServerConfigInPage(t *testing.T) {
	ts, _ := newTestServer(t)
	page := func() (string, string) {
		res, err := http.Get(ts.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return string(body), res.Header.Get("ETag")
	}
	body, etag := page()
	if !strings.Contains(body, `name="stadtplaner-config" content="{&#34;mail&#34;:false,&#34;retentionDays&#34;:0}"`) || strings.Contains(body, "__CONFIG__") {
		t.Fatalf("Standard-Konfiguration fehlt: %s", body)
	}
	lastServer.SetLifecycle(Lifecycle{Retention: 365 * 24 * time.Hour, Mailer: &fakeMailer{}})
	body2, etag2 := page()
	if !strings.Contains(body2, `content="{&#34;mail&#34;:true,&#34;retentionDays&#34;:365}"`) {
		t.Fatalf("Konfiguration nicht eingesetzt: %s", body2)
	}
	if etag2 == etag || etag2 == "" {
		t.Fatalf("ETag muss mit der Konfiguration wechseln: %q %q", etag, etag2)
	}
	_, shell := call(t, "GET", ts.URL+"/api/shell", nil, nil)
	if `"`+shell["version"].(string)+`"` != etag2 {
		t.Fatalf("Schalen-Version %v passt nicht zum ETag %q", shell["version"], etag2)
	}
	res, err := http.Get(ts.URL + "/sw.js")
	if err != nil {
		t.Fatal(err)
	}
	sw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(sw), shell["version"].(string)) {
		t.Fatalf("Service Worker trägt nicht die neue Version")
	}
	lastServer.SetLifecycle(Lifecycle{Retention: 365 * 24 * time.Hour})
	if body3, _ := page(); !strings.Contains(body3, `&#34;mail&#34;:false`) {
		t.Fatalf("ohne Mailer muss mail=false stehen: %s", body3)
	}
}

func ageDraft(t *testing.T, st *store.Store, id string, days int) {
	t.Helper()
	// Metadaten direkt im Blob-Store zurückdatieren
	data, err := st.Blobs().Get("drafts/" + id + "/meta.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	m["updatedAt"] = time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339Nano)
	data, _ = json.Marshal(m)
	if err := st.Blobs().Put("drafts/"+id+"/meta.json", data); err != nil {
		t.Fatal(err)
	}
}

func TestBackupDownloadAndImport(t *testing.T) {
	ts, _ := newTestServer(t)
	_, out := call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	id := out["id"].(string)
	token := out["editToken"].(string)
	doc := sampleDoc()
	doc["name"] = "Quartier/Plan: «Ost»"
	if res, _ := call(t, "PUT", ts.URL+"/api/drafts/"+id, map[string]any{"doc": doc, "label": "Umbenannt"}, map[string]string{"X-Edit-Token": token}); res.StatusCode != 200 {
		t.Fatalf("save: %d", res.StatusCode)
	}
	if res, _ := call(t, "POST", ts.URL+"/api/drafts/"+id+"/comments", map[string]any{"lat": 47, "lng": 8, "author": "Anna", "text": "Hinweis"}, nil); res.StatusCode != 201 {
		t.Fatalf("comment: %d", res.StatusCode)
	}

	res, err := http.Get(ts.URL + "/api/drafts/" + id + "/backup")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	cd := res.Header.Get("Content-Disposition")
	if res.StatusCode != 200 || !strings.HasPrefix(cd, "attachment;") || !strings.Contains(cd, ".stadtplaner-backup.json") || strings.Contains(cd, "/") {
		t.Fatalf("backup: %d %q", res.StatusCode, cd)
	}
	var b store.Backup
	if err := json.Unmarshal(data, &b); err != nil || b.Format != store.BackupFormat || len(b.Versions) != 2 || len(b.Comments) != 1 || b.Doc.Name != "Quartier/Plan: «Ost»" {
		t.Fatalf("Sicherung: %v %+v", err, b)
	}
	if res, _ := call(t, "GET", ts.URL+"/api/drafts/doesnotexist1/backup", nil, nil); res.StatusCode != 404 {
		t.Fatalf("unbekannt: %d", res.StatusCode)
	}

	res, out = call(t, "POST", ts.URL+"/api/drafts/import", string(data), nil)
	if res.StatusCode != 201 || out["id"] == id || out["editToken"] == nil || out["versionCount"].(float64) != 3 || out["name"] != "Quartier/Plan: «Ost»" {
		t.Fatalf("import: %d %+v", res.StatusCode, out)
	}
	nid := out["id"].(string)
	_, versions := callList(t, ts.URL+"/api/drafts/"+nid+"/versions")
	if len(versions) != 3 || versions[0]["label"] != "Aus Sicherung eingespielt" || versions[2]["label"] != "Erste Version" {
		t.Fatalf("Versionen: %+v", versions)
	}
	_, comments := callList(t, ts.URL+"/api/drafts/"+nid+"/comments")
	if len(comments) != 1 || comments[0]["author"] != "Anna" {
		t.Fatalf("Kommentare: %+v", comments)
	}
	for _, bad := range []string{"{kein json", `{"format":"x"}`, `{"format":"stadtplaner-backup"}`, `{"format":"stadtplaner-backup","doc":{"name":"A","features":[{"id":"x","type":"unbekannt"}]}}`} {
		res, out := call(t, "POST", ts.URL+"/api/drafts/import", bad, nil)
		if res.StatusCode != 400 {
			t.Fatalf("%s akzeptiert: %d %+v", bad, res.StatusCode, out)
		}
	}
}

func callList(t *testing.T, url string) (*http.Response, []map[string]any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var out []map[string]any
	_ = json.Unmarshal(data, &out)
	return res, out
}
