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
	lastServer.SetLifecycle(Lifecycle{Retention: 365 * 24 * time.Hour, Reminders: []time.Duration{30 * 24 * time.Hour, 7 * 24 * time.Hour}, PublicURL: "https://plan.example.ch/"})
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
	if res.StatusCode != 200 || out["email"] != "" || out["mailEnabled"] != false || out["retentionDays"].(float64) != 365 {
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
	mailer := &fakeMailer{}
	lastServer.lifecycle.Mailer = mailer
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

	// Ohne Aufbewahrung: keine Ablaufangaben
	lastServer.SetLifecycle(Lifecycle{})
	_, out = call(t, "POST", ts.URL+"/api/drafts", map[string]any{"doc": sampleDoc()}, nil)
	_, out = call(t, "GET", ts.URL+"/api/drafts/"+out["id"].(string), nil, nil)
	if out["expiresAt"] != nil || out["retentionDays"].(float64) != 0 {
		t.Fatalf("Ablauf trotz Retention 0: %+v", out)
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
