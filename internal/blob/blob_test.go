package blob

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stadtplaner/internal/blob/blobtest"
)

func exercise(t *testing.T, s Store) {
	t.Helper()
	if _, err := s.Get("drafts/a/meta.json"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("fehlender Schlüssel: %v", err)
	}
	if err := s.Put("drafts/a/meta.json", []byte(`{"id":"a"}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("drafts/a/versions/1.json", []byte("v1")); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("drafts/a/versions/2.json", []byte("v2")); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("drafts/b/meta.json", []byte(`{"id":"b"}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("vapid.json", []byte("k")); err != nil {
		t.Fatal(err)
	}
	data, err := s.Get("drafts/a/meta.json")
	if err != nil || string(data) != `{"id":"a"}` {
		t.Fatalf("Get: %v %q", err, data)
	}
	if err := s.Put("drafts/a/meta.json", []byte(`{"id":"a2"}`)); err != nil {
		t.Fatal(err)
	}
	data, _ = s.Get("drafts/a/meta.json")
	if string(data) != `{"id":"a2"}` {
		t.Fatalf("Überschreiben: %q", data)
	}
	keys, err := s.List("drafts/a/")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(keys, ",") != "drafts/a/meta.json,drafts/a/versions/1.json,drafts/a/versions/2.json" {
		t.Fatalf("List: %v", keys)
	}
	keys, _ = s.List("drafts/a/versions/")
	if len(keys) != 2 {
		t.Fatalf("List Versionen: %v", keys)
	}
	keys, _ = s.List("drafts/")
	if len(keys) != 4 {
		t.Fatalf("List drafts: %v", keys)
	}
	keys, _ = s.List("")
	if len(keys) != 5 {
		t.Fatalf("List alles: %v", keys)
	}
	if err := s.Delete("drafts/a/versions/1.json"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("drafts/a/versions/1.json"); err != nil {
		t.Fatalf("doppeltes Löschen ist kein Fehler: %v", err)
	}
	keys, _ = s.List("drafts/a/")
	if len(keys) != 2 {
		t.Fatalf("nach Delete: %v", keys)
	}
	for _, bad := range []string{"", "/x", "a/../b", "a//b", "./a"} {
		if err := s.Put(bad, []byte("x")); err == nil {
			t.Fatalf("ungültiger Schlüssel %q angenommen", bad)
		}
	}
}

func TestDir(t *testing.T) {
	root := t.TempDir()
	d, err := NewDir(root)
	if err != nil {
		t.Fatal(err)
	}
	exercise(t, d)
	if _, err := os.Stat(filepath.Join(root, "drafts", "a", "meta.json")); err != nil {
		t.Fatalf("Datei liegt nicht im Ordner: %v", err)
	}
	// Leere Ordner verschwinden nach dem Löschen, die Wurzel bleibt
	_ = d.Delete("drafts/a/versions/2.json")
	if _, err := os.Stat(filepath.Join(root, "drafts", "a", "versions")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("leerer Ordner bleibt: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatal("Wurzel gelöscht")
	}
	// Halbe Dateien (.tmp) tauchen in List nicht auf
	_ = os.WriteFile(filepath.Join(root, "drafts", "b", "meta.json.tmp"), []byte("x"), 0o644)
	keys, _ := d.List("drafts/b/")
	if len(keys) != 1 {
		t.Fatalf(".tmp in List: %v", keys)
	}
}

func TestS3(t *testing.T) {
	srv := blobtest.NewServer("stadtplaner", "AKIAEXAMPLE", "geheim/sehr+geheim")
	defer srv.Close()
	srv.MaxKeys = 2 // Seitenweise Listen
	s, err := NewS3(S3Config{Endpoint: srv.URL, Bucket: "stadtplaner", AccessKey: "AKIAEXAMPLE", SecretKey: "geheim/sehr+geheim", Prefix: "app"})
	if err != nil {
		t.Fatal(err)
	}
	exercise(t, s)
	objs := srv.Objects()
	if _, ok := objs["app/drafts/a/meta.json"]; !ok {
		t.Fatalf("Präfix fehlt: %v", keysOf(objs))
	}
	// Falscher Schlüssel: Server lehnt die Signatur ab
	bad, _ := NewS3(S3Config{Endpoint: srv.URL, Bucket: "stadtplaner", AccessKey: "AKIAEXAMPLE", SecretKey: "falsch"})
	if _, err := bad.Get("drafts/a/meta.json"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("falsche Signatur akzeptiert: %v", err)
	}
	// Vorübergehender Fehler wird wiederholt
	srv.Fail = 2
	if data, err := s.Get("drafts/a/meta.json"); err != nil || string(data) != `{"id":"a2"}` {
		t.Fatalf("Wiederholung nach 503: %v %q", err, data)
	}
	srv.Fail = 3
	if _, err := s.Get("drafts/a/meta.json"); err == nil {
		t.Fatal("drei Fehler in Folge müssen scheitern")
	}
	// Sonderzeichen im Schlüssel werden kodiert und kommen zurück
	if err := s.Put("drafts/x/Üb er+1.json", []byte("ü")); err != nil {
		t.Fatal(err)
	}
	if data, err := s.Get("drafts/x/Üb er+1.json"); err != nil || string(data) != "ü" {
		t.Fatalf("Sonderzeichen: %v %q", err, data)
	}
	if _, err := NewS3(S3Config{Bucket: "b"}); err == nil {
		t.Fatal("Konfiguration ohne Endpunkt/Schlüssel angenommen")
	}
}

func TestS3FromEnv(t *testing.T) {
	t.Setenv("S3_BUCKET", "")
	if _, ok := S3FromEnv(); ok {
		t.Fatal("ohne S3_BUCKET kein S3")
	}
	t.Setenv("S3_BUCKET", "stadtplaner")
	t.Setenv("S3_ENDPOINT", "cz41.objects.nineapis.ch")
	t.Setenv("AWS_ACCESS_KEY_ID", "ak")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "sk")
	cfg, ok := S3FromEnv()
	if !ok || cfg.AccessKey != "ak" || cfg.SecretKey != "sk" {
		t.Fatalf("AWS_*-Variablen: %+v", cfg)
	}
	t.Setenv("S3_ACCESS_KEY", "ak2")
	cfg, _ = S3FromEnv()
	if cfg.AccessKey != "ak2" {
		t.Fatal("S3_ACCESS_KEY hat Vorrang")
	}
	s, err := NewS3(cfg)
	if err != nil || s.Endpoint() != "https://cz41.objects.nineapis.ch" || s.cfg.Region != "us-east-1" {
		t.Fatalf("Standardwerte: %v %+v", err, s)
	}
}

func TestURIEncodeAndQuery(t *testing.T) {
	if got := uriEncode("a b/ü~-_.txt", false); got != "a%20b/%C3%BC~-_.txt" {
		t.Fatalf("uriEncode: %s", got)
	}
	if got := uriEncode("a/b", true); got != "a%2Fb" {
		t.Fatalf("uriEncode Slash: %s", got)
	}
	q := map[string][]string{"prefix": {"drafts/a b"}, "list-type": {"2"}}
	if got := canonicalQueryString(q); got != "list-type=2&prefix=drafts%2Fa%20b" {
		t.Fatalf("Query: %s", got)
	}
}

func keysOf(m map[string][]byte) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
