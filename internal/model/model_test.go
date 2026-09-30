package model

import (
	"encoding/json"
	"errors"
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
	for _, want := range []string{`"segments":[{"level":"bridge"},{"level":"ground"}]`, `"oneway":false`, `"visible":true`, `"at":[47,8]`} {
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
