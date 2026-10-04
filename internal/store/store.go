// Package store legt Entwürfe als JSON-Objekte ab: je Entwurf Metadaten, aktueller Stand,
// eine begrenzte Versionsgeschichte, Kommentare und Push-Abonnements. Die Ablage dahinter
// ist austauschbar (internal/blob): ein Ordner auf der Platte oder ein S3-Bucket.
// Bewusst ohne Datenbank und ohne Abhängigkeiten.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"stadtplaner/internal/blob"
	"stadtplaner/internal/model"
)

const (
	DefaultMaxVersions = 30
	MaxComments        = 500
	MaxCommentText     = 2000
	MaxCommentAuthor   = 80
	MaxPushSubs        = 200
	idAlphabet         = "0123456789abcdefghjkmnpqrstvwxyz"
	idLength           = 12
)

var (
	ErrBadEmail     = errors.New("E-Mail-Adresse ist ungültig")
	ErrBadBackup    = errors.New("Sicherungsdatei ist ungültig")
	emailPattern    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	ErrNotFound     = errors.New("Entwurf nicht gefunden")
	ErrCommentLimit = errors.New("zu viele Kommentare für diesen Entwurf")
	ErrConflict     = errors.New("der Entwurf wurde inzwischen von jemand anderem gespeichert")
	ErrBadComment   = errors.New("Kommentar ist ungültig")
	ErrUnauthorized = errors.New("kein gültiges Bearbeitungs-Token")
	idPattern       = regexp.MustCompile(`^[0-9a-z]{6,32}$`)
)

type Meta struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	TokenHash string        `json:"tokenHash"`
	CreatedAt time.Time     `json:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt"`
	NextSeq   int           `json:"nextSeq"`
	Versions  []VersionInfo `json:"versions"`
	// Lebenszyklus: Adresse für die Erinnerung zur Sicherung vor dem Ablauf und
	// welche Erinnerungen (Schlüssel "30d", "7d") für den aktuellen Stand schon verschickt wurden.
	Email    string               `json:"email,omitempty"`
	Reminded map[string]time.Time `json:"reminded,omitempty"`
}

type VersionInfo struct {
	N     int         `json:"n"`
	At    time.Time   `json:"at"`
	Label string      `json:"label"`
	Stats model.Stats `json:"stats"`
}

type versionFile struct {
	Info VersionInfo     `json:"info"`
	Doc  *model.Document `json:"doc"`
}

type Store struct {
	blobs       blob.Store
	maxVersions int
	mu          sync.RWMutex
}

// New baut den Store auf einer beliebigen Ablage (Ordner oder S3).
func New(b blob.Store) *Store {
	return &Store{blobs: b, maxVersions: DefaultMaxVersions}
}

// Open legt den Store in einem Ordner an (Entwürfe unter dir/drafts).
func Open(dir string) (*Store, error) {
	d, err := blob.NewDir(dir)
	if err != nil {
		return nil, err
	}
	return New(d), nil
}

// Blobs liefert die Ablage, damit andere Teile (z. B. VAPID-Schlüssel) dieselbe nutzen.
func (s *Store) Blobs() blob.Store { return s.blobs }

func (s *Store) SetMaxVersions(n int) {
	if n > 0 {
		s.maxVersions = n
	}
}

func ValidID(id string) bool { return idPattern.MatchString(id) }

func newID() (string, error) {
	buf := make([]byte, idLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, idLength)
	for i, b := range buf {
		out[i] = idAlphabet[int(b)%len(idAlphabet)]
	}
	return string(out), nil
}

func newToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Schlüssel je Entwurf: drafts/<id>/meta.json, current.json, versions/<n>.json, comments.json, push.json
func (s *Store) draftKey(id, name string) string { return "drafts/" + id + "/" + name }

func (s *Store) writeJSON(key string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.blobs.Put(key, data)
}

func (s *Store) readJSON(key string, v any) error {
	data, err := s.blobs.Get(key)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func (s *Store) readMeta(id string) (*Meta, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	var m Meta
	if err := s.readJSON(s.draftKey(id, "meta.json"), &m); err != nil {
		if errors.Is(err, blob.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &m, nil
}

func (s *Store) checkToken(m *Meta, token string) error {
	if token == "" || subtle.ConstantTimeCompare([]byte(hashToken(token)), []byte(m.TokenHash)) != 1 {
		return ErrUnauthorized
	}
	return nil
}

// Create legt einen neuen Entwurf an und liefert ID und Bearbeitungs-Token.
func (s *Store) Create(doc *model.Document, label string) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := newID()
	if err != nil {
		return "", "", err
	}
	token, err := newToken()
	if err != nil {
		return "", "", err
	}
	now := time.Now().UTC()
	doc.ID = id
	doc.UpdatedAt = now.Format(time.RFC3339)
	if doc.CreatedAt == "" {
		doc.CreatedAt = doc.UpdatedAt
	}
	m := &Meta{ID: id, Name: doc.Name, TokenHash: hashToken(token), CreatedAt: now, UpdatedAt: now, NextSeq: 1}
	if err := s.writeAll(m, doc, label, now); err != nil {
		return "", "", err
	}
	return id, token, nil
}

// writeAll schreibt Version + aktuellen Stand + Metadaten (Aufrufer hält den Lock).
func (s *Store) writeAll(m *Meta, doc *model.Document, label string, now time.Time) error {
	info := VersionInfo{N: m.NextSeq, At: now, Label: label, Stats: model.Compute(doc)}
	m.NextSeq++
	if err := s.writeJSON(s.draftKey(m.ID, "versions/"+strconv.Itoa(info.N)+".json"), versionFile{Info: info, Doc: doc}); err != nil {
		return err
	}
	m.Versions = append(m.Versions, info)
	for len(m.Versions) > s.maxVersions {
		old := m.Versions[0]
		m.Versions = m.Versions[1:]
		_ = s.blobs.Delete(s.draftKey(m.ID, "versions/"+strconv.Itoa(old.N)+".json"))
	}
	m.Name = doc.Name
	m.UpdatedAt = now
	m.Reminded = nil // neuer Stand: die Ablauf-Erinnerungen beginnen von vorn
	if err := s.writeJSON(s.draftKey(m.ID, "current.json"), doc); err != nil {
		return err
	}
	return s.writeJSON(s.draftKey(m.ID, "meta.json"), m)
}

// Get liefert den aktuellen Stand samt Metadaten (ohne Token-Hash).
func (s *Store) Get(id string) (*model.Document, *Meta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, nil, err
	}
	var doc model.Document
	if err := s.readJSON(s.draftKey(id, "current.json"), &doc); err != nil {
		return nil, nil, err
	}
	m.TokenHash = ""
	m.Email = "" // nur für den Besitzer (Reminder)
	return &doc, m, nil
}

// Authorize prüft das Token, ohne etwas zu ändern.
func (s *Store) Authorize(id, token string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	return s.checkToken(m, token)
}

// Save ersetzt den aktuellen Stand und legt eine Version ab.
func (s *Store) Save(id, token string, doc *model.Document, label string) (*Meta, error) {
	return s.SaveIfUnchanged(id, token, doc, label, nil)
}

// SaveIfUnchanged speichert nur, wenn der Stand seit expect (UpdatedAt beim Laden) nicht
// verändert wurde; nil = ohne Prüfung. Bei Abweichung ErrConflict.
func (s *Store) SaveIfUnchanged(id, token string, doc *model.Document, label string, expect *time.Time) (*Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	if err := s.checkToken(m, token); err != nil {
		return nil, err
	}
	if expect != nil && !m.UpdatedAt.Truncate(time.Millisecond).Equal(expect.Truncate(time.Millisecond)) {
		return nil, ErrConflict
	}
	now := time.Now().UTC()
	doc.ID = id
	doc.UpdatedAt = now.Format(time.RFC3339)
	doc.CreatedAt = m.CreatedAt.Format(time.RFC3339)
	if err := s.writeAll(m, doc, label, now); err != nil {
		return nil, err
	}
	m.TokenHash = ""
	return m, nil
}

func (s *Store) Delete(id, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	if err := s.checkToken(m, token); err != nil {
		return err
	}
	return s.deleteAll(id)
}

// deleteAll entfernt alle Objekte eines Entwurfs (Aufrufer hält den Lock).
// Metadaten zuerst: danach gilt der Entwurf als gelöscht, auch wenn Reste bleiben.
func (s *Store) deleteAll(id string) error {
	if err := s.blobs.Delete(s.draftKey(id, "meta.json")); err != nil {
		return err
	}
	keys, err := s.blobs.List("drafts/" + id + "/")
	if err != nil {
		return err
	}
	for _, k := range keys {
		if err := s.blobs.Delete(k); err != nil {
			return err
		}
	}
	return nil
}

// List liefert die Metadaten aller Entwürfe (ohne Token-Hash), unsortiert.
func (s *Store) List() ([]*Meta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys, err := s.blobs.List("drafts/")
	if err != nil {
		return nil, err
	}
	var out []*Meta
	for _, k := range keys {
		if !strings.HasSuffix(k, "/meta.json") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(k, "drafts/"), "/meta.json")
		m, err := s.readMeta(id)
		if err != nil {
			continue
		}
		m.TokenHash = ""
		out = append(out, m)
	}
	return out, nil
}

// --- Lebenszyklus: Erinnerung und Ablauf --------------------------------------

// SetReminder hinterlegt die Adresse für die Ablauf-Erinnerung (leer = entfernen); nur mit Token.
func (s *Store) SetReminder(id, token, email string) (*Meta, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email != "" && (len(email) > 120 || !emailPattern.MatchString(email)) {
		return nil, ErrBadEmail
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	if err := s.checkToken(m, token); err != nil {
		return nil, err
	}
	m.Email = email
	m.Reminded = nil
	if err := s.writeJSON(s.draftKey(id, "meta.json"), m); err != nil {
		return nil, err
	}
	m.TokenHash = ""
	return m, nil
}

// Reminder liefert die hinterlegte Adresse; nur mit Token.
func (s *Store) Reminder(id, token string) (*Meta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	if err := s.checkToken(m, token); err != nil {
		return nil, err
	}
	m.TokenHash = ""
	return m, nil
}

// SweepResult fasst einen Lauf des Lebenszyklus zusammen.
type SweepResult struct {
	Scanned  int
	Deleted  []string
	Reminded []string
	Errors   []error
}

// Sweep löscht Entwürfe, deren letzter Stand älter als retention ist, und ruft notify für
// Entwürfe mit hinterlegter Adresse, sobald weniger als eine der Fristen in reminders bis zum
// Ablauf bleibt (je Frist einmal pro Stand). notify liefert nil, wenn die Nachricht raus ist.
func (s *Store) Sweep(now time.Time, retention time.Duration, reminders []time.Duration, notify func(m *Meta, expires time.Time) error) SweepResult {
	var res SweepResult
	if retention <= 0 {
		return res
	}
	metas, err := s.List()
	if err != nil {
		res.Errors = append(res.Errors, err)
		return res
	}
	for _, listed := range metas {
		res.Scanned++
		expires := listed.UpdatedAt.Add(retention)
		if !now.Before(expires) {
			s.mu.Lock()
			err := s.deleteAll(listed.ID)
			s.mu.Unlock()
			if err != nil {
				res.Errors = append(res.Errors, fmt.Errorf("%s löschen: %w", listed.ID, err))
			} else {
				res.Deleted = append(res.Deleted, listed.ID)
			}
			continue
		}
		if listed.Email == "" || notify == nil {
			continue
		}
		for _, d := range reminders {
			if d <= 0 || now.Before(expires.Add(-d)) {
				continue
			}
			key := reminderKey(d)
			s.mu.Lock()
			m, err := s.readMeta(listed.ID)
			if err != nil || m.Email == "" {
				s.mu.Unlock()
				break
			}
			if at, ok := m.Reminded[key]; ok && !at.Before(m.UpdatedAt) {
				s.mu.Unlock()
				continue // für diesen Stand schon erinnert
			}
			s.mu.Unlock()
			if err := notify(m, expires); err != nil {
				res.Errors = append(res.Errors, fmt.Errorf("%s erinnern (%s): %w", m.ID, key, err))
				break
			}
			s.mu.Lock()
			if m.Reminded == nil {
				m.Reminded = map[string]time.Time{}
			}
			m.Reminded[key] = now
			if err := s.writeJSON(s.draftKey(m.ID, "meta.json"), m); err != nil {
				res.Errors = append(res.Errors, err)
			}
			s.mu.Unlock()
			res.Reminded = append(res.Reminded, m.ID+":"+key)
			break // die knappste zutreffende Frist genügt pro Lauf
		}
	}
	return res
}

func reminderKey(d time.Duration) string {
	return strconv.Itoa(int(d.Hours()/24)) + "d"
}

// --- Sicherung: Export und Import eines ganzen Entwurfs -------------------------

const BackupFormat = "stadtplaner-backup"

// Backup ist die Sicherungsdatei: aktueller Stand, Versionen und Kommentare (ohne Token).
type Backup struct {
	Format        string          `json:"format"`
	FormatVersion int             `json:"formatVersion"`
	ExportedAt    time.Time       `json:"exportedAt"`
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	Doc           *model.Document `json:"doc"`
	Versions      []BackupVersion `json:"versions"`
	Comments      []Comment       `json:"comments"`
}

type BackupVersion struct {
	Info VersionInfo     `json:"info"`
	Doc  *model.Document `json:"doc"`
}

func (s *Store) Backup(id string) (*Backup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	var doc model.Document
	if err := s.readJSON(s.draftKey(id, "current.json"), &doc); err != nil {
		return nil, err
	}
	b := &Backup{Format: BackupFormat, FormatVersion: 1, ExportedAt: time.Now().UTC(), ID: id, Name: m.Name, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt, Doc: &doc, Versions: []BackupVersion{}, Comments: []Comment{}}
	for _, v := range m.Versions {
		var vf versionFile
		if err := s.readJSON(s.draftKey(id, "versions/"+strconv.Itoa(v.N)+".json"), &vf); err != nil {
			continue
		}
		b.Versions = append(b.Versions, BackupVersion{Info: vf.Info, Doc: vf.Doc})
	}
	list, err := s.readComments(id)
	if err == nil {
		b.Comments = stripTokens(list)
	}
	return b, nil
}

// Restore legt aus einer Sicherung einen neuen Entwurf mit eigenem Token an; Versionen behalten
// Nummern, Zeiten und Beschriftungen, der aktuelle Stand wird als neue Version abgelegt.
func (s *Store) Restore(b *Backup) (string, string, error) {
	if b == nil || b.Format != BackupFormat || b.Doc == nil {
		return "", "", ErrBadBackup
	}
	if err := model.Normalize(b.Doc); err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrBadBackup, err)
	}
	versions := b.Versions
	if len(versions) > s.maxVersions {
		versions = versions[len(versions)-s.maxVersions:]
	}
	for i := range versions {
		if versions[i].Doc == nil {
			return "", "", fmt.Errorf("%w: Version ohne Inhalt", ErrBadBackup)
		}
		if err := model.Normalize(versions[i].Doc); err != nil {
			return "", "", fmt.Errorf("%w: Version %d: %v", ErrBadBackup, versions[i].Info.N, err)
		}
	}
	if len(b.Comments) > MaxComments {
		return "", "", fmt.Errorf("%w: zu viele Kommentare", ErrBadBackup)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := newID()
	if err != nil {
		return "", "", err
	}
	token, err := newToken()
	if err != nil {
		return "", "", err
	}
	now := time.Now().UTC()
	created := b.CreatedAt
	if created.IsZero() {
		created = now
	}
	m := &Meta{ID: id, Name: b.Doc.Name, TokenHash: hashToken(token), CreatedAt: created, UpdatedAt: now, NextSeq: 1}
	for _, v := range versions {
		if v.Info.N < 1 || v.Info.N < m.NextSeq {
			v.Info.N = m.NextSeq
		}
		if v.Info.At.IsZero() {
			v.Info.At = now
		}
		v.Doc.ID = id
		v.Info.Stats = model.Compute(v.Doc)
		if err := s.writeJSON(s.draftKey(id, "versions/"+strconv.Itoa(v.Info.N)+".json"), versionFile{Info: v.Info, Doc: v.Doc}); err != nil {
			return "", "", err
		}
		m.Versions = append(m.Versions, v.Info)
		m.NextSeq = v.Info.N + 1
	}
	b.Doc.ID = id
	b.Doc.CreatedAt = created.Format(time.RFC3339)
	b.Doc.UpdatedAt = now.Format(time.RFC3339)
	if err := s.writeAll(m, b.Doc, "Aus Sicherung eingespielt", now); err != nil {
		return "", "", err
	}
	if len(b.Comments) > 0 {
		list := make([]Comment, 0, len(b.Comments))
		for _, c := range b.Comments {
			c.Text = strings.TrimSpace(c.Text)
			if c.ID == "" || c.Text == "" || len(c.Text) > MaxCommentText {
				continue
			}
			c.TokenHash = ""
			c.ClientID = ""
			if c.Author == "" {
				c.Author = "Anonym"
			}
			list = append(list, c)
		}
		if err := s.writeJSON(s.commentsKey(id), list); err != nil {
			return "", "", err
		}
	}
	return id, token, nil
}

// Fork kopiert einen Entwurf in einen neuen mit eigenem Token.
func (s *Store) Fork(id, name string) (string, string, error) {
	doc, _, err := s.Get(id)
	if err != nil {
		return "", "", err
	}
	if name != "" {
		doc.Name = name
	}
	doc.CreatedAt = ""
	return s.Create(doc, "Kopie von "+id)
}

func (s *Store) Versions(id string) ([]VersionInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	out := make([]VersionInfo, len(m.Versions))
	copy(out, m.Versions)
	sort.Slice(out, func(i, j int) bool { return out[i].N > out[j].N })
	return out, nil
}

func (s *Store) Version(id string, n int) (*model.Document, *VersionInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, nil, err
	}
	found := false
	for _, v := range m.Versions {
		if v.N == n {
			found = true
			break
		}
	}
	if !found {
		return nil, nil, ErrNotFound
	}
	var vf versionFile
	if err := s.readJSON(s.draftKey(id, "versions/"+strconv.Itoa(n)+".json"), &vf); err != nil {
		if errors.Is(err, blob.ErrNotExist) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	return vf.Doc, &vf.Info, nil
}

// --- Kommentare -------------------------------------------------------------
// Kommentare gehören nicht zum Entwurf (keine Versionen, kein Fork). Wer den
// Ansichtslink hat, darf kommentieren; löschen darf der Besitzer (Edit-Token)
// oder die Person mit dem Kommentar-Token, das beim Anlegen zurückkommt.

type Comment struct {
	ID        string    `json:"id"`
	ParentID  string    `json:"parentId,omitempty"` // gesetzt bei Antworten
	At        time.Time `json:"at"`
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	Resolved  bool      `json:"resolved"`
	TokenHash string    `json:"tokenHash,omitempty"`
	ClientID  string    `json:"clientId,omitempty"` // Browser-Kennung, damit Verfasser keine eigene Push-Nachricht bekommen
}

// PushSub ist ein Web-Push-Abonnement eines Browsers für einen Entwurf.
type PushSub struct {
	ClientID  string    `json:"clientId"`
	Endpoint  string    `json:"endpoint"`
	P256dh    string    `json:"p256dh"`
	Auth      string    `json:"auth"`
	Role      string    `json:"role"` // "all" (Besitzer) oder "replies" (Antworten auf eigene Kommentare)
	Threads   []string  `json:"threads"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) commentsKey(id string) string { return s.draftKey(id, "comments.json") }

func (s *Store) readComments(id string) ([]Comment, error) {
	var list []Comment
	if err := s.readJSON(s.commentsKey(id), &list); err != nil {
		if errors.Is(err, blob.ErrNotExist) {
			return []Comment{}, nil
		}
		return nil, err
	}
	return list, nil
}

func stripTokens(list []Comment) []Comment {
	out := make([]Comment, len(list))
	for i, c := range list {
		c.TokenHash = ""
		c.ClientID = ""
		out[i] = c
	}
	return out
}

// Comments liefert alle Kommentare eines Entwurfs (ohne Token-Hashes), älteste zuerst.
func (s *Store) Comments(id string) ([]Comment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := s.readMeta(id); err != nil {
		return nil, err
	}
	list, err := s.readComments(id)
	if err != nil {
		return nil, err
	}
	return stripTokens(list), nil
}

// AddComment legt einen Kommentar oder eine Antwort (ParentID gesetzt) an und
// liefert ihn samt Lösch-Token und, bei Antworten, den Elternkommentar.
func (s *Store) AddComment(id string, c Comment) (Comment, string, *Comment, error) {
	c.Text = strings.TrimSpace(c.Text)
	c.Author = strings.TrimSpace(c.Author)
	if c.Text == "" || len(c.Text) > MaxCommentText || len(c.Author) > MaxCommentAuthor || len(c.ClientID) > 64 {
		return Comment{}, "", nil, ErrBadComment
	}
	if c.ParentID == "" && (c.Lat < -90 || c.Lat > 90 || c.Lng < -180 || c.Lng > 180) {
		return Comment{}, "", nil, ErrBadComment
	}
	if c.Author == "" {
		c.Author = "Anonym"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.readMeta(id); err != nil {
		return Comment{}, "", nil, err
	}
	list, err := s.readComments(id)
	if err != nil {
		return Comment{}, "", nil, err
	}
	if len(list) >= MaxComments {
		return Comment{}, "", nil, ErrCommentLimit
	}
	var parent *Comment
	if c.ParentID != "" {
		for i := range list {
			if list[i].ID == c.ParentID {
				parent = &list[i]
				break
			}
		}
		if parent == nil || parent.ParentID != "" {
			return Comment{}, "", nil, fmt.Errorf("%w: Antworten gehen nur auf einen Hauptkommentar", ErrBadComment)
		}
		c.Lat, c.Lng = parent.Lat, parent.Lng
	}
	cid, err := newID()
	if err != nil {
		return Comment{}, "", nil, err
	}
	token, err := newToken()
	if err != nil {
		return Comment{}, "", nil, err
	}
	c.ID = cid
	c.At = time.Now().UTC()
	c.Resolved = false
	c.TokenHash = hashToken(token)
	list = append(list, c)
	if err := s.writeJSON(s.commentsKey(id), list); err != nil {
		return Comment{}, "", nil, err
	}
	c.TokenHash = ""
	if parent != nil {
		p := *parent
		p.TokenHash = ""
		parent = &p
	}
	return c, token, parent, nil
}

func (s *Store) updateComment(id, cid, editToken, commentToken string, fn func(*Comment) bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	list, err := s.readComments(id)
	if err != nil {
		return err
	}
	idx := -1
	for i := range list {
		if list[i].ID == cid {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	owner := s.checkToken(m, editToken) == nil
	author := commentToken != "" && subtle.ConstantTimeCompare([]byte(hashToken(commentToken)), []byte(list[idx].TokenHash)) == 1
	if !owner && !author {
		return ErrUnauthorized
	}
	keep := fn(&list[idx])
	if !keep {
		removed := list[idx].ID
		kept := list[:0]
		for _, c := range list {
			if c.ID != removed && c.ParentID != removed {
				kept = append(kept, c)
			}
		}
		list = kept
	}
	return s.writeJSON(s.commentsKey(id), list)
}

// DeleteComment entfernt einen Kommentar (Besitzer oder Verfasser).
func (s *Store) DeleteComment(id, cid, editToken, commentToken string) error {
	return s.updateComment(id, cid, editToken, commentToken, func(*Comment) bool { return false })
}

// ResolveComment markiert einen Hauptkommentar als erledigt (Besitzer oder Verfasser).
func (s *Store) ResolveComment(id, cid, editToken, commentToken string, resolved bool) error {
	return s.updateComment(id, cid, editToken, commentToken, func(c *Comment) bool {
		if c.ParentID == "" {
			c.Resolved = resolved
		}
		return true
	})
}

// --- Push-Abonnements ----------------------------------------------------------

func (s *Store) pushKey(id string) string { return s.draftKey(id, "push.json") }

func (s *Store) readPush(id string) ([]PushSub, error) {
	var list []PushSub
	if err := s.readJSON(s.pushKey(id), &list); err != nil {
		if errors.Is(err, blob.ErrNotExist) {
			return []PushSub{}, nil
		}
		return nil, err
	}
	return list, nil
}

// PushSubs liefert alle Abonnements eines Entwurfs.
func (s *Store) PushSubs(id string) ([]PushSub, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := s.readMeta(id); err != nil {
		return nil, err
	}
	return s.readPush(id)
}

// SetPushSub legt ein Abonnement an oder ersetzt das des gleichen Browsers.
func (s *Store) SetPushSub(id string, sub PushSub) error {
	if sub.ClientID == "" || len(sub.ClientID) > 64 || sub.Endpoint == "" || (sub.Role != "all" && sub.Role != "replies") {
		return ErrBadComment
	}
	if len(sub.Threads) > 200 {
		sub.Threads = sub.Threads[:200]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.readMeta(id); err != nil {
		return err
	}
	list, err := s.readPush(id)
	if err != nil {
		return err
	}
	out := list[:0]
	for _, x := range list {
		if x.ClientID != sub.ClientID && x.Endpoint != sub.Endpoint {
			out = append(out, x)
		}
	}
	if len(out) >= MaxPushSubs {
		return ErrCommentLimit
	}
	sub.CreatedAt = time.Now().UTC()
	out = append(out, sub)
	return s.writeJSON(s.pushKey(id), out)
}

// DeletePushSub entfernt Abonnements nach Browser-Kennung oder Endpunkt (beides optional).
func (s *Store) DeletePushSub(id, clientID, endpoint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.readMeta(id); err != nil {
		return err
	}
	list, err := s.readPush(id)
	if err != nil {
		return err
	}
	out := list[:0]
	for _, x := range list {
		if (clientID != "" && x.ClientID == clientID) || (endpoint != "" && x.Endpoint == endpoint) {
			continue
		}
		out = append(out, x)
	}
	return s.writeJSON(s.pushKey(id), out)
}
