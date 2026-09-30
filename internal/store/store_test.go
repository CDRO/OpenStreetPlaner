package store

import (
	"errors"
	"testing"

	"stadtplaner/internal/model"
)

func doc(name string) *model.Document {
	d := &model.Document{Name: name}
	_ = model.Normalize(d)
	return d
}

func TestCreateGetSaveDelete(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	id, token, err := s.Create(doc("A"), "Erste Version")
	if err != nil {
		t.Fatal(err)
	}
	if !ValidID(id) || len(token) != 48 {
		t.Fatalf("ID/Token unerwartet: %q %q", id, token)
	}
	got, meta, err := s.Get(id)
	if err != nil || got.Name != "A" || got.ID != id || meta.TokenHash != "" || len(meta.Versions) != 1 {
		t.Fatalf("Get: %v %+v %+v", err, got, meta)
	}
	d2 := doc("B")
	d2.Features = append(d2.Features, model.Feature{ID: "j1", Type: "junction", LayerID: d2.Layers[0].ID, At: &model.LatLng{1, 1}})
	if _, err := s.Save(id, "falsch", d2, "x"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("falsches Token akzeptiert: %v", err)
	}
	if _, err := s.Save(id, "", d2, "x"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("leeres Token akzeptiert: %v", err)
	}
	meta, err = s.Save(id, token, d2, "Kreuzung dazu")
	if err != nil || meta.Name != "B" || len(meta.Versions) != 2 {
		t.Fatalf("Save: %v %+v", err, meta)
	}
	got, _, _ = s.Get(id)
	if len(got.Features) != 1 || got.CreatedAt == "" {
		t.Fatalf("gespeicherter Stand falsch: %+v", got)
	}
	versions, _ := s.Versions(id)
	if len(versions) != 2 || versions[0].N != 2 || versions[0].Label != "Kreuzung dazu" || versions[0].Stats.Junctions != 1 {
		t.Fatalf("Versionen: %+v", versions)
	}
	old, info, err := s.Version(id, 1)
	if err != nil || old.Name != "A" || info.Label != "Erste Version" {
		t.Fatalf("Version 1: %v %+v %+v", err, old, info)
	}
	if _, _, err := s.Version(id, 9); !errors.Is(err, ErrNotFound) {
		t.Fatalf("fehlende Version: %v", err)
	}
	if err := s.Delete(id, "nope"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Delete ohne Token: %v", err)
	}
	if err := s.Delete(id, token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nach Delete: %v", err)
	}
}

func TestVersionsArePruned(t *testing.T) {
	s, _ := Open(t.TempDir())
	s.SetMaxVersions(3)
	id, token, _ := s.Create(doc("A"), "1")
	for i := 0; i < 5; i++ {
		if _, err := s.Save(id, token, doc("A"), "x"); err != nil {
			t.Fatal(err)
		}
	}
	versions, _ := s.Versions(id)
	if len(versions) != 3 || versions[0].N != 6 || versions[2].N != 4 {
		t.Fatalf("nicht auf 3 begrenzt: %+v", versions)
	}
	if _, _, err := s.Version(id, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("alte Version noch lesbar: %v", err)
	}
}

func TestForkAndInvalidIDs(t *testing.T) {
	s, _ := Open(t.TempDir())
	id, _, _ := s.Create(doc("Original"), "1")
	fid, ftoken, err := s.Fork(id, "Kopie")
	if err != nil || fid == id || ftoken == "" {
		t.Fatalf("Fork: %v", err)
	}
	got, _, _ := s.Get(fid)
	if got.Name != "Kopie" || got.ID != fid {
		t.Fatalf("Fork-Inhalt: %+v", got)
	}
	if _, _, err := s.Get("../../etc/passwd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Pfad-Trick nicht abgewiesen: %v", err)
	}
	if _, _, err := s.Get("doesnotexist1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannt: %v", err)
	}
	if err := s.Authorize(fid, ftoken); err != nil {
		t.Fatalf("Authorize: %v", err)
	}
}

func TestComments(t *testing.T) {
	s, _ := Open(t.TempDir())
	id, editToken, _ := s.Create(doc("A"), "1")
	list, err := s.Comments(id)
	if err != nil || len(list) != 0 {
		t.Fatalf("leer erwartet: %v %+v", err, list)
	}
	c, ctoken, err := s.AddComment(id, Comment{Lat: 47, Lng: 8, Author: "  Anna ", Text: " Hier fehlt ein Fussgängerstreifen "})
	if err != nil || c.ID == "" || ctoken == "" || c.Author != "Anna" || c.TokenHash != "" {
		t.Fatalf("AddComment: %v %+v", err, c)
	}
	c2, _, _ := s.AddComment(id, Comment{Lat: 47, Lng: 8, Text: "zweiter"})
	if c2.Author != "Anonym" {
		t.Fatalf("Anonym erwartet: %+v", c2)
	}
	if _, _, err := s.AddComment(id, Comment{Lat: 47, Lng: 8, Text: "   "}); !errors.Is(err, ErrBadComment) {
		t.Fatalf("leerer Text akzeptiert: %v", err)
	}
	if _, _, err := s.AddComment(id, Comment{Lat: 99, Lng: 8, Text: "x"}); !errors.Is(err, ErrBadComment) {
		t.Fatalf("ungültige Position akzeptiert: %v", err)
	}
	if _, _, err := s.AddComment("doesnotexist1", Comment{Lat: 1, Lng: 1, Text: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannter Entwurf: %v", err)
	}
	list, _ = s.Comments(id)
	if len(list) != 2 || list[0].TokenHash != "" {
		t.Fatalf("Liste: %+v", list)
	}
	if err := s.ResolveComment(id, c.ID, "", "falsch", true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Fremdes Token akzeptiert: %v", err)
	}
	if err := s.ResolveComment(id, c.ID, "", ctoken, true); err != nil {
		t.Fatalf("Verfasser darf erledigen: %v", err)
	}
	list, _ = s.Comments(id)
	if !list[0].Resolved {
		t.Fatalf("nicht erledigt: %+v", list[0])
	}
	if err := s.DeleteComment(id, c2.ID, editToken, ""); err != nil {
		t.Fatalf("Besitzer darf löschen: %v", err)
	}
	if err := s.DeleteComment(id, c2.ID, editToken, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("doppelt löschen: %v", err)
	}
	list, _ = s.Comments(id)
	if len(list) != 1 {
		t.Fatalf("nach Löschen: %+v", list)
	}
	fid, _, _ := s.Fork(id, "Kopie")
	flist, _ := s.Comments(fid)
	if len(flist) != 0 {
		t.Fatalf("Fork darf keine Kommentare kopieren")
	}
}
