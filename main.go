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
	"strings"
	"syscall"
	"time"

	"stadtplaner/internal/blob"
	"stadtplaner/internal/mail"
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

// listenAddr: ADDR gewinnt; sonst PORT (PaaS wie Deploio setzen nur den Port); sonst :8080.
func listenAddr() string {
	if v := os.Getenv("ADDR"); v != "" {
		return v
	}
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return ":8080"
}

func main() {
	addr := flag.String("addr", listenAddr(), "Adresse, auf der der Server lauscht (env ADDR, sonst PORT)")
	dataDir := flag.String("data", env("DATA_DIR", "./data"), "Ordner für Entwürfe und Kachel-Cache (env DATA_DIR)")
	tileURL := flag.String("tile-url", env("TILE_URL", osm.DefaultTileURL), "Kachel-Vorlage mit {z}/{x}/{y} (env TILE_URL)")
	nominatimURL := flag.String("nominatim-url", env("NOMINATIM_URL", osm.DefaultNominatimURL), "Nominatim-Endpunkt (env NOMINATIM_URL)")
	overpassURL := flag.String("overpass-url", env("OVERPASS_URL", osm.DefaultOverpassURL), "Overpass-Endpunkt (env OVERPASS_URL)")
	profileURL := flag.String("profile-url", env("PROFILE_URL", osm.DefaultProfileURL), "Höhenprofil-Dienst, leer = aus (env PROFILE_URL)")
	parcelURL := flag.String("parcel-url", env("PARCEL_URL", osm.DefaultParcelURL), "Identify-Dienst für Parzellen (geo.admin), leer = aus (env PARCEL_URL)")
	timetableURL := flag.String("timetable-url", env("TIMETABLE_URL", osm.DefaultTimetableURL), "Fahrplan-API (transport.opendata.ch), leer = aus (env TIMETABLE_URL)")
	userAgent := flag.String("user-agent", env("USER_AGENT", osm.DefaultUserAgent), "User-Agent gegenüber OSM-Diensten (env USER_AGENT)")
	maxVersions := flag.Int("max-versions", atoi(env("MAX_VERSIONS", "30"), 30), "Versionen pro Entwurf (env MAX_VERSIONS)")
	writeRate := flag.Float64("write-rate", atof(env("WRITE_RATE", "60"), 60), "Schreibende API-Aufrufe pro Minute und Client, 0 = aus (env WRITE_RATE)")
	trustProxy := flag.Bool("trust-proxy", env("TRUST_PROXY", "") == "1", "Client-IP aus X-Forwarded-For lesen, hinter einem Reverse-Proxy (env TRUST_PROXY=1)")
	pushEnabled := flag.Bool("push", env("PUSH", "1") != "0", "Web-Push-Benachrichtigungen (env PUSH=0 schaltet ab)")
	vapidSubject := flag.String("vapid-subject", env("VAPID_SUBJECT", ""), "Kontakt für Push-Dienste, z. B. mailto:… (env VAPID_SUBJECT)")
	retentionDays := flag.Int("retention-days", atoi(env("RETENTION_DAYS", "365"), 365), "Entwürfe nach so vielen Tagen ohne Speichern löschen, 0 = nie (env RETENTION_DAYS)")
	reminderDays := flag.String("reminder-days", env("REMINDER_DAYS", "30,7"), "Erinnerung per E-Mail so viele Tage vor dem Löschen, kommagetrennt (env REMINDER_DAYS)")
	publicURL := flag.String("public-url", env("PUBLIC_URL", ""), "Öffentliche Adresse der App für Links in E-Mails (env PUBLIC_URL)")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.LstdFlags)
	// Ablage der Entwürfe: S3-Bucket, wenn S3_BUCKET gesetzt ist (PaaS ohne dauerhafte Platte), sonst DATA_DIR
	var blobs blob.Store
	var storage string
	if cfg, ok := blob.S3FromEnv(); ok {
		s3, err := blob.NewS3(cfg)
		if err != nil {
			logger.Fatalf("Store: %v", err)
		}
		if _, err := s3.Get("vapid.json"); err != nil && !errors.Is(err, blob.ErrNotExist) {
			logger.Fatalf("Store: Bucket %s unter %s nicht erreichbar: %v", cfg.Bucket, s3.Endpoint(), err)
		}
		blobs = s3
		storage = "Bucket " + cfg.Bucket + " (" + s3.Endpoint() + ")"
	} else {
		d, err := blob.NewDir(*dataDir)
		if err != nil {
			logger.Fatalf("Store: %v", err)
		}
		blobs = d
		storage = "Ordner " + *dataDir
	}
	st := store.New(blobs)
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
	client.ParcelURL = *parcelURL
	client.TimetableURL = *timetableURL
	client.UserAgent = *userAgent

	srv, err := server.New(st, client, webFS, logger)
	if err != nil {
		logger.Fatalf("Server: %v", err)
	}
	srv.SetRateLimit(server.RateLimit{PerMinute: *writeRate, Burst: 20, TrustProxy: *trustProxy})
	if *pushEnabled {
		keys, err := push.LoadOrCreateKeysFrom(blobs, "vapid.json")
		if err != nil {
			logger.Printf("Push deaktiviert, VAPID-Schlüssel: %v", err)
		} else {
			srv.SetPush(push.NewSender(keys, *vapidSubject))
		}
	}
	// Lebenszyklus: alte Entwürfe löschen, vorher per E-Mail erinnern (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM)
	lifecycle := server.Lifecycle{Retention: time.Duration(*retentionDays) * 24 * time.Hour, Reminders: parseDays(*reminderDays), PublicURL: *publicURL}
	if lifecycle.Retention > 0 {
		if cfg, ok := mail.FromEnv(); ok {
			mailer, err := mail.New(cfg)
			if err != nil {
				logger.Fatalf("E-Mail: %v", err)
			}
			lifecycle.Mailer = mailer
			logger.Printf("Entwürfe werden nach %d Tagen gelöscht, Erinnerungen über %s:%d von %s", *retentionDays, cfg.Host, cfg.Port, cfg.From)
		} else {
			logger.Printf("Entwürfe werden nach %d Tagen gelöscht; keine Erinnerungen, da SMTP_HOST nicht gesetzt ist", *retentionDays)
		}
	} else {
		logger.Println("Entwürfe werden nie automatisch gelöscht (RETENTION_DAYS=0)")
	}
	srv.SetLifecycle(lifecycle)
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
	srv.StartSweeper(ctx)
	go func() {
		logger.Printf("Stadtplaner läuft auf %s (Entwürfe: %s, Kachel-Cache: %s)", *addr, storage, filepath.Join(*dataDir, "tiles"))
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

// parseDays liest "30,7" als Fristen in Tagen; Unbrauchbares wird übersprungen.
func parseDays(list string) []time.Duration {
	var out []time.Duration
	for _, part := range strings.Split(list, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 {
			continue
		}
		out = append(out, time.Duration(n)*24*time.Hour)
	}
	return out
}

func atoi(s string, fallback int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return n
}
