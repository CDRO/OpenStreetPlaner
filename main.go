// Stadtplaner: Planungsvorschläge auf OpenStreetMap zeichnen, speichern und teilen.
// Ein einzelnes Binary mit eingebetteter Web-Oberfläche; Daten liegen als
// Dateien unter DATA_DIR.
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"stadtplaner/internal/osm"
	"stadtplaner/internal/push"
	"stadtplaner/internal/server"
	"stadtplaner/internal/store"
)

//go:embed web
var webFS embed.FS

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := flag.String("addr", env("ADDR", ":8080"), "Adresse, auf der der Server lauscht (env ADDR)")
	dataDir := flag.String("data", env("DATA_DIR", "./data"), "Ordner für Entwürfe und Kachel-Cache (env DATA_DIR)")
	tileURL := flag.String("tile-url", env("TILE_URL", osm.DefaultTileURL), "Kachel-Vorlage mit {z}/{x}/{y} (env TILE_URL)")
	nominatimURL := flag.String("nominatim-url", env("NOMINATIM_URL", osm.DefaultNominatimURL), "Nominatim-Endpunkt (env NOMINATIM_URL)")
	overpassURL := flag.String("overpass-url", env("OVERPASS_URL", osm.DefaultOverpassURL), "Overpass-Endpunkt (env OVERPASS_URL)")
	profileURL := flag.String("profile-url", env("PROFILE_URL", osm.DefaultProfileURL), "Höhenprofil-Dienst, leer = aus (env PROFILE_URL)")
	userAgent := flag.String("user-agent", env("USER_AGENT", osm.DefaultUserAgent), "User-Agent gegenüber OSM-Diensten (env USER_AGENT)")
	maxVersions := flag.Int("max-versions", atoi(env("MAX_VERSIONS", "30"), 30), "Versionen pro Entwurf (env MAX_VERSIONS)")
	writeRate := flag.Float64("write-rate", atof(env("WRITE_RATE", "60"), 60), "Schreibende API-Aufrufe pro Minute und Client, 0 = aus (env WRITE_RATE)")
	trustProxy := flag.Bool("trust-proxy", env("TRUST_PROXY", "") == "1", "Client-IP aus X-Forwarded-For lesen, hinter einem Reverse-Proxy (env TRUST_PROXY=1)")
	pushEnabled := flag.Bool("push", env("PUSH", "1") != "0", "Web-Push-Benachrichtigungen (env PUSH=0 schaltet ab)")
	vapidSubject := flag.String("vapid-subject", env("VAPID_SUBJECT", ""), "Kontakt für Push-Dienste, z. B. mailto:… (env VAPID_SUBJECT)")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.LstdFlags)
	st, err := store.Open(*dataDir)
	if err != nil {
		logger.Fatalf("Store: %v", err)
	}
	st.SetMaxVersions(*maxVersions)

	client := osm.New(filepath.Join(*dataDir, "tiles"))
	client.TileURL = *tileURL
	sources := osm.DefaultTileSources()
	sources[0].URL = *tileURL // TILE_URL bleibt die Standardquelle "osm"
	client.SetSources(sources)
	if extra := os.Getenv("TILE_SOURCES"); extra != "" {
		list, err := osm.ParseTileSources(extra)
		if err != nil {
			logger.Fatalf("%v", err)
		}
		client.SetSources(list)
	}
	client.NominatimURL = *nominatimURL
	client.OverpassURL = *overpassURL
	client.ProfileURL = *profileURL
	client.UserAgent = *userAgent

	srv, err := server.New(st, client, webFS, logger)
	if err != nil {
		logger.Fatalf("Server: %v", err)
	}
	srv.SetRateLimit(server.RateLimit{PerMinute: *writeRate, Burst: 20, TrustProxy: *trustProxy})
	if *pushEnabled {
		keys, err := push.LoadOrCreateKeys(filepath.Join(*dataDir, "vapid.json"))
		if err != nil {
			logger.Printf("Push deaktiviert, VAPID-Schlüssel: %v", err)
		} else {
			srv.SetPush(push.NewSender(keys, *vapidSubject))
		}
	}
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		logger.Printf("Stadtplaner läuft auf %s (Daten: %s)", *addr, *dataDir)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("HTTP: %v", err)
		}
	}()
	<-ctx.Done()
	logger.Println("Beende…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	srv.WaitPush()
}

func atof(s string, fallback float64) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return fallback
	}
	return f
}

func atoi(s string, fallback int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return n
}
