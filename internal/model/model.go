// Package model beschreibt einen Entwurf (Ebenen, Strassen mit Abschnitten,
// Kreuzungen, Kreisel) und prüft eingehende Daten. Die Regeln entsprechen
// denen des Frontends (web/js/model.js): strukturelle Fehler werden abgelehnt,
// unbekannte Aufzählungswerte auf Vorgaben gesetzt.
package model

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

const (
	Version      = 1
	MaxLayers    = 100
	MaxFeatures  = 20000
	MaxRoadNodes = 5000
	MaxZoneNodes = 2000
	MaxNameLen   = 200
	MaxNoteLen   = 2000
	MaxRadius    = 500.0
	MaxSpeed     = 200.0
	MaxWidth     = 60.0
	MaxCost      = 1e10
	MaxCostKeys  = 50
)

var (
	idPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,48}$`)
	colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	costKey      = regexp.MustCompile(`^[a-z0-9.]{1,40}$`)

	RoadKinds     = []string{"motorway", "trunk", "main", "secondary", "residential", "service", "path", "other"}
	Levels        = []string{"ground", "bridge", "tunnel"}
	Statuses      = []string{"new", "existing", "remove"}
	JunctionKinds = []string{"plain", "signals", "priority", "stop", "interchange", "crossing", "busstop"}
	ZoneKinds     = []string{"tempo30", "tempo20", "pedestrian", "parking", "other"}
	LayerColors   = []string{"#d7263d", "#1b6ac9", "#2a9d3f", "#e08a00", "#7b3fbf", "#0e9aa7", "#c2185b", "#5d4037"}
)

type LatLng [2]float64

type View struct {
	Center LatLng  `json:"center"`
	Zoom   float64 `json:"zoom"`
}

type Layer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Color   string `json:"color"`
	Visible *bool  `json:"visible"`
}

type Segment struct {
	Level    string   `json:"level"`
	Maxspeed *float64 `json:"maxspeed"`         // km/h; nil = wie die Strasse
	Access   string   `json:"access,omitempty"` // "" = wie die Strasse, "all", "bus" (Busschleuse)
}

// BusLine ist eine Buslinie: Haltestellen (IDs von Punkten der Art busstop) in Reihenfolge.
type BusLine struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Color string   `json:"color"`
	Stops []string `json:"stops"`
	Dwell float64  `json:"dwell"` // Sekunden Halt je Zwischenhaltestelle
}

const (
	MaxBusLines = 20
	MaxBusStops = 60
)

var accessValues = []string{"all", "bus"}

// Section ist der Querschnitt einer Strasse in Metern (Regeln wie web/js/model.js).
type Section struct {
	Lanes     int     `json:"lanes"`
	LaneWidth float64 `json:"laneWidth"`
	Median    float64 `json:"median"`
	Shoulder  float64 `json:"shoulder"`
	BikeLeft  bool    `json:"bikeLeft"`
	BikeRight bool    `json:"bikeRight"`
	BikeWidth float64 `json:"bikeWidth"`
	WalkLeft  bool    `json:"walkLeft"`
	WalkRight bool    `json:"walkRight"`
	WalkWidth float64 `json:"walkWidth"`
	ParkLeft  bool    `json:"parkLeft"`
	ParkRight bool    `json:"parkRight"`
	ParkWidth float64 `json:"parkWidth"`
}

// Width ist die Gesamtbreite des Querschnitts in Metern.
func (s Section) Width() float64 {
	w := float64(s.Lanes)*s.LaneWidth + 2*s.Shoulder
	if s.Median > 0 && s.Lanes >= 2 {
		w += s.Median
	}
	if s.BikeLeft {
		w += s.BikeWidth
	}
	if s.BikeRight {
		w += s.BikeWidth
	}
	if s.WalkLeft {
		w += s.WalkWidth
	}
	if s.WalkRight {
		w += s.WalkWidth
	}
	if s.ParkLeft {
		w += s.ParkWidth
	}
	if s.ParkRight {
		w += s.ParkWidth
	}
	return math.Round(w*100) / 100
}

func clampStep(v, lo, hi, step float64) float64 {
	if math.IsNaN(v) {
		return lo
	}
	return math.Round(math.Max(lo, math.Min(hi, v))/step) * step
}

// normalizeSection begrenzt alle Masse; nil, wenn der Querschnitt breiter als MaxWidth wäre.
func normalizeSection(s *Section) *Section {
	if s == nil {
		return nil
	}
	n := *s
	n.Lanes = int(clampStep(float64(n.Lanes), 1, 8, 1))
	n.LaneWidth = clampStep(n.LaneWidth, 2, 5, 0.25)
	n.Median = clampStep(n.Median, 0, 10, 0.25)
	n.Shoulder = clampStep(n.Shoulder, 0, 4, 0.25)
	n.BikeWidth = clampStep(n.BikeWidth, 1, 3, 0.25)
	n.WalkWidth = clampStep(n.WalkWidth, 1, 5, 0.25)
	n.ParkWidth = clampStep(n.ParkWidth, 1.5, 3, 0.25)
	if n.Width() > MaxWidth {
		return nil
	}
	return &n
}

// Turns sind die Abbiegeregeln einer Kreuzung; fehlende Felder gelten als Standard
// (links, rechts, geradeaus erlaubt; Wenden nicht).
type Turns struct {
	Left     *bool `json:"left"`
	Right    *bool `json:"right"`
	Straight *bool `json:"straight"`
	Uturn    *bool `json:"uturn"`
}

func normalizeTurns(t *Turns) *Turns {
	if t == nil {
		return nil
	}
	def := func(p *bool, d bool) *bool {
		if p == nil {
			return boolPtr(d)
		}
		return p
	}
	return &Turns{Left: def(t.Left, true), Right: def(t.Right, true), Straight: def(t.Straight, true), Uturn: def(t.Uturn, false)}
}

type Feature struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	LayerID string `json:"layerId"`
	Name    string `json:"name"`
	Note    string `json:"note"`
	// Strasse
	Kind     string    `json:"kind,omitempty"`
	Status   string    `json:"status,omitempty"`
	Oneway   *bool     `json:"oneway,omitempty"`
	Maxspeed *float64  `json:"maxspeed,omitempty"` // km/h; nil = Standard je Strassentyp
	Width    *float64  `json:"width,omitempty"`    // Meter; nil = Standard je Strassentyp
	Section  *Section  `json:"section,omitempty"`  // Querschnitt; nil = nur Breite/Standard
	Access   string    `json:"access,omitempty"`   // "all" (Standard) oder "bus": nur Busse
	OsmID    int64     `json:"osmId,omitempty"`    // OSM-Way, aus dem die Strasse übernommen wurde
	Nodes    []LatLng  `json:"nodes,omitempty"`
	Segments []Segment `json:"segments,omitempty"`
	// Höhenprofil einer Strasse (vom Profil-Dienst), mit Kennung der Punktfolge
	Profile *Profile `json:"profile,omitempty"`
	// Berührte Parzellen einer Strasse, mit Kennung der Punktfolge
	Parcels *ParcelInfo `json:"parcels,omitempty"`
	// Kreuzung / Punkt-Massnahme
	At    *LatLng  `json:"at,omitempty"`
	Turns *Turns   `json:"turns,omitempty"` // Abbiegeregeln; nil = Standard
	Lines []string `json:"lines,omitempty"` // Liniennummern einer Bushaltestelle
	// Fläche
	BusAllowed *bool `json:"busAllowed,omitempty"` // Busse dürfen gesperrte Flächen durchfahren
	// Kreisel
	Center *LatLng `json:"center,omitempty"`
	Radius float64 `json:"radius,omitempty"`
}

// ParcelInfo sind die ermittelten Parzellen einer Strasse (amtliche Vermessung) mit Kennung der Geometrie.
type ParcelInfo struct {
	Key   string       `json:"key"`
	Items []ParcelItem `json:"items"`
}

// ParcelItem ist eine berührte Parzelle mit der Länge der Strasse darauf (m).
type ParcelItem struct {
	Egrid  string  `json:"egrid"`
	Number string  `json:"number"`
	Label  string  `json:"label"`
	Canton string  `json:"canton"`
	Length float64 `json:"length"`
}

const MaxParcels = 500

func normalizeParcels(p *ParcelInfo) *ParcelInfo {
	if p == nil || len(p.Key) > 64 || len(p.Items) > MaxParcels {
		return nil
	}
	items := make([]ParcelItem, 0, len(p.Items))
	for _, it := range p.Items {
		if math.IsNaN(it.Length) || math.IsInf(it.Length, 0) || it.Length < 0 {
			it.Length = 0
		}
		it.Length = math.Round(it.Length*10) / 10
		it.Egrid, it.Number, it.Label, it.Canton = truncate(it.Egrid, 64), truncate(it.Number, 64), truncate(it.Label, 120), truncate(it.Canton, 16)
		items = append(items, it)
	}
	return &ParcelInfo{Key: p.Key, Items: items}
}

// Profile ist ein Höhenprofil: Punkte [Distanz m, Höhe m ü. M.] und Kennung der Geometrie.
type Profile struct {
	Points [][2]float64 `json:"points"`
	Key    string       `json:"key"`
}

// Route ist die gespeicherte Routenanfrage (Start/Ziel) des Routen-Rechners.
type Route struct {
	From LatLng `json:"from"`
	To   LatLng `json:"to"`
}

// RoutePair ist ein weiteres benanntes Start-Ziel-Paar (Start oder Ziel können noch fehlen).
type RoutePair struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	From *LatLng `json:"from"`
	To   *LatLng `json:"to"`
}

// Isochrone ist die Erreichbarkeitsanfrage: Ursprung, Zeitschwellen in Minuten, Modus.
type Isochrone struct {
	From    LatLng    `json:"from"`
	Minutes []float64 `json:"minutes"`
	Mode    string    `json:"mode"`
}

const (
	MaxRoutePairs    = 20
	MaxIsochroneBand = 5
)

var isochroneModes = []string{"proposed", "current", "diff"}

type Document struct {
	Version   int       `json:"version"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
	View      View      `json:"view"`
	Layers    []Layer   `json:"layers"`
	Features  []Feature `json:"features"`
	Route     *Route    `json:"route,omitempty"`
	// Weitere Routenpaare und Erreichbarkeitsanfrage des Routen-Rechners
	RoutePairs []RoutePair `json:"routePairs,omitempty"`
	Isochrone  *Isochrone  `json:"isochrone,omitempty"`
	BusLines   []BusLine   `json:"busLines,omitempty"`
	// Überschriebene Einheitskosten der Kostenschätzung (Schlüssel wie web/js/costs.js)
	Costs map[string]float64 `json:"costs,omitempty"`
}

// Stats fasst einen Entwurf für Listen und Versionen zusammen.
type Stats struct {
	Roads        int     `json:"roads"`
	Junctions    int     `json:"junctions"`
	Roundabouts  int     `json:"roundabouts"`
	Zones        int     `json:"zones"`
	Bridges      int     `json:"bridges"`
	Tunnels      int     `json:"tunnels"`
	LengthMeters float64 `json:"lengthMeters"`
}

var ErrInvalid = errors.New("ungültiger Entwurf")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

func validLatLng(p LatLng) bool {
	return !math.IsNaN(p[0]) && !math.IsNaN(p[1]) && math.Abs(p[0]) <= 90 && math.Abs(p[1]) <= 180
}

func round6(p LatLng) LatLng {
	return LatLng{math.Round(p[0]*1e6) / 1e6, math.Round(p[1]*1e6) / 1e6}
}

func oneOf(list []string, v, fallback string) string {
	for _, x := range list {
		if x == v {
			return v
		}
	}
	return fallback
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

func boolPtr(b bool) *bool { return &b }

// Normalize prüft den Entwurf und ergänzt fehlende Felder in place.
func Normalize(d *Document) error {
	if d == nil {
		return invalid("leer")
	}
	if d.Version > Version {
		return invalid("Version %d wird nicht unterstützt", d.Version)
	}
	d.Version = Version
	d.Name = truncate(d.Name, MaxNameLen)
	if d.Name == "" {
		d.Name = "Unbenannter Entwurf"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if d.CreatedAt == "" {
		d.CreatedAt = now
	}
	if d.UpdatedAt == "" {
		d.UpdatedAt = now
	}
	unsetView := d.View.Center == (LatLng{}) && d.View.Zoom == 0
	if unsetView || !validLatLng(d.View.Center) || math.IsNaN(d.View.Zoom) || d.View.Zoom < 0 || d.View.Zoom > 22 {
		d.View = View{Center: LatLng{46.8, 8.23}, Zoom: 8}
	}
	if len(d.Layers) == 0 {
		d.Layers = []Layer{{ID: "l_default", Name: "Ebene 1", Color: LayerColors[0], Visible: boolPtr(true)}}
	}
	if len(d.Layers) > MaxLayers {
		return invalid("zu viele Ebenen (%d)", len(d.Layers))
	}
	layerIDs := make(map[string]bool, len(d.Layers))
	for i := range d.Layers {
		l := &d.Layers[i]
		if !idPattern.MatchString(l.ID) {
			return invalid("Ebene %d hat eine ungültige ID", i)
		}
		if layerIDs[l.ID] {
			return invalid("Ebenen-ID %q doppelt", l.ID)
		}
		layerIDs[l.ID] = true
		l.Name = truncate(l.Name, MaxNameLen)
		if l.Name == "" {
			l.Name = fmt.Sprintf("Ebene %d", i+1)
		}
		if !colorPattern.MatchString(l.Color) {
			l.Color = LayerColors[i%len(LayerColors)]
		}
		if l.Visible == nil {
			l.Visible = boolPtr(true)
		}
	}
	if len(d.Features) > MaxFeatures {
		return invalid("zu viele Elemente (%d)", len(d.Features))
	}
	if d.Features == nil {
		d.Features = []Feature{}
	}
	featureIDs := make(map[string]bool, len(d.Features))
	for i := range d.Features {
		f := &d.Features[i]
		if !idPattern.MatchString(f.ID) {
			return invalid("Element %d hat eine ungültige ID", i)
		}
		if featureIDs[f.ID] {
			return invalid("Element-ID %q doppelt", f.ID)
		}
		featureIDs[f.ID] = true
		if !layerIDs[f.LayerID] {
			f.LayerID = d.Layers[0].ID
		}
		f.Name = truncate(f.Name, MaxNameLen)
		f.Note = truncate(f.Note, MaxNoteLen)
		switch f.Type {
		case "road":
			if len(f.Nodes) < 2 {
				return invalid("Strasse %s braucht mindestens zwei Punkte", f.ID)
			}
			if len(f.Nodes) > MaxRoadNodes {
				return invalid("Strasse %s hat zu viele Punkte", f.ID)
			}
			for j, n := range f.Nodes {
				if !validLatLng(n) {
					return invalid("Strasse %s: Punkt %d ungültig", f.ID, j)
				}
				f.Nodes[j] = round6(n)
			}
			segs := make([]Segment, len(f.Nodes)-1)
			for j := range segs {
				level := "ground"
				var ms *float64
				if j < len(f.Segments) {
					level = f.Segments[j].Level
					ms = f.Segments[j].Maxspeed
				}
				segs[j].Level = oneOf(Levels, level, "ground")
				if ms != nil && !math.IsNaN(*ms) && *ms > 0 && *ms <= MaxSpeed {
					v := math.Round(*ms)
					segs[j].Maxspeed = &v
				}
				if j < len(f.Segments) {
					segs[j].Access = oneOf(accessValues, f.Segments[j].Access, "")
				}
			}
			f.Segments = segs
			f.Access = oneOf(accessValues, f.Access, "all")
			f.Kind = oneOf(RoadKinds, f.Kind, "other")
			f.Status = oneOf(Statuses, f.Status, "new")
			if f.Oneway == nil {
				f.Oneway = boolPtr(false)
			}
			if f.Maxspeed != nil && (math.IsNaN(*f.Maxspeed) || *f.Maxspeed <= 0 || *f.Maxspeed > MaxSpeed) {
				f.Maxspeed = nil
			}
			if f.Maxspeed != nil {
				v := math.Round(*f.Maxspeed)
				f.Maxspeed = &v
			}
			if f.OsmID < 0 {
				f.OsmID = 0
			}
			if f.Width != nil && (math.IsNaN(*f.Width) || *f.Width <= 0 || *f.Width > MaxWidth) {
				f.Width = nil
			}
			if f.Width != nil {
				v := math.Round(*f.Width*10) / 10
				f.Width = &v
			}
			f.Section = normalizeSection(f.Section)
			f.Parcels = normalizeParcels(f.Parcels)
			if f.Profile != nil {
				if len(f.Profile.Points) < 2 || len(f.Profile.Points) > 1000 || len(f.Profile.Key) > 64 {
					f.Profile = nil
				} else {
					for _, pt := range f.Profile.Points {
						if math.IsNaN(pt[0]) || math.IsNaN(pt[1]) || math.IsInf(pt[0], 0) || math.IsInf(pt[1], 0) {
							f.Profile = nil
							break
						}
					}
				}
			}
			f.At, f.Turns, f.Lines, f.BusAllowed, f.Center, f.Radius = nil, nil, nil, nil, nil, 0
		case "junction":
			if f.At == nil || !validLatLng(*f.At) {
				return invalid("Kreuzung %s hat keine gültige Position", f.ID)
			}
			p := round6(*f.At)
			f.At = &p
			f.Kind = oneOf(JunctionKinds, f.Kind, "plain")
			f.Turns = normalizeTurns(f.Turns)
			lines := make([]string, 0, len(f.Lines))
			for _, l := range f.Lines {
				l = truncate(l, 12)
				if l == "" || len(lines) >= 10 {
					continue
				}
				dup := false
				for _, x := range lines {
					if x == l {
						dup = true
					}
				}
				if !dup {
					lines = append(lines, l)
				}
			}
			if len(lines) > 0 {
				f.Lines = lines
			} else {
				f.Lines = nil
			}
			f.Status, f.Oneway, f.Nodes, f.Segments, f.Center, f.Radius, f.Access, f.BusAllowed = "", nil, nil, nil, nil, 0, "", nil
			f.Maxspeed, f.OsmID, f.Width, f.Section, f.Profile, f.Parcels = nil, 0, nil, nil, nil, nil
		case "roundabout":
			if f.Center == nil || !validLatLng(*f.Center) {
				return invalid("Kreisel %s hat kein gültiges Zentrum", f.ID)
			}
			p := round6(*f.Center)
			f.Center = &p
			if math.IsNaN(f.Radius) || f.Radius <= 0 {
				f.Radius = 15
			}
			if f.Radius > MaxRadius {
				f.Radius = MaxRadius
			}
			f.Radius = math.Round(f.Radius*10) / 10
			f.Kind, f.Status, f.Oneway, f.Nodes, f.Segments, f.At, f.Turns, f.Lines, f.Access, f.BusAllowed = "", "", nil, nil, nil, nil, nil, nil, "", nil
			f.Maxspeed, f.OsmID, f.Width, f.Section, f.Profile, f.Parcels = nil, 0, nil, nil, nil, nil
		case "zone":
			if len(f.Nodes) < 3 {
				return invalid("Zone %s braucht mindestens drei Punkte", f.ID)
			}
			if len(f.Nodes) > MaxZoneNodes {
				return invalid("Zone %s hat zu viele Punkte", f.ID)
			}
			for j, n := range f.Nodes {
				if !validLatLng(n) {
					return invalid("Zone %s: Punkt %d ungültig", f.ID, j)
				}
				f.Nodes[j] = round6(n)
			}
			f.Kind = oneOf(ZoneKinds, f.Kind, "other")
			if f.BusAllowed != nil && !*f.BusAllowed {
				f.BusAllowed = nil
			}
			f.Status, f.Oneway, f.Segments, f.At, f.Turns, f.Lines, f.Access, f.Center, f.Radius = "", nil, nil, nil, nil, nil, "", nil, 0
			f.Maxspeed, f.OsmID, f.Width, f.Section, f.Profile, f.Parcels = nil, 0, nil, nil, nil, nil
		default:
			return invalid("unbekannter Elementtyp %q", f.Type)
		}
	}
	if d.Route != nil && (!validLatLng(d.Route.From) || !validLatLng(d.Route.To)) {
		d.Route = nil
	}
	if d.Route != nil {
		d.Route.From = round6(d.Route.From)
		d.Route.To = round6(d.Route.To)
	}
	if len(d.RoutePairs) > MaxRoutePairs {
		d.RoutePairs = d.RoutePairs[:MaxRoutePairs]
	}
	for i := range d.RoutePairs {
		p := &d.RoutePairs[i]
		if !idPattern.MatchString(p.ID) {
			p.ID = fmt.Sprintf("p_%d", i+1)
		}
		p.Name = truncate(p.Name, 60)
		if p.From != nil && !validLatLng(*p.From) {
			p.From = nil
		}
		if p.To != nil && !validLatLng(*p.To) {
			p.To = nil
		}
		if p.From != nil {
			v := round6(*p.From)
			p.From = &v
		}
		if p.To != nil {
			v := round6(*p.To)
			p.To = &v
		}
	}
	if d.Isochrone != nil {
		if !validLatLng(d.Isochrone.From) {
			d.Isochrone = nil
		} else {
			d.Isochrone.From = round6(d.Isochrone.From)
			mins := make([]float64, 0, len(d.Isochrone.Minutes))
			for _, m := range d.Isochrone.Minutes {
				if math.IsNaN(m) || m < 1 || m > 60 {
					continue
				}
				mins = append(mins, math.Round(m))
				if len(mins) >= MaxIsochroneBand {
					break
				}
			}
			if len(mins) == 0 {
				mins = []float64{5, 10, 15}
			}
			d.Isochrone.Minutes = mins
			d.Isochrone.Mode = oneOf(isochroneModes, d.Isochrone.Mode, "proposed")
		}
	}
	if len(d.BusLines) > MaxBusLines {
		d.BusLines = d.BusLines[:MaxBusLines]
	}
	for i := range d.BusLines {
		b := &d.BusLines[i]
		if !idPattern.MatchString(b.ID) {
			b.ID = fmt.Sprintf("b_%d", i+1)
		}
		b.Name = truncate(b.Name, 12)
		if !colorPattern.MatchString(b.Color) {
			b.Color = LayerColors[i%len(LayerColors)]
		}
		stops := make([]string, 0, len(b.Stops))
		for _, st := range b.Stops {
			if featureIDs[st] && len(stops) < MaxBusStops {
				stops = append(stops, st)
			}
		}
		b.Stops = stops
		if math.IsNaN(b.Dwell) || b.Dwell < 0 || b.Dwell > 300 {
			b.Dwell = 20
		}
		b.Dwell = math.Round(b.Dwell)
	}
	if len(d.Costs) > 0 {
		clean := make(map[string]float64, len(d.Costs))
		for k, v := range d.Costs {
			if !costKey.MatchString(k) || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > MaxCost {
				continue
			}
			clean[k] = math.Round(v)
			if len(clean) >= MaxCostKeys {
				break
			}
		}
		d.Costs = clean
		if len(d.Costs) == 0 {
			d.Costs = nil
		}
	}
	return nil
}

// Haversine liefert die Distanz zweier Punkte in Metern.
func Haversine(a, b LatLng) float64 {
	const r = 6378137.0
	d2r := math.Pi / 180
	dLat := (b[0] - a[0]) * d2r
	dLng := (b[1] - a[1]) * d2r
	s := math.Pow(math.Sin(dLat/2), 2) + math.Cos(a[0]*d2r)*math.Cos(b[0]*d2r)*math.Pow(math.Sin(dLng/2), 2)
	return 2 * r * math.Asin(math.Min(1, math.Sqrt(s)))
}

// Compute berechnet die Kennzahlen eines Entwurfs.
func Compute(d *Document) Stats {
	var s Stats
	for _, f := range d.Features {
		switch f.Type {
		case "road":
			s.Roads++
			for i := 1; i < len(f.Nodes); i++ {
				s.LengthMeters += Haversine(f.Nodes[i-1], f.Nodes[i])
			}
			for _, seg := range f.Segments {
				switch seg.Level {
				case "bridge":
					s.Bridges++
				case "tunnel":
					s.Tunnels++
				}
			}
		case "junction":
			s.Junctions++
		case "roundabout":
			s.Roundabouts++
		case "zone":
			s.Zones++
		}
	}
	s.LengthMeters = math.Round(s.LengthMeters)
	return s
}
