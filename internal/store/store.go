// Package store legt Entwürfe als JSON-Dateien ab: ein Ordner pro Entwurf mit
// Metadaten, aktuellem Stand und einer begrenzten Versionsgeschichte.
// Bewusst ohne Datenbank: keine Abhängigkeiten, ein Volume genügt.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"stadtplaner/internal/model"
)

const (
	DefaultMaxVersions = 30
	idAlphabet         = "0123456789abcdefghjkmnpqrstvwxyz"
	idLength           = 12
)

var (
	ErrNotFound     = errors.New("Entwurf nicht gefunden")
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
	dir         string
	maxVersions int
	mu          sync.RWMutex
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "drafts"), 0o755); err != nil {
		return nil, fmt.Errorf("Datenordner anlegen: %w", err)
	}
	return &Store{dir: dir, maxVersions: DefaultMaxVersions}, nil
}

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

func (s *Store) draftDir(id string) string { return filepath.Join(s.dir, "drafts", id) }

func writeJSONAtomic(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
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
	if err := readJSON(filepath.Join(s.draftDir(id), "meta.json"), &m); err != nil {
		if errors.Is(err, os.ErrNotExist) {
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
	dir := s.draftDir(m.ID)
	if err := os.MkdirAll(filepath.Join(dir, "versions"), 0o755); err != nil {
		return err
	}
	info := VersionInfo{N: m.NextSeq, At: now, Label: label, Stats: model.Compute(doc)}
	m.NextSeq++
	if err := writeJSONAtomic(filepath.Join(dir, "versions", strconv.Itoa(info.N)+".json"), versionFile{Info: info, Doc: doc}); err != nil {
		return err
	}
	m.Versions = append(m.Versions, info)
	for len(m.Versions) > s.maxVersions {
		old := m.Versions[0]
		m.Versions = m.Versions[1:]
		_ = os.Remove(filepath.Join(dir, "versions", strconv.Itoa(old.N)+".json"))
	}
	m.Name = doc.Name
	m.UpdatedAt = now
	if err := writeJSONAtomic(filepath.Join(dir, "current.json"), doc); err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(dir, "meta.json"), m)
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
	if err := readJSON(filepath.Join(s.draftDir(id), "current.json"), &doc); err != nil {
		return nil, nil, err
	}
	m.TokenHash = ""
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
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	if err := s.checkToken(m, token); err != nil {
		return nil, err
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
	return os.RemoveAll(s.draftDir(id))
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
	if err := readJSON(filepath.Join(s.draftDir(id), "versions", strconv.Itoa(n)+".json"), &vf); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	return vf.Doc, &vf.Info, nil
}
