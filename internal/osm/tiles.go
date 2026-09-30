package osm

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// TileSource ist eine benannte Kartenquelle. URL ist eine Vorlage mit {z}/{x}/{y}
// oder {bbox} (EPSG:3857 minx,miny,maxx,maxy für WMS-Dienste).
type TileSource struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	URL         string `json:"url,omitempty"`
	Attribution string `json:"attribution"`
	MinZoom     int    `json:"minZoom"`
	MaxZoom     int    `json:"maxZoom"`
	Overlay     bool   `json:"overlay"`
	Ext         string `json:"-"`
}

// Public ist die Sicht für den Browser (ohne Upstream-URL).
func (t TileSource) Public() TileSource {
	t.URL = ""
	return t
}

const mercatorHalf = 20037508.342789244

// DefaultTileSources: OpenStreetMap plus die frei nutzbaren swisstopo-Dienste.
// Die swisstopo-Ebenennamen entsprechen dem Stand der API-Dokumentation von
// api3.geo.admin.ch; bei Änderungen lassen sie sich über TILE_SOURCES ersetzen.
func DefaultTileSources() []TileSource {
	return []TileSource{
		{ID: "osm", Label: "OpenStreetMap", URL: DefaultTileURL, Attribution: "© OpenStreetMap-Mitwirkende", MaxZoom: 19, Ext: "png"},
		{ID: "swisstopo", Label: "Landeskarte (swisstopo)", URL: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg", Attribution: "© swisstopo", MaxZoom: 18, Ext: "jpeg"},
		{ID: "swisstopo-grau", Label: "Landeskarte grau (swisstopo)", URL: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg", Attribution: "© swisstopo", MaxZoom: 18, Ext: "jpeg"},
		{ID: "swissimage", Label: "Luftbild (swisstopo)", URL: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg", Attribution: "© swisstopo", MaxZoom: 20, Ext: "jpeg"},
		{ID: "cadastre", Label: "Parzellen (amtliche Vermessung)", URL: "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ch.swisstopo-vd.amtliche-vermessung&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true", Attribution: "© swisstopo / Kantone", MinZoom: 15, MaxZoom: 20, Overlay: true, Ext: "png"},
	}
}

// ParseTileSources liest zusätzliche oder ersetzende Quellen aus JSON (env TILE_SOURCES).
func ParseTileSources(text string) ([]TileSource, error) {
	var list []TileSource
	if err := json.Unmarshal([]byte(text), &list); err != nil {
		return nil, fmt.Errorf("TILE_SOURCES: %w", err)
	}
	for i := range list {
		if list[i].ID == "" || list[i].URL == "" {
			return nil, fmt.Errorf("TILE_SOURCES: Eintrag %d braucht id und url", i)
		}
		if list[i].MaxZoom == 0 {
			list[i].MaxZoom = 19
		}
		if list[i].Ext == "" {
			list[i].Ext = "png"
			if strings.Contains(strings.ToLower(list[i].URL), "jpeg") || strings.Contains(strings.ToLower(list[i].URL), "jpg") {
				list[i].Ext = "jpeg"
			}
		}
	}
	return list, nil
}

// SetSources ersetzt die Quellen; gleiche IDs überschreiben Vorgaben.
func (c *Client) SetSources(list []TileSource) {
	if c.sources == nil {
		c.sources = map[string]TileSource{}
		c.sourceOrder = nil
	}
	for _, s := range list {
		if _, exists := c.sources[s.ID]; !exists {
			c.sourceOrder = append(c.sourceOrder, s.ID)
		}
		c.sources[s.ID] = s
	}
}

// Sources liefert die Quellen in Reihenfolge (für die Oberfläche).
func (c *Client) Sources() []TileSource {
	out := make([]TileSource, 0, len(c.sourceOrder))
	for _, id := range c.sourceOrder {
		out = append(out, c.sources[id].Public())
	}
	return out
}

func (c *Client) source(id string) (TileSource, bool) {
	if c.sources == nil {
		return TileSource{}, false
	}
	s, ok := c.sources[id]
	return s, ok
}

// TileBBox3857 liefert die Kachelgrenzen in Web-Mercator-Metern.
func TileBBox3857(z, x, y int) (minx, miny, maxx, maxy float64) {
	n := math.Exp2(float64(z))
	size := 2 * mercatorHalf / n
	minx = -mercatorHalf + float64(x)*size
	maxx = minx + size
	maxy = mercatorHalf - float64(y)*size
	miny = maxy - size
	return
}

func expandTileURL(tpl string, z, x, y int) string {
	r := strings.NewReplacer("{z}", strconv.Itoa(z), "{x}", strconv.Itoa(x), "{y}", strconv.Itoa(y))
	out := r.Replace(tpl)
	if strings.Contains(out, "{bbox}") {
		minx, miny, maxx, maxy := TileBBox3857(z, x, y)
		out = strings.ReplaceAll(out, "{bbox}", fmt.Sprintf("%.4f,%.4f,%.4f,%.4f", minx, miny, maxx, maxy))
	}
	return out
}
