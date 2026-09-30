// Package server verdrahtet HTTP-Routen: JSON-API für Entwürfe, OSM-Proxys,
// Kachel-Proxy und die eingebettete Web-Oberfläche.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"stadtplaner/internal/model"
	"stadtplaner/internal/osm"
	"stadtplaner/internal/store"
)

const (
	maxBodyBytes       = 8 << 20
	editTokenHeader    = "X-Edit-Token"
	commentTokenHeader = "X-Comment-Token"
)

type Server struct {
	store   *store.Store
	osm     *osm.Client
	index   []byte
	static  http.Handler
	mux     *http.ServeMux
	logger  *log.Logger
	limiter *limiter
}

// RateLimit konfiguriert die Drosselung schreibender API-Aufrufe pro Client.
type RateLimit struct {
	PerMinute  float64
	Burst      int
	TrustProxy bool
}

// New baut den Server. webFS enthält den Ordner "web" mit index.html, css/ und js/.
func New(st *store.Store, osmClient *osm.Client, webFS fs.FS, logger *log.Logger) (*Server, error) {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, err
	}
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = log.Default()
	}
	s := &Server{store: st, osm: osmClient, index: index, logger: logger, mux: http.NewServeMux()}
	s.static = http.StripPrefix("/static/", http.FileServerFS(sub))
	s.routes()
	return s, nil
}

// SetRateLimit aktiviert die Drosselung; PerMinute <= 0 schaltet sie aus.
func (s *Server) SetRateLimit(rl RateLimit) {
	if rl.PerMinute <= 0 {
		s.limiter = nil
		return
	}
	if rl.Burst <= 0 {
		rl.Burst = 10
	}
	s.limiter = newLimiter(rl.PerMinute, rl.Burst, rl.TrustProxy)
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	m.HandleFunc("POST /api/drafts", s.createDraft)
	m.HandleFunc("GET /api/drafts/{id}", s.getDraft)
	m.HandleFunc("PUT /api/drafts/{id}", s.saveDraft)
	m.HandleFunc("DELETE /api/drafts/{id}", s.deleteDraft)
	m.HandleFunc("POST /api/drafts/{id}/auth", s.authDraft)
	m.HandleFunc("POST /api/drafts/{id}/fork", s.forkDraft)
	m.HandleFunc("GET /api/drafts/{id}/versions", s.listVersions)
	m.HandleFunc("GET /api/drafts/{id}/versions/{n}", s.getVersion)
	m.HandleFunc("GET /api/drafts/{id}/comments", s.listComments)
	m.HandleFunc("POST /api/drafts/{id}/comments", s.addComment)
	m.HandleFunc("PATCH /api/drafts/{id}/comments/{cid}", s.resolveComment)
	m.HandleFunc("DELETE /api/drafts/{id}/comments/{cid}", s.deleteComment)
	m.HandleFunc("GET /api/search", s.search)
	m.HandleFunc("GET /api/roads", s.roads)
	m.HandleFunc("GET /tiles/{z}/{x}/{y}", s.tile)
	m.HandleFunc("GET /static/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		s.static.ServeHTTP(w, r)
	})
	m.HandleFunc("GET /d/{id}", s.serveIndex)
	m.HandleFunc("GET /{$}", s.serveIndex)
}

// Handler liefert den Router mit Logging, Sicherheits-Headern und Drosselung.
func (s *Server) Handler() http.Handler {
	return s.logging(s.headers(s.limiter.middleware(s.mux)))
}

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		if !strings.HasPrefix(r.URL.Path, "/tiles/") && !strings.HasPrefix(r.URL.Path, "/static/") {
			h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(sw, r)
		if !strings.HasPrefix(r.URL.Path, "/tiles/") || sw.status >= 400 {
			s.logger.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
		}
	})
}

// --- Hilfen -----------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	msg := "Interner Fehler"
	var maxErr *http.MaxBytesError
	switch {
	case errors.Is(err, store.ErrNotFound):
		status, msg = http.StatusNotFound, err.Error()
	case errors.Is(err, store.ErrUnauthorized):
		status, msg = http.StatusForbidden, err.Error()
	case errors.Is(err, model.ErrInvalid), errors.Is(err, osm.ErrBadRequest), errors.Is(err, store.ErrBadComment):
		status, msg = http.StatusBadRequest, err.Error()
	case errors.Is(err, store.ErrCommentLimit):
		status, msg = http.StatusConflict, err.Error()
	case errors.As(err, &maxErr):
		status, msg = http.StatusRequestEntityTooLarge, "Entwurf ist zu gross"
	case errors.Is(err, context.Canceled):
		status, msg = 499, "abgebrochen"
	default:
		if err != nil {
			msg = err.Error()
			status = http.StatusBadGateway
		}
	}
	writeJSON(w, status, map[string]string{"error": msg})
}

type draftBody struct {
	Doc   *model.Document `json:"doc"`
	Label string          `json:"label"`
	Name  string          `json:"name"`
}

func readDraftBody(w http.ResponseWriter, r *http.Request, needDoc bool) (*draftBody, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var body draftBody
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, err
		}
		if errors.Is(err, io.EOF) && !needDoc {
			return &body, nil
		}
		return nil, errors.Join(model.ErrInvalid, errors.New("Anfrage ist kein gültiges JSON"))
	}
	if needDoc {
		if body.Doc == nil {
			return nil, errors.Join(model.ErrInvalid, errors.New("Feld \"doc\" fehlt"))
		}
		if err := model.Normalize(body.Doc); err != nil {
			return nil, err
		}
	}
	body.Label = strings.TrimSpace(body.Label)
	if len(body.Label) > 200 {
		body.Label = body.Label[:200]
	}
	return &body, nil
}

func draftID(r *http.Request) (string, error) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return "", store.ErrNotFound
	}
	return id, nil
}

// --- Entwürfe ---------------------------------------------------------------

func (s *Server) createDraft(w http.ResponseWriter, r *http.Request) {
	body, err := readDraftBody(w, r, true)
	if err != nil {
		writeError(w, err)
		return
	}
	label := body.Label
	if label == "" {
		label = "Erste Version"
	}
	id, token, err := s.store.Create(body.Doc, label)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "editToken": token, "doc": body.Doc, "updatedAt": body.Doc.UpdatedAt})
}

func (s *Server) getDraft(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	doc, meta, err := s.store.Get(id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "name": meta.Name, "doc": doc, "createdAt": meta.CreatedAt, "updatedAt": meta.UpdatedAt, "versionCount": len(meta.Versions),
	})
}

func (s *Server) saveDraft(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	body, err := readDraftBody(w, r, true)
	if err != nil {
		writeError(w, err)
		return
	}
	label := body.Label
	if label == "" {
		label = "Gespeichert"
	}
	meta, err := s.store.Save(id, r.Header.Get(editTokenHeader), body.Doc, label)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "updatedAt": meta.UpdatedAt, "versionCount": len(meta.Versions), "doc": body.Doc})
}

func (s *Server) deleteDraft(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := s.store.Delete(id, r.Header.Get(editTokenHeader)); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authDraft(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := s.store.Authorize(id, r.Header.Get(editTokenHeader)); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) forkDraft(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	body, err := readDraftBody(w, r, false)
	if err != nil {
		writeError(w, err)
		return
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > model.MaxNameLen {
		name = name[:model.MaxNameLen]
	}
	newID, token, err := s.store.Fork(id, name)
	if err != nil {
		writeError(w, err)
		return
	}
	doc, _, err := s.store.Get(newID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": newID, "editToken": token, "doc": doc})
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	versions, err := s.store.Versions(id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n <= 0 {
		writeError(w, store.ErrNotFound)
		return
	}
	doc, info, err := s.store.Version(id, n)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"n": info.N, "at": info.At, "label": info.Label, "stats": info.Stats, "doc": doc})
}

// --- Kommentare ----------------------------------------------------------------

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	list, err := s.store.Comments(id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) addComment(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var in struct {
		Lat    float64 `json:"lat"`
		Lng    float64 `json:"lng"`
		Author string  `json:"author"`
		Text   string  `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, errors.Join(store.ErrBadComment, errors.New("kein gültiges JSON")))
		return
	}
	c, token, err := s.store.AddComment(id, store.Comment{Lat: in.Lat, Lng: in.Lng, Author: in.Author, Text: in.Text})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"comment": c, "commentToken": token})
}

func (s *Server) resolveComment(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	cid := r.PathValue("cid")
	if !store.ValidID(cid) {
		writeError(w, store.ErrNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var in struct {
		Resolved bool `json:"resolved"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, errors.Join(store.ErrBadComment, errors.New("kein gültiges JSON")))
		return
	}
	if err := s.store.ResolveComment(id, cid, r.Header.Get(editTokenHeader), r.Header.Get(commentTokenHeader), in.Resolved); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	cid := r.PathValue("cid")
	if !store.ValidID(cid) {
		writeError(w, store.ErrNotFound)
		return
	}
	if err := s.store.DeleteComment(id, cid, r.Header.Get(editTokenHeader), r.Header.Get(commentTokenHeader)); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- OSM ----------------------------------------------------------------------

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	places, err := s.osm.Search(r.Context(), r.URL.Query().Get("q"), limit)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=600")
	writeJSON(w, http.StatusOK, places)
}

func (s *Server) roads(w http.ResponseWriter, r *http.Request) {
	bbox, err := osm.ParseBBox(r.URL.Query().Get("bbox"))
	if err != nil {
		writeError(w, err)
		return
	}
	ways, err := s.osm.Roads(r.Context(), bbox)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ways)
}

func (s *Server) tile(w http.ResponseWriter, r *http.Request) {
	z, errZ := strconv.Atoi(r.PathValue("z"))
	x, errX := strconv.Atoi(r.PathValue("x"))
	y, errY := strconv.Atoi(strings.TrimSuffix(r.PathValue("y"), ".png"))
	if errZ != nil || errX != nil || errY != nil {
		http.NotFound(w, r)
		return
	}
	data, ctype, err := s.osm.Tile(r.Context(), z, x, y)
	if err != nil {
		if errors.Is(err, osm.ErrBadRequest) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

// --- Oberfläche ---------------------------------------------------------------

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(s.index)
}
