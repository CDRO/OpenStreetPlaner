// Package blob ist die Ablage hinter dem Store: Schlüssel (Pfade mit "/") auf Bytes.
// Zwei Backends ohne Fremdbibliothek: ein Ordner auf der Platte und ein S3-kompatibler
// Bucket (z. B. Deploio/Nine Object Storage). Der Store kennt nur diese Schnittstelle.
package blob

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ErrNotExist meldet einen fehlenden Schlüssel (Get) – nie ein Fehler bei Delete.
var ErrNotExist = errors.New("Objekt nicht vorhanden")

// Store ist die minimale Schnittstelle, die der Entwurfs-Store braucht.
type Store interface {
	// Get liefert den Inhalt oder ErrNotExist.
	Get(key string) ([]byte, error)
	// Put schreibt den Inhalt vollständig (atomar aus Sicht der Leser).
	Put(key string, data []byte) error
	// Delete entfernt den Schlüssel; ein fehlender Schlüssel ist kein Fehler.
	Delete(key string) error
	// List liefert alle Schlüssel mit diesem Präfix, sortiert.
	List(prefix string) ([]string, error)
}

// ValidKey erlaubt nur schlichte Pfade: keine leeren Segmente, kein "." oder "..".
func ValidKey(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return false
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// Dir legt Schlüssel als Dateien unter einem Wurzelordner ab (Standard: DATA_DIR).
type Dir struct {
	root string
}

func NewDir(root string) (*Dir, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("Datenordner anlegen: %w", err)
	}
	return &Dir{root: root}, nil
}

func (d *Dir) Root() string { return d.root }

func (d *Dir) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", fmt.Errorf("ungültiger Schlüssel %q", key)
	}
	return filepath.Join(d.root, filepath.FromSlash(key)), nil
}

func (d *Dir) Get(key string) ([]byte, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotExist
		}
		return nil, err
	}
	return data, nil
}

// Put schreibt in eine temporäre Datei und benennt um, damit Leser nie halbe Dateien sehen.
func (d *Dir) Put(key string, data []byte) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (d *Dir) Delete(key string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	// Leere Ordner aufräumen (bis zur Wurzel, ohne sie selbst)
	for dir := filepath.Dir(p); dir != d.root && strings.HasPrefix(dir, d.root); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			break
		}
	}
	return nil
}

// List durchläuft nur den Ordner, in dem das Präfix liegt (nicht die ganze Wurzel,
// die auch den Kachel-Cache enthalten kann).
func (d *Dir) List(prefix string) ([]string, error) {
	dirPart := prefix
	if i := strings.LastIndex(prefix, "/"); i >= 0 {
		dirPart = prefix[:i]
	} else {
		dirPart = ""
	}
	if dirPart != "" && !ValidKey(dirPart) {
		return nil, fmt.Errorf("ungültiges Präfix %q", prefix)
	}
	start := filepath.Join(d.root, filepath.FromSlash(dirPart))
	var out []string
	err := filepath.WalkDir(start, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if e.IsDir() || strings.HasSuffix(p, ".tmp") {
			return nil
		}
		rel, err := filepath.Rel(d.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if strings.HasPrefix(key, prefix) {
			out = append(out, key)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}
