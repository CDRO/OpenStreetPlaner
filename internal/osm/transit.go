package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var hexColour = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const (
	MaxTransitRoutes = 80 // Relationen je Abfrage
	MaxTransitStops  = 60 // Haltestellen je Linie (wie model.MaxBusStops)
)

// BusStop ist eine Bushaltestelle aus OSM (highway=bus_stop, public_transport=platform/stop_position).
type BusStop struct {
	ID    int64      `json:"id"`
	Name  string     `json:"name"`
	At    [2]float64 `json:"at"`
	Lines []string   `json:"lines,omitempty"` // Liniennummern (route_ref und Relationen)
}

// BusRoute ist eine Buslinie aus OSM (Relation route=bus) mit ihrer Haltestellenfolge.
type BusRoute struct {
	ID       int64     `json:"id"`
	Ref      string    `json:"ref"`
	Name     string    `json:"name"`
	From     string    `json:"from,omitempty"`
	To       string    `json:"to,omitempty"`
	Operator string    `json:"operator,omitempty"`
	Colour   string    `json:"colour,omitempty"`
	Source   string    `json:"source"` // stop (Haltepositionen), platform (Plattformen) oder plain (ohne Rollen)
	Stops    []BusStop `json:"stops"`
}

// Transit fasst Haltestellen im Bereich und die Linien, die ihn berühren, zusammen.
type Transit struct {
	Stops  []BusStop  `json:"stops"`
	Routes []BusRoute `json:"routes"`
}

type overpassNode struct {
	ID   int64
	Lat  float64
	Lon  float64
	Tags map[string]string
}

func isBusStopNode(tags map[string]string) bool {
	if tags["highway"] == "bus_stop" {
		return true
	}
	pt := tags["public_transport"]
	return (pt == "platform" || pt == "stop_position") && (tags["bus"] == "yes" || tags["highway"] == "bus_stop")
}

// Transit lädt Haltestellen und Buslinien (Relationen) eines Bereichs (max. 0.06°) über Overpass.
func (c *Client) Transit(ctx context.Context, b BBox) (*Transit, error) {
	if c.transitCache == nil {
		c.transitCache = newMemCache(roadsCacheTTL)
	}
	key := fmt.Sprintf("t:%.4f,%.4f,%.4f,%.4f", b.South, b.West, b.North, b.East)
	if data, ok := c.transitCache.get(key); ok {
		var out Transit
		if json.Unmarshal(data, &out) == nil {
			return &out, nil
		}
	}
	bbox := fmt.Sprintf("%.6f,%.6f,%.6f,%.6f", b.South, b.West, b.North, b.East)
	query := fmt.Sprintf(`[out:json][timeout:25];(node["highway"="bus_stop"](%[1]s);node["public_transport"~"^(platform|stop_position)$"]["bus"="yes"](%[1]s);)->.s;.s out body;relation["route"="bus"](%[1]s)->.r;.r out body;node(r.r)->.m;.m out body;`, bbox)
	form := url.Values{"data": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OverpassURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	body, _, err := c.do(req)
	if err != nil {
		return nil, fmt.Errorf("ÖV laden: %w", err)
	}
	out, err := parseTransit(body, b)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(out)
	c.transitCache.set(key, data)
	return out, nil
}

// parseTransit baut aus einer Overpass-Antwort (Knoten und Relationen) Haltestellen und Linien.
func parseTransit(body []byte, b BBox) (*Transit, error) {
	var raw struct {
		Elements []struct {
			Type    string            `json:"type"`
			ID      int64             `json:"id"`
			Lat     float64           `json:"lat"`
			Lon     float64           `json:"lon"`
			Tags    map[string]string `json:"tags"`
			Members []struct {
				Type string `json:"type"`
				Ref  int64  `json:"ref"`
				Role string `json:"role"`
			} `json:"members"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("ÖV laden: unlesbare Antwort")
	}
	nodes := map[int64]overpassNode{}
	for _, el := range raw.Elements {
		if el.Type != "node" {
			continue
		}
		tags := el.Tags
		if tags == nil {
			tags = map[string]string{}
		}
		nodes[el.ID] = overpassNode{ID: el.ID, Lat: el.Lat, Lon: el.Lon, Tags: tags}
	}
	r6 := func(v float64) float64 { return math.Round(v*1e6) / 1e6 }
	stopOf := func(n overpassNode) BusStop {
		return BusStop{ID: n.ID, Name: truncate(n.Tags["name"], 60), At: [2]float64{r6(n.Lat), r6(n.Lon)}}
	}
	linesAt := map[int64][]string{}
	addLine := func(id int64, ref string) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			return
		}
		for _, x := range linesAt[id] {
			if x == ref {
				return
			}
		}
		linesAt[id] = append(linesAt[id], ref)
	}
	out := &Transit{Stops: []BusStop{}, Routes: []BusRoute{}}
	for _, el := range raw.Elements {
		if el.Type != "relation" || el.Tags["route"] != "bus" {
			continue
		}
		var stops, platforms, plain []BusStop
		for _, m := range el.Members {
			if m.Type != "node" {
				continue
			}
			n, ok := nodes[m.Ref]
			if !ok {
				continue
			}
			s := stopOf(n)
			switch {
			case strings.HasPrefix(m.Role, "stop"):
				stops = append(stops, s)
			case strings.HasPrefix(m.Role, "platform"):
				platforms = append(platforms, s)
			case m.Role == "" && isBusStopNode(n.Tags):
				plain = append(plain, s)
			}
		}
		seq, source := stops, "stop"
		if len(seq) < 2 {
			seq, source = platforms, "platform"
		}
		if len(seq) < 2 {
			seq, source = plain, "plain"
		}
		// Doppelte direkt nacheinander (Hin- und Rückweg in einer Relation, PTv1-Paare) zusammenfassen
		clean := make([]BusStop, 0, len(seq))
		for _, s := range seq {
			if len(clean) > 0 && clean[len(clean)-1].ID == s.ID {
				continue
			}
			if len(clean) >= MaxTransitStops {
				break
			}
			clean = append(clean, s)
		}
		if len(clean) < 2 {
			continue
		}
		r := BusRoute{ID: el.ID, Ref: truncate(el.Tags["ref"], 12), Name: truncate(el.Tags["name"], 80), From: truncate(el.Tags["from"], 60), To: truncate(el.Tags["to"], 60), Operator: truncate(el.Tags["operator"], 60), Source: source, Stops: clean}
		if hexColour.MatchString(el.Tags["colour"]) {
			r.Colour = strings.ToLower(el.Tags["colour"])
		}
		for _, s := range clean {
			addLine(s.ID, r.Ref)
		}
		out.Routes = append(out.Routes, r)
	}
	sort.SliceStable(out.Routes, func(i, j int) bool { return refLess(out.Routes[i].Ref, out.Routes[j].Ref) })
	if len(out.Routes) > MaxTransitRoutes {
		out.Routes = out.Routes[:MaxTransitRoutes]
	}
	for _, n := range nodes {
		if !isBusStopNode(n.Tags) || n.Lat < b.South || n.Lat > b.North || n.Lon < b.West || n.Lon > b.East {
			continue
		}
		s := stopOf(n)
		for _, ref := range strings.Split(n.Tags["route_ref"], ";") {
			addLine(n.ID, ref)
		}
		s.Lines = linesAt[n.ID]
		out.Stops = append(out.Stops, s)
	}
	sort.Slice(out.Stops, func(i, j int) bool { return out.Stops[i].ID < out.Stops[j].ID })
	for i := range out.Routes {
		for j := range out.Routes[i].Stops {
			out.Routes[i].Stops[j].Lines = nil
		}
	}
	return out, nil
}

// refLess sortiert Liniennummern natürlich: 2 vor 10, Zahlen vor Buchstaben.
func refLess(a, b string) bool {
	na, oka := leadingNumber(a)
	nb, okb := leadingNumber(b)
	if oka && okb && na != nb {
		return na < nb
	}
	if oka != okb {
		return oka
	}
	return a < b
}

func leadingNumber(s string) (int, bool) {
	n, ok := 0, false
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
		ok = true
	}
	return n, ok
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}
