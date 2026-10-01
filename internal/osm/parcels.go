package osm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultParcelURL ist der Identify-Dienst von geo.admin (amtliche Vermessung, nur Schweiz).
const DefaultParcelURL = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"

// ParcelLayer ist die Ebene der Liegenschaften der amtlichen Vermessung.
const ParcelLayer = "ch.swisstopo-vd.amtliche-vermessung"

const (
	MaxParcelCoords = 500
	parcelChunk     = 25 // Punkte je Identify-Anfrage (URL-Länge)
	parcelCacheTTL  = 6 * time.Hour
)

// Parcel ist eine Liegenschaft: Kennungen und Umring(e) als [lat, lng]-Ringe (erster Ring aussen).
type Parcel struct {
	ID       string           `json:"id"`
	Egrid    string           `json:"egrid"`
	Number   string           `json:"number"`
	Label    string           `json:"label"`
	Canton   string           `json:"canton"`
	Polygons [][][][2]float64 `json:"polygons"` // Polygone -> Ringe -> Punkte
}

// Parcels liefert die Parzellen, die eine Linie ([lat, lng]) berührt. Leere ParcelURL = deaktiviert.
func (c *Client) Parcels(ctx context.Context, coords [][2]float64) ([]Parcel, error) {
	if c.ParcelURL == "" {
		return nil, fmt.Errorf("%w: Parzellenabfrage ist auf diesem Server nicht aktiviert", ErrBadRequest)
	}
	if len(coords) < 2 || len(coords) > MaxParcelCoords {
		return nil, fmt.Errorf("%w: 2 bis %d Punkte", ErrBadRequest, MaxParcelCoords)
	}
	for _, p := range coords {
		if p[0] < -90 || p[0] > 90 || p[1] < -180 || p[1] > 180 {
			return nil, fmt.Errorf("%w: Koordinate ausserhalb", ErrBadRequest)
		}
	}
	if c.parcelCache == nil {
		c.parcelCache = newMemCache(parcelCacheTTL)
	}
	raw, _ := json.Marshal(coords)
	sum := sha256.Sum256(raw)
	key := hex.EncodeToString(sum[:])
	if data, ok := c.parcelCache.get(key); ok {
		var out []Parcel
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	seen := map[string]bool{}
	out := []Parcel{}
	for start := 0; start < len(coords)-1; start += parcelChunk - 1 {
		end := start + parcelChunk
		if end > len(coords) {
			end = len(coords)
		}
		chunk, err := c.identifyParcels(ctx, coords[start:end])
		if err != nil {
			return nil, err
		}
		for _, p := range chunk {
			id := p.ID
			if id == "" {
				id = p.Egrid + "|" + p.Number
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, p)
		}
		if end == len(coords) {
			break
		}
	}
	data, _ := json.Marshal(out)
	c.parcelCache.set(key, data)
	return out, nil
}

func (c *Client) identifyParcels(ctx context.Context, coords [][2]float64) ([]Parcel, error) {
	path := make([][2]float64, len(coords))
	for i, p := range coords {
		path[i] = [2]float64{p[1], p[0]} // Esri/GeoJSON: lng, lat
	}
	geom, _ := json.Marshal(map[string]any{"paths": [][][2]float64{path}})
	params := url.Values{
		"geometryType":   {"esriGeometryPolyline"},
		"geometry":       {string(geom)},
		"layers":         {"all:" + ParcelLayer},
		"tolerance":      {"0"},
		"sr":             {"4326"},
		"returnGeometry": {"true"},
		"geometryFormat": {"geojson"},
		"lang":           {"de"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.ParcelURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Parzellen: %w", err)
	}
	var resp struct {
		Results []struct {
			ID         any             `json:"id"`
			FeatureID  any             `json:"featureId"`
			Attributes map[string]any  `json:"attributes"`
			Properties map[string]any  `json:"properties"`
			Geometry   json.RawMessage `json:"geometry"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("Parzellen: unlesbare Antwort")
	}
	out := make([]Parcel, 0, len(resp.Results))
	for _, r := range resp.Results {
		attrs := r.Attributes
		if attrs == nil {
			attrs = r.Properties
		}
		p := Parcel{
			ID:     anyString(r.FeatureID),
			Egrid:  pick(attrs, "egris_egrid", "egrid"),
			Number: pick(attrs, "number", "nummer", "parcel_number"),
			Label:  pick(attrs, "label", "realestate_type"),
			Canton: pick(attrs, "ak", "canton", "kanton"),
		}
		if p.ID == "" {
			p.ID = anyString(r.ID)
		}
		p.Polygons = parseGeoJSONPolygons(r.Geometry)
		out = append(out, p)
	}
	return out, nil
}

func pick(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s := strings.TrimSpace(anyString(v)); s != "" {
				return s
			}
		}
	}
	return ""
}

func anyString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

// parseGeoJSONPolygons liest Polygon oder MultiPolygon (lng, lat) in [lat, lng]-Ringe.
func parseGeoJSONPolygons(raw json.RawMessage) [][][][2]float64 {
	if len(raw) == 0 {
		return nil
	}
	var g struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil
	}
	flip := func(rings [][][2]float64) [][][2]float64 {
		out := make([][][2]float64, 0, len(rings))
		for _, ring := range rings {
			r := make([][2]float64, len(ring))
			for i, p := range ring {
				r[i] = [2]float64{p[1], p[0]}
			}
			out = append(out, r)
		}
		return out
	}
	switch g.Type {
	case "Polygon":
		var rings [][][2]float64
		if err := json.Unmarshal(g.Coordinates, &rings); err != nil {
			return nil
		}
		return [][][][2]float64{flip(rings)}
	case "MultiPolygon":
		var polys [][][][2]float64
		if err := json.Unmarshal(g.Coordinates, &polys); err != nil {
			return nil
		}
		out := make([][][][2]float64, 0, len(polys))
		for _, p := range polys {
			out = append(out, flip(p))
		}
		return out
	}
	return nil
}
