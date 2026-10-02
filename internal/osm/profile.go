package osm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultProfileURL ist der Höhenprofil-Dienst von swisstopo (nur Schweiz).
const DefaultProfileURL = "https://api3.geo.admin.ch/rest/services/profile.json"

const (
	MaxProfileCoords = 500
	profileCacheTTL  = 6 * time.Hour
)

// ProfilePoint ist ein Punkt des Höhenprofils: Distanz entlang der Linie (m) und Höhe (m ü. M.).
type ProfilePoint struct {
	Dist   float64 `json:"dist"`
	Height float64 `json:"height"`
}

// Profile fragt das Höhenprofil einer Linie ([lat, lng]) ab. Leere ProfileURL = deaktiviert.
func (c *Client) Profile(ctx context.Context, coords [][2]float64) ([]ProfilePoint, error) {
	if c.ProfileURL == "" {
		return nil, fmt.Errorf("%w: Höhenprofil ist auf diesem Server nicht aktiviert", ErrBadRequest)
	}
	if len(coords) < 2 || len(coords) > MaxProfileCoords {
		return nil, fmt.Errorf("%w: 2 bis %d Punkte", ErrBadRequest, MaxProfileCoords)
	}
	for _, p := range coords {
		if p[0] < -90 || p[0] > 90 || p[1] < -180 || p[1] > 180 {
			return nil, fmt.Errorf("%w: Koordinate ausserhalb", ErrBadRequest)
		}
	}
	if c.profileCache == nil {
		c.profileCache = newMemCache(profileCacheTTL)
	}
	raw, _ := json.Marshal(coords)
	sum := sha256.Sum256(raw)
	key := hex.EncodeToString(sum[:])
	if data, ok := c.profileCache.get(key); ok {
		var out []ProfilePoint
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	// Der Profildienst nimmt nur Landeskoordinaten (sr 2056 = LV95 oder 21781 = LV03); mit 4326 antwortet er 400.
	line := make([][2]float64, len(coords))
	for i, p := range coords {
		e, n := WGS84ToLV95(p[0], p[1])
		line[i] = [2]float64{e, n}
	}
	geom, _ := json.Marshal(map[string]any{"type": "LineString", "coordinates": line})
	params := url.Values{"geom": {string(geom)}, "sr": {"2056"}, "nb_points": {"200"}, "distinct_points": {"true"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ProfileURL, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Höhenprofil: %w", err)
	}
	var resp []struct {
		Dist float64            `json:"dist"`
		Alts map[string]float64 `json:"alts"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("Höhenprofil: unlesbare Antwort")
	}
	out := make([]ProfilePoint, 0, len(resp))
	for _, r := range resp {
		h, ok := pickAlt(r.Alts)
		if !ok {
			continue
		}
		out = append(out, ProfilePoint{Dist: r.Dist, Height: h})
	}
	if len(out) < 2 {
		return nil, fmt.Errorf("%w: keine Höhendaten für diese Linie (Dienst deckt nur die Schweiz ab)", ErrBadRequest)
	}
	data, _ := json.Marshal(out)
	c.profileCache.set(key, data)
	return out, nil
}

// WGS84ToLV95 rechnet nach den Näherungsformeln von swisstopo um (Genauigkeit rund 1 m);
// dieselben Formeln wie im DXF-Export (web/js/dxf.js). Liefert Ost- und Nordwert.
func WGS84ToLV95(lat, lon float64) (float64, float64) {
	phi := (lat*3600 - 169028.66) / 10000
	lam := (lon*3600 - 26782.5) / 10000
	east := 2600072.37 + 211455.93*lam - 10938.51*lam*phi - 0.36*lam*phi*phi - 44.54*lam*lam*lam
	north := 1200147.07 + 308807.95*phi + 3745.25*lam*lam + 76.63*phi*phi - 194.56*lam*lam*phi + 119.79*phi*phi*phi
	return math.Round(east*100) / 100, math.Round(north*100) / 100
}

func pickAlt(alts map[string]float64) (float64, bool) {
	for _, k := range []string{"COMB", "DTM2", "DTM25"} {
		if v, ok := alts[k]; ok && v > -1000 {
			return v, true
		}
	}
	for _, v := range alts {
		if v > -1000 {
			return v, true
		}
	}
	return 0, false
}
