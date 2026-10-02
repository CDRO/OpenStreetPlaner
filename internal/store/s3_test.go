package store

import (
	"errors"
	"strings"
	"testing"

	"stadtplaner/internal/blob"
	"stadtplaner/internal/blob/blobtest"
	"stadtplaner/internal/model"
	"stadtplaner/internal/push"
)

// Der ganze Lebenszyklus eines Entwurfs auf einem (nachgebauten) S3-Bucket: dieselben
// Schlüssel wie im Ordner, Versionen werden beschnitten, Löschen räumt alle Objekte weg.
func TestStoreOnS3(t *testing.T) {
	srv := blobtest.NewServer("stadtplaner", "ak", "sk")
	defer srv.Close()
	srv.MaxKeys = 2
	b, err := blob.NewS3(blob.S3Config{Endpoint: srv.URL, Bucket: "stadtplaner", AccessKey: "ak", SecretKey: "sk", Prefix: "prod"})
	if err != nil {
		t.Fatal(err)
	}
	s := New(b)
	s.SetMaxVersions(2)
	id, token, err := s.Create(doc("A"), "Erste Version")
	if err != nil {
		t.Fatal(err)
	}
	objs := srv.Objects()
	for _, want := range []string{"prod/drafts/" + id + "/meta.json", "prod/drafts/" + id + "/current.json", "prod/drafts/" + id + "/versions/1.json"} {
		if _, ok := objs[want]; !ok {
			t.Fatalf("Objekt %s fehlt: %v", want, keys(objs))
		}
	}
	got, meta, err := s.Get(id)
	if err != nil || got.Name != "A" || meta.TokenHash != "" {
		t.Fatalf("Get: %v %+v", err, meta)
	}
	if err := s.Authorize(id, token); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"B", "C"} {
		d := doc(name)
		d.Features = append(d.Features, model.Feature{ID: "j1", Type: "junction", LayerID: d.Layers[0].ID, At: &model.LatLng{1, 1}})
		if _, err := s.Save(id, token, d, name); err != nil {
			t.Fatal(err)
		}
	}
	vs, _ := s.Versions(id)
	if len(vs) != 2 || vs[0].N != 3 || vs[1].N != 2 {
		t.Fatalf("Versionen beschnitten: %+v", vs)
	}
	if _, ok := srv.Objects()["prod/drafts/"+id+"/versions/1.json"]; ok {
		t.Fatal("alte Version nicht gelöscht")
	}
	if _, _, err := s.Version(id, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Version 1: %v", err)
	}
	if d3, info, err := s.Version(id, 3); err != nil || d3.Name != "C" || info.Label != "C" {
		t.Fatalf("Version 3: %v %+v", err, info)
	}
	// Kommentare und Push-Abonnements liegen im selben Präfix
	c, ctoken, _, err := s.AddComment(id, Comment{Lat: 47, Lng: 8, Author: "Tizian", Text: "Hallo"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetPushSub(id, PushSub{ClientID: "c1", Endpoint: "https://push.example/1", Role: "all"}); err != nil {
		t.Fatal(err)
	}
	list, _ := s.Comments(id)
	subs, _ := s.PushSubs(id)
	if len(list) != 1 || len(subs) != 1 {
		t.Fatalf("Kommentare/Abos: %d %d", len(list), len(subs))
	}
	if err := s.DeleteComment(id, c.ID, "", ctoken); err != nil {
		t.Fatal(err)
	}
	// Kopie, dann alles löschen: keine Objekte unter dem Entwurf übrig
	fid, _, err := s.Fork(id, "Kopie")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(id, token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nach Löschen: %v", err)
	}
	for k := range srv.Objects() {
		if strings.HasPrefix(k, "prod/drafts/"+id+"/") {
			t.Fatalf("Rest nach Löschen: %s", k)
		}
	}
	if fd, _, err := s.Get(fid); err != nil || fd.Name != "Kopie" {
		t.Fatalf("Kopie: %v", err)
	}
	// VAPID-Schlüssel wandern mit in den Bucket und bleiben beim zweiten Start gleich
	k1, err := push.LoadOrCreateKeysFrom(b, "vapid.json")
	if err != nil {
		t.Fatal(err)
	}
	k2, _ := push.LoadOrCreateKeysFrom(b, "vapid.json")
	if k1.PublicKey == "" || k1 != k2 {
		t.Fatalf("Schlüssel nicht stabil: %+v %+v", k1, k2)
	}
	if _, ok := srv.Objects()["prod/vapid.json"]; !ok {
		t.Fatal("vapid.json nicht im Bucket")
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
