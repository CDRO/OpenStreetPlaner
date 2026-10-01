package model

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
)

func sample() *Document {
	return &Document{
		Name:   "Test",
		Layers: []Layer{{ID: "l1", Name: "A", Color: "#123456", Visible: boolPtr(true)}},
		Features: []Feature{
			{ID: "r1", Type: "road", LayerID: "l1", Kind: "main", Nodes: []LatLng{{47, 8}, {47, 8.001}, {47, 8.002}}, Segments: []Segment{{Level: "bridge"}}},
			{ID: "j1", Type: "junction", LayerID: "zzz", Kind: "weird", At: &LatLng{47, 8}},
			{ID: "k1", Type: "roundabout", LayerID: "l1", Center: &LatLng{47.0000004, 8}, Radius: 9999},
		},
	}
}

func TestNormalizeFillsDefaults(t *testing.T) {
	d := sample()
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	road := d.Features[0]
	if len(road.Segments) != 2 || road.Segments[0].Level != "bridge" || road.Segments[1].Level != "ground" {
		t.Fatalf("Abschnitte falsch ergänzt: %+v", road.Segments)
	}
	if road.Status != "new" || road.Oneway == nil || *road.Oneway {
		t.Fatalf("Strassen-Defaults falsch: %+v", road)
	}
	j := d.Features[1]
	if j.LayerID != "l1" || j.Kind != "plain" {
		t.Fatalf("Kreuzungs-Defaults falsch: %+v", j)
	}
	k := d.Features[2]
	if k.Radius != MaxRadius || (*k.Center)[0] != 47 {
		t.Fatalf("Kreisel nicht begrenzt/gerundet: %+v", k)
	}
	if d.Version != Version || d.CreatedAt == "" || d.View.Zoom != 8 {
		t.Fatalf("Metadaten nicht ergänzt: %+v", d)
	}
}

func TestNormalizeRejectsStructuralErrors(t *testing.T) {
	cases := map[string]func(*Document){
		"zu wenig Punkte":   func(d *Document) { d.Features[0].Nodes = d.Features[0].Nodes[:1] },
		"ungültige Koord.":  func(d *Document) { d.Features[0].Nodes[0] = LatLng{91, 0} },
		"doppelte ID":       func(d *Document) { d.Features[1].ID = "r1" },
		"unbekannter Typ":   func(d *Document) { d.Features[1].Type = "ufo" },
		"kaputte ID":        func(d *Document) { d.Features[1].ID = "a b/c" },
		"neuere Version":    func(d *Document) { d.Version = 99 },
		"Kreuzung ohne Ort": func(d *Document) { d.Features[1].At = nil },
	}
	for name, mutate := range cases {
		d := sample()
		mutate(d)
		if err := Normalize(d); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: erwartet ErrInvalid, bekam %v", name, err)
		}
	}
}

func TestNormalizeEmptyLayers(t *testing.T) {
	d := &Document{}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	if len(d.Layers) != 1 || d.Name == "" || d.Features == nil {
		t.Fatalf("leerer Entwurf nicht ergänzt: %+v", d)
	}
}

func TestJSONRoundTripKeepsShape(t *testing.T) {
	d := sample()
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(d)
	s := string(raw)
	for _, want := range []string{`"segments":[{"level":"bridge","maxspeed":null},{"level":"ground","maxspeed":null}]`, `"oneway":false`, `"visible":true`, `"at":[47,8]`} {
		if !strings.Contains(s, want) {
			t.Errorf("JSON enthält %s nicht: %s", want, s)
		}
	}
	var back Document
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if err := Normalize(&back); err != nil {
		t.Fatal(err)
	}
}

func TestCompute(t *testing.T) {
	d := sample()
	_ = Normalize(d)
	s := Compute(d)
	if s.Roads != 1 || s.Junctions != 1 || s.Roundabouts != 1 || s.Bridges != 1 {
		t.Fatalf("Stats falsch: %+v", s)
	}
	if s.LengthMeters < 150 || s.LengthMeters > 153 {
		t.Fatalf("Länge falsch: %v", s.LengthMeters)
	}
}

func TestMaxspeedOsmIDAndRoute(t *testing.T) {
	bad := -5.0
	ok := 49.6
	d := sample()
	d.Features[0].Maxspeed = &bad
	d.Features[0].OsmID = -1
	d.Route = &Route{From: LatLng{47.0000004, 8}, To: LatLng{47.1, 8.1}}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	if d.Features[0].Maxspeed != nil || d.Features[0].OsmID != 0 {
		t.Fatalf("ungültiges Tempolimit/OsmID nicht bereinigt: %+v", d.Features[0])
	}
	if d.Route == nil || d.Route.From[0] != 47 {
		t.Fatalf("Route nicht gerundet: %+v", d.Route)
	}
	d = sample()
	d.Features[0].Maxspeed = &ok
	d.Features[0].OsmID = 4242
	d.Route = &Route{From: LatLng{99, 0}, To: LatLng{0, 0}}
	_ = Normalize(d)
	if d.Features[0].Maxspeed == nil || *d.Features[0].Maxspeed != 50 || d.Features[0].OsmID != 4242 {
		t.Fatalf("Tempolimit nicht gerundet/übernommen: %+v", d.Features[0])
	}
	if d.Route != nil {
		t.Fatalf("ungültige Route nicht verworfen")
	}
}

func TestZones(t *testing.T) {
	d := sample()
	d.Features = append(d.Features, Feature{ID: "z1", Type: "zone", LayerID: "l1", Kind: "tempo30", Nodes: []LatLng{{47, 8}, {47, 8.001}, {47.001, 8.001}}, Status: "new", Radius: 5})
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	z := d.Features[3]
	if z.Kind != "tempo30" || z.Status != "" || z.Radius != 0 || len(z.Nodes) != 3 {
		t.Fatalf("Zone nicht bereinigt: %+v", z)
	}
	if Compute(d).Zones != 1 {
		t.Fatalf("Zone nicht gezählt")
	}
	d.Features[3].Nodes = d.Features[3].Nodes[:2]
	if err := Normalize(d); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Zone mit zwei Punkten akzeptiert: %v", err)
	}
	d = sample()
	d.Features[1].Kind = "crossing"
	_ = Normalize(d)
	if d.Features[1].Kind != "crossing" {
		t.Fatalf("Fussgängerstreifen nicht akzeptiert")
	}
}

func TestSegmentSpeedAndWidth(t *testing.T) {
	d := sample()
	bad := 999.0
	ok := 29.6
	w := 6.55
	d.Features[0].Segments = []Segment{{Level: "ground", Maxspeed: &bad}, {Level: "ground", Maxspeed: &ok}}
	d.Features[0].Width = &w
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	segs := d.Features[0].Segments
	if segs[0].Maxspeed != nil || segs[1].Maxspeed == nil || *segs[1].Maxspeed != 30 {
		t.Fatalf("Abschnitts-Tempolimit: %+v", segs)
	}
	if d.Features[0].Width == nil || *d.Features[0].Width != 6.6 {
		t.Fatalf("Breite: %+v", d.Features[0].Width)
	}
	huge := 100.0
	d.Features[0].Width = &huge
	_ = Normalize(d)
	if d.Features[0].Width != nil {
		t.Fatalf("zu grosse Breite nicht verworfen")
	}
}

func TestProfileField(t *testing.T) {
	d := sample()
	d.Features[0].Profile = &Profile{Points: [][2]float64{{0, 500}, {100, 510}}, Key: "2:abc"}
	d.Features[1].Profile = &Profile{Points: [][2]float64{{0, 500}, {100, 510}}, Key: "x"}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	if d.Features[0].Profile == nil || d.Features[1].Profile != nil {
		t.Fatalf("Profil nur an Strassen: %+v %+v", d.Features[0].Profile, d.Features[1].Profile)
	}
	d.Features[0].Profile = &Profile{Points: [][2]float64{{0, math.NaN()}, {1, 1}}, Key: "k"}
	_ = Normalize(d)
	if d.Features[0].Profile != nil {
		t.Fatalf("NaN-Profil nicht verworfen")
	}
}

func TestSectionAndTurns(t *testing.T) {
	d := sample()
	d.Features[0].Kind = "motorway"
	d.Features[0].Section = &Section{Lanes: 4, LaneWidth: 3.8, Median: 3, Shoulder: 2.5, WalkLeft: true, WalkWidth: 0.2}
	tr := false
	d.Features = append(d.Features, Feature{ID: "jx_turns", Type: "junction", LayerID: d.Layers[0].ID, Kind: "interchange", At: &LatLng{47, 8}, Turns: &Turns{Left: &tr}})
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	r := d.Features[0]
	if r.Kind != "motorway" {
		t.Fatalf("Autobahn nicht erlaubt: %s", r.Kind)
	}
	if r.Section == nil || r.Section.LaneWidth != 3.75 || r.Section.WalkWidth != 1 || !r.Section.WalkLeft {
		t.Fatalf("Querschnitt nicht begrenzt: %+v", r.Section)
	}
	if got := r.Section.Width(); got != 4*3.75+3+5+1 {
		t.Fatalf("Breite %v", got)
	}
	j := d.Features[len(d.Features)-1]
	if j.Kind != "interchange" || j.Turns == nil || *j.Turns.Left || !*j.Turns.Right || !*j.Turns.Straight || *j.Turns.Uturn {
		t.Fatalf("Abbiegeregeln: %+v %+v", j.Kind, j.Turns)
	}
	// zu breiter Querschnitt wird verworfen
	d.Features[0].Section = &Section{Lanes: 8, LaneWidth: 5, Median: 10, Shoulder: 4, WalkLeft: true, WalkRight: true, WalkWidth: 5}
	_ = Normalize(d)
	if d.Features[0].Section != nil {
		t.Fatalf("zu breiter Querschnitt nicht verworfen")
	}
	// Querschnitt und Abbiegeregeln gehören nur zu Strasse bzw. Kreuzung
	d.Features = append(d.Features, Feature{ID: "zx_fields", Type: "zone", LayerID: d.Layers[0].ID, Nodes: []LatLng{{47, 8}, {47, 8.01}, {47.01, 8}}, Section: &Section{Lanes: 2}, Turns: &Turns{}})
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	z := d.Features[len(d.Features)-1]
	if z.Section != nil || z.Turns != nil {
		t.Fatalf("Zone trägt Strassen-/Kreuzungsfelder: %+v", z)
	}
}

func TestCosts(t *testing.T) {
	d := sample()
	d.Costs = map[string]float64{"road.main": 2500000.4, "bridge": -1, "Kaputt Key": 5, "tunnel": 1e12}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	if len(d.Costs) != 1 || d.Costs["road.main"] != 2500000 {
		t.Fatalf("Kosten: %+v", d.Costs)
	}
	d.Costs = map[string]float64{"x": -3}
	_ = Normalize(d)
	if d.Costs != nil {
		t.Fatalf("leere Kosten sollten nil sein: %+v", d.Costs)
	}
}

func TestParcelsField(t *testing.T) {
	d := sample()
	d.Features[0].Parcels = &ParcelInfo{Key: "3:abc", Items: []ParcelItem{{Egrid: "CH1", Number: "12", Length: 12.345}, {Length: math.NaN()}}}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	p := d.Features[0].Parcels
	if p == nil || len(p.Items) != 2 || p.Items[0].Length != 12.3 || p.Items[1].Length != 0 {
		t.Fatalf("Parzellen: %+v", p)
	}
	d.Features[0].Parcels = &ParcelInfo{Key: strings.Repeat("k", 65)}
	_ = Normalize(d)
	if d.Features[0].Parcels != nil {
		t.Fatalf("zu langer Schlüssel nicht verworfen")
	}
}

func TestRoutePairsAndIsochrone(t *testing.T) {
	d := sample()
	bad := LatLng{99, 0}
	ok := LatLng{47.123456789, 8}
	d.RoutePairs = []RoutePair{{ID: "p1", Name: "Schule", From: &ok, To: &bad}, {ID: "kaputt id!", Name: strings.Repeat("x", 80)}}
	d.Isochrone = &Isochrone{From: ok, Minutes: []float64{15, 5, math.NaN(), 99}, Mode: "egal"}
	if err := Normalize(d); err != nil {
		t.Fatal(err)
	}
	if d.RoutePairs[0].To != nil || d.RoutePairs[0].From == nil || (*d.RoutePairs[0].From)[0] != 47.123457 {
		t.Fatalf("Paar 1: %+v", d.RoutePairs[0])
	}
	if d.RoutePairs[1].ID != "p_2" || len(d.RoutePairs[1].Name) != 60 {
		t.Fatalf("Paar 2: %+v", d.RoutePairs[1])
	}
	if d.Isochrone.Mode != "proposed" || len(d.Isochrone.Minutes) != 2 || d.Isochrone.Minutes[0] != 15 {
		t.Fatalf("Isochrone: %+v", d.Isochrone)
	}
	d.Isochrone = &Isochrone{From: bad}
	_ = Normalize(d)
	if d.Isochrone != nil {
		t.Fatalf("ungültiger Ursprung nicht verworfen")
	}
}
