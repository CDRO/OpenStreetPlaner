package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// DefaultTimetableURL ist die offene Fahrplan-API (transport.opendata.ch, Daten der SBB/ÖV Schweiz).
const DefaultTimetableURL = "https://transport.opendata.ch/v1"

// Timetable ist das Ergebnis eines Fahrplan-Abgleichs zwischen zwei Haltestellen.
type Timetable struct {
	From     TimetableStop   `json:"from"`
	To       TimetableStop   `json:"to"`
	Line     string          `json:"line,omitempty"`
	Trips    int             `json:"trips"`
	Median   float64         `json:"median"` // Sekunden
	Min      float64         `json:"min"`
	Max      float64         `json:"max"`
	Journeys []TimetableTrip `json:"journeys"`
}

type TimetableStop struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Distance float64 `json:"distance"` // Meter zur Anfrage-Koordinate
}

type TimetableTrip struct {
	Number    string  `json:"number"`
	Departure string  `json:"departure"`
	Arrival   string  `json:"arrival"`
	Seconds   float64 `json:"seconds"`
}

func (c *Client) timetableGet(ctx context.Context, path string, params url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.TimetableURL, "/")+path+"?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	body, _, err := c.do(req)
	if err != nil {
		return fmt.Errorf("Fahrplan: %w", err)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("Fahrplan: unlesbare Antwort")
	}
	return nil
}

// nearestStation sucht die nächste Haltestelle zu einer Koordinate.
func (c *Client) nearestStation(ctx context.Context, ll [2]float64) (TimetableStop, error) {
	var res struct {
		Stations []struct {
			ID       string  `json:"id"`
			Name     string  `json:"name"`
			Distance float64 `json:"distance"`
		} `json:"stations"`
	}
	params := url.Values{"x": {fmt.Sprintf("%.6f", ll[0])}, "y": {fmt.Sprintf("%.6f", ll[1])}, "type": {"station"}}
	if err := c.timetableGet(ctx, "/locations", params, &res); err != nil {
		return TimetableStop{}, err
	}
	for _, st := range res.Stations {
		if st.ID != "" && st.Name != "" {
			return TimetableStop{ID: st.ID, Name: st.Name, Distance: st.Distance}, nil
		}
	}
	return TimetableStop{}, fmt.Errorf("%w: keine Haltestelle in der Nähe", ErrBadRequest)
}

func parseDuration(s string) float64 {
	// Format "00d00:14:00"
	var d, h, m, sec int
	if _, err := fmt.Sscanf(s, "%dd%d:%d:%d", &d, &h, &m, &sec); err != nil {
		return 0
	}
	return float64(d*86400 + h*3600 + m*60 + sec)
}

// Timetable vergleicht Modell und Fahrplan: direkte Busfahrten zwischen den nächsten Haltestellen zu from und to.
// line (optional) filtert auf die Liniennummer. Leere TimetableURL = Dienst abgeschaltet.
func (c *Client) Timetable(ctx context.Context, from, to [2]float64, line string) (*Timetable, error) {
	if c.TimetableURL == "" {
		return nil, fmt.Errorf("%w: Fahrplan-Dienst nicht konfiguriert", ErrBadRequest)
	}
	line = strings.TrimSpace(line)
	if c.timetableCache == nil {
		c.timetableCache = newMemCache(10 * time.Minute)
	}
	key := fmt.Sprintf("%.5f,%.5f>%.5f,%.5f|%s", from[0], from[1], to[0], to[1], line)
	if data, ok := c.timetableCache.get(key); ok {
		var out Timetable
		if json.Unmarshal(data, &out) == nil {
			return &out, nil
		}
	}
	a, err := c.nearestStation(ctx, from)
	if err != nil {
		return nil, err
	}
	b, err := c.nearestStation(ctx, to)
	if err != nil {
		return nil, err
	}
	if a.ID == b.ID {
		return nil, fmt.Errorf("%w: Start und Ziel liegen bei derselben Haltestelle (%s)", ErrBadRequest, a.Name)
	}
	var res struct {
		Connections []struct {
			Duration  string `json:"duration"`
			Transfers int    `json:"transfers"`
			Sections  []struct {
				Journey *struct {
					Name     string `json:"name"`
					Category string `json:"category"`
					Number   string `json:"number"`
				} `json:"journey"`
				Walk      *json.RawMessage `json:"walk"`
				Departure struct {
					Departure string `json:"departure"`
				} `json:"departure"`
				Arrival struct {
					Arrival string `json:"arrival"`
				} `json:"arrival"`
			} `json:"sections"`
		} `json:"connections"`
	}
	params := url.Values{"from": {a.ID}, "to": {b.ID}, "limit": {"6"}, "direct": {"1"}}
	params.Add("transportations[]", "bus")
	if err := c.timetableGet(ctx, "/connections", params, &res); err != nil {
		return nil, err
	}
	out := &Timetable{From: a, To: b, Line: line, Journeys: []TimetableTrip{}}
	var secs []float64
	for _, cn := range res.Connections {
		if cn.Transfers > 0 {
			continue
		}
		var number, dep, arr string
		ok := true
		for _, sec := range cn.Sections {
			if sec.Journey == nil {
				continue // Fussweg am Anfang oder Ende
			}
			cat := strings.ToUpper(sec.Journey.Category)
			if cat != "B" && cat != "BUS" && cat != "NFB" && cat != "PB" {
				ok = false
			}
			number = strings.TrimSpace(sec.Journey.Number)
			if dep == "" {
				dep = sec.Departure.Departure
			}
			arr = sec.Arrival.Arrival
		}
		if !ok || number == "" {
			continue
		}
		if line != "" && !strings.EqualFold(number, line) && !strings.HasSuffix(strings.ToLower(number), " "+strings.ToLower(line)) {
			continue
		}
		d := parseDuration(cn.Duration)
		if d <= 0 {
			continue
		}
		secs = append(secs, d)
		out.Journeys = append(out.Journeys, TimetableTrip{Number: number, Departure: dep, Arrival: arr, Seconds: d})
	}
	if len(secs) == 0 {
		return nil, fmt.Errorf("%w: keine direkte Busverbindung%s zwischen %s und %s im Fahrplan", ErrBadRequest, lineHint(line), a.Name, b.Name)
	}
	sort.Float64s(secs)
	out.Trips = len(secs)
	out.Min = secs[0]
	out.Max = secs[len(secs)-1]
	if n := len(secs); n%2 == 1 {
		out.Median = secs[n/2]
	} else {
		out.Median = (secs[n/2-1] + secs[n/2]) / 2
	}
	data, _ := json.Marshal(out)
	c.timetableCache.set(key, data)
	return out, nil
}

func lineHint(line string) string {
	if line == "" {
		return ""
	}
	return " der Linie " + line
}
