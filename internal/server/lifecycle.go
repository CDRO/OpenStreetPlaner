package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"stadtplaner/internal/mail"
	"stadtplaner/internal/model"
	"stadtplaner/internal/store"
)

// Lebenszyklus: Entwürfe, die länger als die Aufbewahrungsfrist nicht gespeichert wurden, werden
// gelöscht. Wer eine E-Mail-Adresse hinterlegt, bekommt vorher Erinnerungen zur Sicherung.

const (
	sweepFirstDelay = time.Minute
	sweepInterval   = 6 * time.Hour
)

// Lifecycle konfiguriert Aufbewahrung, Erinnerungsfristen und den Versand.
type Lifecycle struct {
	Retention time.Duration   // 0 = nie löschen
	Reminders []time.Duration // Fristen vor dem Ablauf, z. B. 30 und 7 Tage
	Mailer    mail.Sender     // nil = keine Erinnerungen
	PublicURL string          // Basis für Links in Erinnerungen, z. B. https://plan.example.ch
}

// SetLifecycle schaltet Aufbewahrung und Erinnerungen ein; Retention 0 schaltet beides aus.
func (s *Server) SetLifecycle(lc Lifecycle) {
	lc.PublicURL = strings.TrimRight(strings.TrimSpace(lc.PublicURL), "/")
	s.lifecycle = lc
}

// StartSweeper lässt den Aufräum-Lauf im Hintergrund laufen, bis ctx endet.
func (s *Server) StartSweeper(ctx context.Context) {
	if s.lifecycle.Retention <= 0 {
		return
	}
	go func() {
		timer := time.NewTimer(sweepFirstDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			s.Sweep(time.Now())
			timer.Reset(sweepInterval)
		}
	}()
}

// Sweep führt einen Aufräum-Lauf aus und protokolliert das Ergebnis.
func (s *Server) Sweep(now time.Time) store.SweepResult {
	var notify func(m *store.Meta, expires time.Time) error
	if s.lifecycle.Mailer != nil {
		notify = func(m *store.Meta, expires time.Time) error {
			subject, body := s.reminderMail(m, expires, now)
			return s.lifecycle.Mailer.Send(m.Email, subject, body)
		}
	}
	res := s.store.Sweep(now, s.lifecycle.Retention, s.lifecycle.Reminders, notify)
	for _, err := range res.Errors {
		s.logger.Printf("Lebenszyklus: %v", err)
	}
	if len(res.Deleted) > 0 || len(res.Reminded) > 0 {
		s.logger.Printf("Lebenszyklus: %d Entwürfe geprüft, %d gelöscht, %d Erinnerungen verschickt", res.Scanned, len(res.Deleted), len(res.Reminded))
	}
	return res
}

func (s *Server) draftURL(id string) string {
	return s.lifecycle.PublicURL + "/d/" + id
}

func (s *Server) reminderMail(m *store.Meta, expires, now time.Time) (subject, body string) {
	days := int(expires.Sub(now).Hours()/24 + 0.5)
	name := m.Name
	if name == "" {
		name = "Unbenannter Entwurf"
	}
	subject = fmt.Sprintf("Stadtplaner: Entwurf «%s» wird in %d Tagen gelöscht", name, days)
	link := s.draftURL(m.ID)
	body = fmt.Sprintf(`Guten Tag

Der Entwurf «%s» wurde zuletzt am %s gespeichert. Entwürfe, die %d Tage lang nicht gespeichert werden, löscht der Stadtplaner automatisch. Dieser Entwurf wird am %s gelöscht, falls er bis dahin nicht gespeichert wird.

So sichern Sie den Entwurf:
1. Entwurf öffnen: %s
2. Im Reiter «Entwürfe» auf «Sicherung herunterladen» klicken. Die Datei enthält den aktuellen Stand, alle Versionen und Kommentare.
3. Die Datei lässt sich später über «Importieren» wieder einspielen.

Wer den Entwurf nur weiter aufbewahren möchte, speichert ihn einmal neu; damit beginnt die Frist von vorn.

Diese Erinnerung kommt, weil für den Entwurf diese E-Mail-Adresse hinterlegt wurde. Die Adresse lässt sich im Reiter «Entwürfe» ändern oder entfernen.
`, name, m.UpdatedAt.Local().Format("02.01.2006"), int(s.lifecycle.Retention.Hours()/24), expires.Local().Format("02.01.2006"), link)
	return subject, body
}

// expiry liefert Ablaufdatum und Aufbewahrungsdauer in Tagen für API-Antworten (nil, 0 = aus).
func (s *Server) expiry(m *store.Meta) (expiresAt any, retentionDays int) {
	if s.lifecycle.Retention <= 0 {
		return nil, 0
	}
	return m.UpdatedAt.Add(s.lifecycle.Retention), int(s.lifecycle.Retention.Hours() / 24)
}

func (s *Server) reminderResponse(w http.ResponseWriter, m *store.Meta) {
	expiresAt, retentionDays := s.expiry(m)
	writeJSON(w, http.StatusOK, map[string]any{
		"email": m.Email, "expiresAt": expiresAt, "retentionDays": retentionDays, "mailEnabled": s.lifecycle.Mailer != nil,
	})
}

// --- Routen -----------------------------------------------------------------

func (s *Server) getReminder(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	m, err := s.store.Reminder(id, r.Header.Get(editTokenHeader))
	if err != nil {
		writeError(w, err)
		return
	}
	s.reminderResponse(w, m)
}

func (s *Server) setReminder(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, errors.Join(model.ErrInvalid, errors.New("Anfrage ist kein gültiges JSON")))
		return
	}
	m, err := s.store.SetReminder(id, r.Header.Get(editTokenHeader), body.Email)
	if err != nil {
		writeError(w, err)
		return
	}
	s.reminderResponse(w, m)
}

// backup liefert die Sicherungsdatei zum Herunterladen.
func (s *Server) backup(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	b, err := s.store.Backup(id)
	if err != nil {
		writeError(w, err)
		return
	}
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = "entwurf"
	}
	filename := safeFilename(name) + ".stadtplaner-backup.json"
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+asciiFilename(filename)+"\"; filename*=UTF-8''"+url.PathEscape(filename))
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	_ = enc.Encode(b)
}

// importBackup legt aus einer Sicherungsdatei einen neuen Entwurf an.
func (s *Server) importBackup(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes*4) // Versionen und Kommentare inklusive
	var b store.Backup
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, err)
			return
		}
		writeError(w, fmt.Errorf("%w: kein gültiges JSON", store.ErrBadBackup))
		return
	}
	id, token, err := s.store.Restore(&b)
	if err != nil {
		writeError(w, err)
		return
	}
	doc, m, err := s.store.Get(id)
	if err != nil {
		writeError(w, err)
		return
	}
	expiresAt, retentionDays := s.expiry(m)
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "editToken": token, "name": m.Name, "doc": doc, "updatedAt": m.UpdatedAt, "versionCount": len(m.Versions),
		"expiresAt": expiresAt, "retentionDays": retentionDays,
	})
}

// safeFilename ersetzt alles, was in Dateinamen stört, durch Unterstriche.
func safeFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' || r < 0x20:
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

// asciiFilename bildet den Fallback-Dateinamen für alte Clients: Nicht-ASCII wird ersetzt.
func asciiFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r > 0x7e || r < 0x20 || r == '"' {
			b.WriteRune('_')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}
