package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// ParkingArea ist ein Parkplatz aus OSM (amenity=parking) als Umring mit den für die Bilanz nötigen Tags.
type ParkingArea struct {
	ID       int64             `json:"id"`
	Tags     map[string]string `json:"tags"`
	Geometry [][2]float64      `json:"geometry"`
}

// Parking liefert die Parkplatz-Umringe (OSM amenity=parking) eines Bereichs (max. 0.06°).
func (c *Client) Parking(ctx context.Context, b BBox) ([]ParkingArea, error) {
	if c.parkingCache == nil {
		c.parkingCache = newMemCache(roadsCacheTTL)
	}
	key := fmt.Sprintf("p:%.4f,%.4f,%.4f,%.4f", b.South, b.West, b.North, b.East)
	if data, ok := c.parkingCache.get(key); ok {
		var out []ParkingArea
		_ = json.Unmarshal(data, &out)
		return out, nil
	}
	query := fmt.Sprintf(`[out:json][timeout:25];way["amenity"="parking"](%.6f,%.6f,%.6f,%.6f);out geom;`, b.South, b.West, b.North, b.East)
	form := url.Values{"data": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OverpassURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("Parkplätze laden: %w", err)
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
		return nil, fmt.Errorf("Parkplätze laden: unlesbare Antwort")
	}
	out := make([]ParkingArea, 0, len(raw.Elements))
	for _, el := range raw.Elements {
		if el.Type != "way" || len(el.Geometry) < 4 {
			continue
		}
		pa := ParkingArea{ID: el.ID, Tags: map[string]string{}, Geometry: make([][2]float64, len(el.Geometry))}
		for _, k := range []string{"amenity", "parking", "capacity", "name", "access", "fee"} {
			if v, ok := el.Tags[k]; ok {
				pa.Tags[k] = v
			}
		}
		for i, g := range el.Geometry {
			pa.Geometry[i] = [2]float64{g.Lat, g.Lon}
		}
		out = append(out, pa)
	}
	data, _ := json.Marshal(out)
	c.parkingCache.set(key, data)
	return out, nil
}
