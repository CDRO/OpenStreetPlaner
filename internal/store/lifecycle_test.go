package store

import (
	"errors"
	"testing"
	"time"

	"stadtplaner/internal/model"
)

func TestListAndReminder(t *testing.T) {
	s, _ := Open(t.TempDir())
	id, token, _ := s.Create(doc("A"), "1")
	id2, _, _ := s.Create(doc("B"), "1")
	list, err := s.List()
	if err != nil || len(list) != 2 || list[0].TokenHash != "" {
		t.Fatalf("List: %v %+v", err, list)
	}
	if _, err := s.SetReminder(id, "falsch", "a@b.ch"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("fremdes Token: %v", err)
	}
	for _, bad := range []string{"kein-mail", "a@b", "a b@c.ch", "@c.ch"} {
		if _, err := s.SetReminder(id, token, bad); !errors.Is(err, ErrBadEmail) {
			t.Fatalf("%q akzeptiert: %v", bad, err)
		}
	}
	m, err := s.SetReminder(id, token, "  Anna@Example.CH ")
	if err != nil || m.Email != "anna@example.ch" || m.TokenHash != "" {
		t.Fatalf("SetReminder: %v %+v", err, m)
	}
	m, err = s.Reminder(id, token)
	if err != nil || m.Email != "anna@example.ch" {
		t.Fatalf("Reminder: %v %+v", err, m)
	}
	if _, err := s.Reminder(id, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Reminder ohne Token: %v", err)
	}
	// Get verrät die Adresse nicht
	if _, meta, _ := s.Get(id); meta.Email != "" {
		t.Fatalf("Get gibt die Adresse preis: %+v", meta)
	}
	if m, _ := s.SetReminder(id, token, ""); m.Email != "" {
		t.Fatalf("Entfernen: %+v", m)
	}
	_ = id2
}

func TestSweepDeletesAndReminds(t *testing.T) {
	s, _ := Open(t.TempDir())
	old, oldToken, _ := s.Create(doc("Alt"), "1")
	fresh, freshToken, _ := s.Create(doc("Neu"), "1")
	silent, _, _ := s.Create(doc("Ohne Mail"), "1")
	if _, err := s.SetReminder(old, oldToken, "alt@example.ch"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetReminder(fresh, freshToken, "neu@example.ch"); err != nil {
		t.Fatal(err)
	}
	// "Alt" künstlich 400 Tage alt machen, "Neu" 340 Tage (30-Tage-Frist greift, 7-Tage noch nicht)
	age := func(id string, days int) {
		m, _ := s.readMeta(id)
		m.UpdatedAt = time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
		_ = s.writeJSON(s.draftKey(id, "meta.json"), m)
	}
	age(old, 400)
	age(fresh, 340)
	age(silent, 340)
	var sent []string
	notify := func(m *Meta, expires time.Time) error {
		sent = append(sent, m.ID+"->"+m.Email)
		if days := int(time.Until(expires).Hours() / 24); days < 24 || days > 26 {
			t.Errorf("Ablauf in %d Tagen, erwartet 25", days)
		}
		return nil
	}
	retention := 365 * 24 * time.Hour
	reminders := []time.Duration{30 * 24 * time.Hour, 7 * 24 * time.Hour}
	res := s.Sweep(time.Now(), retention, reminders, notify)
	if res.Scanned != 3 || len(res.Deleted) != 1 || res.Deleted[0] != old || len(res.Errors) != 0 {
		t.Fatalf("Sweep: %+v", res)
	}
	if len(sent) != 1 || sent[0] != fresh+"->neu@example.ch" || len(res.Reminded) != 1 || res.Reminded[0] != fresh+":30d" {
		t.Fatalf("Erinnerungen: %v %+v", sent, res.Reminded)
	}
	if _, _, err := s.Get(old); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Alt nicht gelöscht: %v", err)
	}
	// Zweiter Lauf: nichts Neues
	res = s.Sweep(time.Now(), retention, reminders, notify)
	if len(sent) != 1 || len(res.Reminded) != 0 || len(res.Deleted) != 0 {
		t.Fatalf("doppelt erinnert: %v %+v", sent, res)
	}
	// 7-Tage-Frist erreicht: zweite Erinnerung
	age(fresh, 360)
	m, _ := s.readMeta(fresh)
	m.Reminded = map[string]time.Time{"30d": time.Now().UTC().Add(-19 * 24 * time.Hour)}
	_ = s.writeJSON(s.draftKey(fresh, "meta.json"), m)
	res = s.Sweep(time.Now(), retention, reminders, func(m *Meta, expires time.Time) error {
		sent = append(sent, m.ID)
		return nil
	})
	if len(sent) != 2 || len(res.Reminded) != 1 || res.Reminded[0] != fresh+":7d" {
		t.Fatalf("7-Tage-Erinnerung: %v %+v", sent, res.Reminded)
	}
	// Neu speichern setzt die Frist und die Erinnerungen zurück
	if _, err := s.Save(fresh, freshToken, doc("Neu"), "x"); err != nil {
		t.Fatal(err)
	}
	m, _ = s.readMeta(fresh)
	if len(m.Reminded) != 0 || m.Email != "neu@example.ch" {
		t.Fatalf("nach Speichern: %+v", m)
	}
	res = s.Sweep(time.Now(), retention, reminders, notify)
	if len(res.Reminded) != 0 || len(res.Deleted) != 0 {
		t.Fatalf("frischer Entwurf angefasst: %+v", res)
	}
	// Fehler beim Versand: nicht als erinnert vermerken
	age(fresh, 340)
	res = s.Sweep(time.Now(), retention, reminders, func(*Meta, time.Time) error { return errors.New("SMTP down") })
	if len(res.Errors) != 1 || len(res.Reminded) != 0 {
		t.Fatalf("Versandfehler: %+v", res)
	}
	if m, _ := s.readMeta(fresh); len(m.Reminded) != 0 {
		t.Fatalf("trotz Fehler vermerkt: %+v", m.Reminded)
	}
	// Aufbewahrung 0 = aus
	if res := s.Sweep(time.Now(), 0, reminders, notify); res.Scanned != 0 {
		t.Fatalf("Retention 0 muss nichts tun: %+v", res)
	}
}

func TestBackupRestore(t *testing.T) {
	s, _ := Open(t.TempDir())
	id, token, _ := s.Create(doc("Original"), "Erste Version")
	d2 := doc("Original")
	d2.Features = append(d2.Features, model.Feature{ID: "j1", Type: "junction", LayerID: d2.Layers[0].ID, At: &model.LatLng{47, 8}})
	if _, err := s.Save(id, token, d2, "Kreuzung"); err != nil {
		t.Fatal(err)
	}
	c, _, _, _ := s.AddComment(id, Comment{Lat: 47, Lng: 8, Author: "Anna", Text: "Hinweis", ClientID: "browser-a"})
	if _, _, _, err := s.AddComment(id, Comment{ParentID: c.ID, Author: "Besitzer", Text: "Antwort"}); err != nil {
		t.Fatal(err)
	}
	b, err := s.Backup(id)
	if err != nil || b.Format != BackupFormat || b.Name != "Original" || len(b.Versions) != 2 || len(b.Comments) != 2 || len(b.Doc.Features) != 1 {
		t.Fatalf("Backup: %v %+v", err, b)
	}
	if b.Comments[0].TokenHash != "" || b.Comments[0].ClientID != "" {
		t.Fatalf("Token/Client in Sicherung: %+v", b.Comments[0])
	}
	if b.Versions[0].Info.Label != "Erste Version" || b.Versions[1].Info.N != 2 {
		t.Fatalf("Versionen: %+v", b.Versions)
	}
	if _, err := s.Backup("doesnotexist1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannt: %v", err)
	}

	nid, ntoken, err := s.Restore(b)
	if err != nil || nid == id || ntoken == "" {
		t.Fatalf("Restore: %v", err)
	}
	got, meta, err := s.Get(nid)
	if err != nil || got.Name != "Original" || got.ID != nid || len(got.Features) != 1 {
		t.Fatalf("eingespielt: %v %+v", err, got)
	}
	if len(meta.Versions) != 3 || meta.Versions[0].Label != "Erste Version" || meta.Versions[2].Label != "Aus Sicherung eingespielt" || meta.Versions[2].N != 3 {
		t.Fatalf("Versionen nach Restore: %+v", meta.Versions)
	}
	old, info, err := s.Version(nid, 1)
	if err != nil || info.Label != "Erste Version" || len(old.Features) != 0 || old.ID != nid {
		t.Fatalf("Version 1: %v %+v", err, info)
	}
	comments, _ := s.Comments(nid)
	if len(comments) != 2 || comments[0].Author != "Anna" || comments[1].ParentID != c.ID {
		t.Fatalf("Kommentare: %+v", comments)
	}
	if err := s.Authorize(nid, ntoken); err != nil {
		t.Fatalf("neues Token: %v", err)
	}
	if err := s.Authorize(nid, token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("altes Token darf nicht gelten: %v", err)
	}
	// Ungültige Sicherungen
	for _, bad := range []*Backup{nil, {Format: "x", Doc: doc("A")}, {Format: BackupFormat}, {Format: BackupFormat, Doc: doc("A"), Versions: []BackupVersion{{Info: VersionInfo{N: 1}}}}} {
		if _, _, err := s.Restore(bad); !errors.Is(err, ErrBadBackup) {
			t.Fatalf("%+v akzeptiert: %v", bad, err)
		}
	}
	// Mehr Versionen als erlaubt: nur die neuesten bleiben
	s.SetMaxVersions(2)
	nid2, _, err := s.Restore(b)
	if err != nil {
		t.Fatal(err)
	}
	vs, _ := s.Versions(nid2)
	if len(vs) != 2 || vs[0].Label != "Aus Sicherung eingespielt" || vs[1].Label != "Kreuzung" {
		t.Fatalf("Begrenzung: %+v", vs)
	}
}
