// Package osm kapselt die Zugriffe auf OpenStreetMap-Dienste: Nominatim
// (Ortssuche), Overpass (Strassengeometrie) und Kachel-Server. Der Server
// tritt gegenüber OSM mit einem sauberen User-Agent auf, drosselt und cacht,
// damit die Nutzungsbedingungen auch mit mehreren Browsern eingehalten werden.
package osm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultNominatimURL = "https://nominatim.openstreetmap.org/search"
	DefaultOverpassURL  = "https://overpass-api.de/api/interpreter"
	DefaultTileURL      = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
	DefaultUserAgent    = "Stadtplaner/1.0 (+https://github.com/CDRO/OpenStreetPlaner)"

	MaxTileZoom     = 19
	MaxBBoxSpan     = 0.06 // Grad; entspricht etwa Zoom 15 auf einem grossen Bildschirm
	searchCacheTTL  = time.Hour
	roadsCacheTTL   = 10 * time.Minute
	tileCacheTTL    = 7 * 24 * time.Hour
	nominatimMinGap = time.Second
	maxCacheEntries = 2000
)

var ErrBadRequest = errors.New("ungültige Anfrage")

type Place struct {
	Label string      `json:"label"`
	Lat   float64     `json:"lat"`
	Lng   float64     `json:"lng"`
	Type  string      `json:"type"`
	BBox  *[4]float64 `json:"bbox,omitempty"` // south, north, west, east (wie Nominatim)
}

type Way struct {
	ID       int64             `json:"id"`
	Tags     map[string]string `json:"tags"`
	Geometry [][2]float64      `json:"geometry"`
}

type BBox struct{ South, West, North, East float64 }

func ParseBBox(s string) (BBox, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return BBox{}, fmt.Errorf("%w: bbox braucht south,west,north,east", ErrBadRequest)
	}
	var v [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return BBox{}, fmt.Errorf("%w: bbox ist keine Zahl", ErrBadRequest)
		}
		v[i] = f
	}
	b := BBox{South: v[0], West: v[1], North: v[2], East: v[3]}
	if b.South >= b.North || b.West >= b.East || b.South < -90 || b.North > 90 || b.West < -180 || b.East > 180 {
		return BBox{}, fmt.Errorf("%w: bbox ausserhalb des gültigen Bereichs", ErrBadRequest)
	}
	if b.North-b.South > MaxBBoxSpan || b.East-b.West > MaxBBoxSpan {
		return BBox{}, fmt.Errorf("%w: bbox zu gross (max. %.2f Grad), näher heranzoomen", ErrBadRequest, MaxBBoxSpan)
	}
	return b, nil
}

type cacheEntry struct {
	at   time.Time
	data []byte
}

type memCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	entries map[string]cacheEntry
}

func newMemCache(ttl time.Duration) *memCache {
	return &memCache{ttl: ttl, entries: map[string]cacheEntry{}}
}

func (c *memCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.at) > c.ttl {
		delete(c.entries, key)
		return nil, false
	}
	return e.data, true
}

func (c *memCache) set(key string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= maxCacheEntries {
		for k, e := range c.entries { // grob aufräumen: abgelaufene zuerst, sonst irgendeinen
			if time.Since(e.at) > c.ttl || len(c.entries) >= maxCacheEntries {
				delete(c.entries, k)
			}
			if len(c.entries) < maxCacheEntries/2 {
				break
			}
		}
	}
	c.entries[key] = cacheEntry{at: time.Now(), data: data}
}

type Client struct {
	HTTP         *http.Client
	UserAgent    string
	NominatimURL string
	OverpassURL  string
	TileURL      string
	TileDir      string
	ProfileURL   string
	ParcelURL    string

	searchCache  *memCache
	roadsCache   *memCache
	nomMu        sync.Mutex
	nomLast      time.Time
	tileMu       sync.Mutex
	tileInFly    map[string]chan struct{}
	sources      map[string]TileSource
	sourceOrder  []string
	profileCache *memCache
	parcelCache  *memCache
	bldgCache    *memCache
	transitCache *memCache
	parkingCache *memCache
	// Fahrplan-Dienst (transport.opendata.ch), leer = aus
	TimetableURL   string
	timetableCache *memCache
}

// Building ist ein Gebäude aus OSM: geschlossener Umring als [lat, lng].
type Building struct {
	ID       int64             `json:"id"`
	Tags     map[string]string `json:"tags"`
	Geometry [][2]float64      `json:"geometry"`
}

func New(tileDir string) *Client {
	return &Client{
		HTTP:         &http.Client{Timeout: 30 * time.Second},
		UserAgent:    DefaultUserAgent,
		NominatimURL: DefaultNominatimURL,
		OverpassURL:  DefaultOverpassURL,
		TileURL:      DefaultTileURL,
		TileDir:      tileDir,
		ProfileURL:   DefaultProfileURL,
		ParcelURL:    DefaultParcelURL,
		TimetableURL: DefaultTimetableURL,
		searchCache:  newMemCache(searchCacheTTL),
		roadsCache:   newMemCache(roadsCacheTTL),
		tileInFly:    map[string]chan struct{}{},
	}
}

func (c *Client) do(req *http.Request) ([]byte, string, error) {
	req.Header.Set("User-Agent", c.UserAgent)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode != http.StatusOK {
		// Bei 4xx erklärt der Dienst meist, was falsch ist – kurz mitgeben, damit es in Meldung und Log steht
		msg := fmt.Sprintf("Upstream antwortet mit %d", res.StatusCode)
		if res.StatusCode >= 400 && res.StatusCode < 500 {
			if excerpt := bodyExcerpt(body, 200); excerpt != "" {
				msg += ": " + excerpt
			}
		}
		return nil, "", errors.New(msg)
	}
	return body, res.Header.Get("Content-Type"), nil
}

// bodyExcerpt macht aus einer Fehlerantwort eine einzeilige Kurzfassung (JSON-Feld message/error, sonst Text).
func bodyExcerpt(body []byte, max int) string {
	var obj map[string]any
	text := ""
	if json.Unmarshal(body, &obj) == nil {
		for _, k := range []string{"message", "error", "detail", "msg"} {
			if v, ok := obj[k]; ok {
				if sv, ok := v.(string); ok {
					text = sv
				} else if mv, ok := v.(map[string]any); ok {
					if sv, ok := mv["message"].(string); ok {
						text = sv
					}
				}
				if text != "" {
					break
				}
			}
		}
	}
	if text == "" {
		text = string(body)
	}
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > max {
		text = text[:max] + "…"
	}
	return text
}

// Search fragt Nominatim ab (max. eine Anfrage pro Sekunde, Ergebnisse gecacht).
func (c *Client) Search(ctx context.Context, q string, limit int) ([]Place, error) {
	q = strings.TrimSpace(q)
	if q == "" || len(q) > 200 {
		return nil, fmt.Errorf("%w: Suchtext fehlt oder ist zu lang", ErrBadRequest)
	}
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	key := strings.ToLower(q) + "|" + strconv.Itoa(limit)
	if data, ok := c.searchCache.get(key); ok {
		var out []Place
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	if err := c.waitNominatim(ctx); err != nil {
		return nil, err
	}
	params := url.Values{"format": {"jsonv2"}, "q": {q}, "limit": {strconv.Itoa(limit)}, "accept-language": {"de"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.NominatimURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Suche: %w", err)
	}
	var raw []struct {
		DisplayName string   `json:"display_name"`
		Lat         string   `json:"lat"`
		Lon         string   `json:"lon"`
		Type        string   `json:"type"`
		BoundingBox []string `json:"boundingbox"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("Suche: unlesbare Antwort")
	}
	out := make([]Place, 0, len(raw))
	for _, r := range raw {
		lat, err1 := strconv.ParseFloat(r.Lat, 64)
		lng, err2 := strconv.ParseFloat(r.Lon, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		p := Place{Label: r.DisplayName, Lat: lat, Lng: lng, Type: r.Type}
		if len(r.BoundingBox) == 4 {
			var bb [4]float64
			ok := true
			for i, s := range r.BoundingBox {
				f, err := strconv.ParseFloat(s, 64)
				if err != nil {
					ok = false
					break
				}
				bb[i] = f
			}
			if ok {
				p.BBox = &bb
			}
		}
		out = append(out, p)
	}
	data, _ := json.Marshal(out)
	c.searchCache.set(key, data)
	return out, nil
}

// waitNominatim hält den Mindestabstand zwischen zwei Anfragen ein.
func (c *Client) waitNominatim(ctx context.Context) error {
	c.nomMu.Lock()
	defer c.nomMu.Unlock()
	wait := nominatimMinGap - time.Since(c.nomLast)
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	c.nomLast = time.Now()
	return nil
}

// Roads lädt alle highway-Ways im Bereich über Overpass.
func (c *Client) Roads(ctx context.Context, b BBox) ([]Way, error) {
	key := fmt.Sprintf("%.4f,%.4f,%.4f,%.4f", b.South, b.West, b.North, b.East)
	if data, ok := c.roadsCache.get(key); ok {
		var out []Way
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	query := fmt.Sprintf(`[out:json][timeout:25];way["highway"](%.6f,%.6f,%.6f,%.6f);out geom;`, b.South, b.West, b.North, b.East)
	form := url.Values{"data": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OverpassURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Strassen laden: %w", err)
	}
	var raw struct {
		Elements []struct {
			Type     string            `json:"type"`
			ID       int64             `json:"id"`
			Tags     map[string]string `json:"tags"`
			Geometry []struct {
				Lat float64 `json:"lat"`
				Lon float64 `json:"lon"`
			} `json:"geometry"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("Strassen laden: unlesbare Antwort")
	}
	out := make([]Way, 0, len(raw.Elements))
	for _, el := range raw.Elements {
		if el.Type != "way" || len(el.Geometry) < 2 {
			continue
		}
		w := Way{ID: el.ID, Tags: el.Tags, Geometry: make([][2]float64, len(el.Geometry))}
		if w.Tags == nil {
			w.Tags = map[string]string{}
		}
		for i, g := range el.Geometry {
			w.Geometry[i] = [2]float64{g.Lat, g.Lon}
		}
		out = append(out, w)
	}
	data, _ := json.Marshal(out)
	c.roadsCache.set(key, data)
	return out, nil
}

// Buildings liefert die Gebäude-Umringe (OSM building=*) eines Bereichs (max. 0.06°).
func (c *Client) Buildings(ctx context.Context, b BBox) ([]Building, error) {
	if c.bldgCache == nil {
		c.bldgCache = newMemCache(roadsCacheTTL)
	}
	key := fmt.Sprintf("b:%.4f,%.4f,%.4f,%.4f", b.South, b.West, b.North, b.East)
	if data, ok := c.bldgCache.get(key); ok {
		var out []Building
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	query := fmt.Sprintf(`[out:json][timeout:25];way["building"](%.6f,%.6f,%.6f,%.6f);out geom;`, b.South, b.West, b.North, b.East)
	form := url.Values{"data": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OverpassURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Gebäude laden: %w", err)
	}
	var raw struct {
		Elements []struct {
			Type     string            `json:"type"`
			ID       int64             `json:"id"`
			Tags     map[string]string `json:"tags"`
			Geometry []struct {
				Lat float64 `json:"lat"`
				Lon float64 `json:"lon"`
			} `json:"geometry"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("Gebäude laden: unlesbare Antwort")
	}
	out := make([]Building, 0, len(raw.Elements))
	for _, el := range raw.Elements {
		if el.Type != "way" || len(el.Geometry) < 4 {
			continue
		}
		bld := Building{ID: el.ID, Geometry: make([][2]float64, len(el.Geometry))}
		// Nur die für die Analyse nötigen Tags behalten
		bld.Tags = map[string]string{}
		for _, k := range []string{"building", "name", "addr:street", "addr:housenumber", "building:levels"} {
			if v, ok := el.Tags[k]; ok {
				bld.Tags[k] = v
			}
		}
		for i, g := range el.Geometry {
			bld.Geometry[i] = [2]float64{g.Lat, g.Lon}
		}
		out = append(out, bld)
	}
	data, _ := json.Marshal(out)
	c.bldgCache.set(key, data)
	return out, nil
}

// Tile liefert eine Kachel der Standardquelle (TileURL) aus dem Platten-Cache oder vom Kachel-Server.
func (c *Client) Tile(ctx context.Context, z, x, y int) ([]byte, string, error) {
	return c.tile(ctx, TileSource{ID: "", URL: c.TileURL, MaxZoom: MaxTileZoom, Ext: "png"}, z, x, y)
}

// TileFrom liefert eine Kachel einer benannten Quelle.
func (c *Client) TileFrom(ctx context.Context, sourceID string, z, x, y int) ([]byte, string, error) {
	src, ok := c.source(sourceID)
	if !ok {
		return nil, "", fmt.Errorf("%w: unbekannte Kartenquelle %q", ErrBadRequest, sourceID)
	}
	return c.tile(ctx, src, z, x, y)
}

func (c *Client) tile(ctx context.Context, src TileSource, z, x, y int) ([]byte, string, error) {
	maxZoom := src.MaxZoom
	if maxZoom <= 0 || maxZoom > 22 {
		maxZoom = MaxTileZoom
	}
	if z < 0 || z > maxZoom {
		return nil, "", fmt.Errorf("%w: Zoom %d", ErrBadRequest, z)
	}
	n := 1 << uint(z)
	if x < 0 || x >= n || y < 0 || y >= n {
		return nil, "", fmt.Errorf("%w: Kachel ausserhalb", ErrBadRequest)
	}
	ext := src.Ext
	if ext == "" {
		ext = "png"
	}
	ctype := "image/" + ext
	dir := c.TileDir
	if src.ID != "" && dir != "" {
		dir = filepath.Join(dir, src.ID)
	}
	path := filepath.Join(dir, strconv.Itoa(z), strconv.Itoa(x), strconv.Itoa(y)+"."+ext)
	if data, ok := c.readTileCache(path); ok {
		return data, ctype, nil
	}
	key := path
	// Gleichzeitige Anfragen derselben Kachel nur einmal nach oben schicken.
	c.tileMu.Lock()
	if ch, busy := c.tileInFly[key]; busy {
		c.tileMu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, "", ctx.Err()
		}
		if data, ok := c.readTileCache(path); ok {
			return data, ctype, nil
		}
	} else {
		ch := make(chan struct{})
		c.tileInFly[key] = ch
		c.tileMu.Unlock()
		defer func() {
			c.tileMu.Lock()
			delete(c.tileInFly, key)
			c.tileMu.Unlock()
			close(ch)
		}()
	}
	u := expandTileURL(src.URL, z, x, y)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", err
	}
	data, upstreamType, err := c.do(req)
	if err != nil {
		return nil, "", fmt.Errorf("Kachel laden: %w", err)
	}
	if strings.HasPrefix(upstreamType, "image/") {
		ctype = upstreamType
	}
	if c.TileDir != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
			tmp := path + ".tmp"
			if os.WriteFile(tmp, data, 0o644) == nil {
				_ = os.Rename(tmp, path)
			}
		}
	}
	return data, ctype, nil
}

func (c *Client) readTileCache(path string) ([]byte, bool) {
	if c.TileDir == "" {
		return nil, false
	}
	st, err := os.Stat(path)
	if err != nil || time.Since(st.ModTime()) > tileCacheTTL {
		return nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	return data, true
}
