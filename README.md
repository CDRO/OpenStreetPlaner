# Stadtplaner

Planungsvorschläge auf einer OpenStreetMap-Karte zeichnen, speichern und als
Link verschicken – zum Beispiel, um die Führung der Hauptstrasse durchs Dorf
neu zu setzen.

- **Native Web-App**: HTML, CSS und ES-Module ohne Framework und ohne
  Kartenbibliothek. Die Slippy-Map (Kacheln, Pan, Zoom, Pinch) ist selbst
  geschrieben und zeichnet auf ein Canvas.
- **Backend in Go**, nur Standardbibliothek: speichert Entwürfe samt
  Versionen als Dateien, proxied Suche (Nominatim), Strassendaten (Overpass)
  und Kacheln mit Cache und ordentlichem User-Agent.
- **Ein Dockerfile**, ein Binary, ein Volume.

## Schnellstart

```sh
docker build -t stadtplaner .
docker run --rm -p 8080:8080 -v stadtplaner-data:/data stadtplaner
# http://localhost:8080
```

Ohne Docker (Go ≥ 1.24):

```sh
go run . -data ./data
```

## Funktionen

| Bereich | Was geht |
|---|---|
| Karte | OSM-Kacheln über den eigenen Proxy, Massstab, Zoom 2–20, Maus, Touch (Pinch), Tastatur |
| Suche | Ort/Adresse wie in einer Karten-App, oder direkt `lat, lng`; Button „Mein Standort“ |
| Ebenen | Beliebig viele, ein-/ausblenden, umbenennen, einfärben, sortieren; jedes Element gehört zu einer Ebene |
| Strassen | Linienzug zeichnen (Klick für Punkte, Doppelklick/Enter/Rechtsklick beendet), Strassentyp, Status *Neu / Bestehend / Rückbau*, Einbahn mit Pfeilen, Beschriftung ab Zoom 16 |
| Abschnitte | Jeder Abschnitt zwischen zwei Punkten hat seine eigene Führung: **Ebenerdig, Brücke oder Tunnel** |
| Kreuzungen | Punkt mit Art (Kreuzung, Ampel, Vortritt, Stop) |
| Kreisel | Zentrum klicken, Radius mit der Maus wählen; später in Metern editierbar |
| Einrasten | Beim Zeichnen und Verschieben rastet der Cursor an eigene Punkte, Abschnitte, Kreisel-Ringe und – ab Zoom 16 – an OSM-Strassen. Wird auf einen eigenen Abschnitt eingerastet, wird dieser dort geteilt, damit das Netz verbunden ist. **Shift** (einstellbar: Shift/Ctrl/Alt) gedrückt halten setzt das Einrasten für die aktuelle Aktion aus. |
| OSM übernehmen | Bestehende OSM-Strasse anklicken und als bearbeitbare Kopie holen (Name, Typ, Brücke/Tunnel, Einbahn werden übernommen) |
| Bearbeiten | Punkte ziehen, Zwischenpunkte einfügen, Punkte per Rechtsklick löschen, Eigenschaften in der Seitenleiste, Tooltip beim Überfahren |
| Speichern | Entwürfe liegen auf dem Server; der Browser merkt sich die eigenen (mit Bearbeitungs-Token). Arbeitskopie wird lokal automatisch gesichert |
| Historie | Rückgängig/Wiederholen in der Sitzung; jedes Speichern legt eine Version an (Standard: 30), die wiederhergestellt werden kann |
| Teilen | **Ansichtslink** `/d/<id>` (Empfänger können eine eigene Kopie weiterbearbeiten), **Bearbeitungslink** `/d/<id>#edit=<token>` für gemeinsames Bearbeiten, E-Mail-Versand, JSON-Import/-Export, GeoJSON-Export |

### Tastenkürzel

`V` Auswählen · `S` Strasse · `K` Kreuzung · `R` Kreisel · `O` OSM übernehmen ·
`Enter` Strasse beenden · `Esc` abbrechen · `⌫` letzter Punkt · `Entf` löschen ·
`Ctrl+Z` / `Ctrl+Y` rückgängig / wiederholen · `Ctrl+S` speichern ·
Karte: Pfeiltasten, `+` / `−`

## Konfiguration

Umgebungsvariablen (oder gleichnamige Flags, siehe `go run . -h`):

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADDR` | `:8080` | Adresse, auf der der Server lauscht |
| `DATA_DIR` | `/data` (Docker) bzw. `./data` | Entwürfe (`drafts/`) und Kachel-Cache (`tiles/`) |
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Kachel-Vorlage, z. B. eigener Tile-Server |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Geocoder |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Strassengeometrie |
| `USER_AGENT` | `Stadtplaner/1.0 (+…)` | User-Agent gegenüber den OSM-Diensten – bitte auf die eigene Installation anpassen |
| `MAX_VERSIONS` | `30` | Versionen pro Entwurf |

Die öffentlichen OSM-Dienste haben Nutzungsbedingungen (Kacheln, Nominatim,
Overpass). Der Server drosselt Nominatim auf eine Anfrage pro Sekunde, cacht
Suchergebnisse, Strassen und Kacheln und schickt einen identifizierenden
User-Agent. Für mehr als eine Handvoll Nutzer gehört ein eigener Kachel-Server
oder ein kommerzieller Anbieter in `TILE_URL`.

## API

Alle Antworten sind JSON. Schreibende Aufrufe brauchen den Header
`X-Edit-Token`, den `POST /api/drafts` einmalig zurückgibt (der Server
speichert nur einen Hash davon).

| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/api/drafts` | Entwurf anlegen: `{doc, label?}` → `{id, editToken, doc}` |
| `GET` | `/api/drafts/{id}` | Aktueller Stand |
| `PUT` | `/api/drafts/{id}` | Speichern: `{doc, label?}` (legt eine Version an) |
| `DELETE` | `/api/drafts/{id}` | Entwurf löschen |
| `POST` | `/api/drafts/{id}/auth` | Token prüfen (204/403) |
| `POST` | `/api/drafts/{id}/fork` | Kopie mit eigenem Token: `{name?}` |
| `GET` | `/api/drafts/{id}/versions` | Versionsliste (neueste zuerst) |
| `GET` | `/api/drafts/{id}/versions/{n}` | Eine Version samt Inhalt |
| `GET` | `/api/search?q=` | Ortssuche |
| `GET` | `/api/roads?bbox=s,w,n,e` | OSM-Strassen im Bereich (max. 0.06°) |
| `GET` | `/tiles/{z}/{x}/{y}.png` | Kachel-Proxy mit Cache |
| `GET` | `/healthz` | Lebenszeichen |

Der Server prüft eingehende Entwürfe (Struktur, Grenzen, Aufzählungswerte)
und lehnt Ungültiges mit `400` ab; Bodies sind auf 8 MB begrenzt.

## Aufbau

```
main.go                  Konfiguration, HTTP-Server, eingebettetes web/
internal/model/          Entwurfsmodell, Validierung, Kennzahlen
internal/store/          Datei-Store: drafts/<id>/{meta,current,versions/*}.json
internal/osm/            Nominatim, Overpass, Kachel-Proxy (Drosselung, Caches)
internal/server/         Routen, JSON-API, Sicherheits-Header, statische Dateien
web/index.html           Seitengerüst
web/css/app.css          Gestaltung
web/js/map.js            Slippy-Map auf Canvas (Kacheln, Pan/Zoom/Pinch, Ereignisse)
web/js/draw.js           Zeichnet Entwurf, Griffe, Vorschau, Einrast-Markierung
web/js/tools.js          Werkzeuge und Mausinteraktion
web/js/model.js          Datenmodell, Validierung, GeoJSON
web/js/geometry.js       Mercator-Projektion, Distanzen, Einrast-Mathematik
web/js/snap.js           Einrast-Index aus Entwurf + OSM-Daten
web/js/store.js          Zustand mit Undo/Redo
web/js/osm.js            Strassen-Cache, Tag-Zuordnung
web/js/api.js            Aufrufe ans Backend
web/js/local.js          Browser-lokal: eigene Entwürfe, Arbeitskopie, Einstellungen
web/js/ui.js             Seitenleiste, Dialoge, Statuszeile
web/js/app.js            Verdrahtung
web/tests/               Unit-Tests (Node-Testrunner) und Browser-Tests (Playwright)
```

### Datenformat eines Entwurfs

```json
{
  "version": 1, "id": "…", "name": "Hauptstrasse neu",
  "view": { "center": [47.05, 8.3], "zoom": 16 },
  "layers": [{ "id": "l_…", "name": "Variante A", "color": "#d7263d", "visible": true }],
  "features": [
    { "id": "r_…", "type": "road", "layerId": "l_…", "name": "Umfahrung", "kind": "main",
      "status": "new", "oneway": false,
      "nodes": [[47.05, 8.30], [47.051, 8.302], [47.052, 8.305]],
      "segments": [{ "level": "ground" }, { "level": "tunnel" }] },
    { "id": "j_…", "type": "junction", "layerId": "l_…", "kind": "signals", "at": [47.05, 8.30] },
    { "id": "k_…", "type": "roundabout", "layerId": "l_…", "center": [47.052, 8.305], "radius": 14 }
  ]
}
```

`segments` hat immer einen Eintrag weniger als `nodes`.

## Entwicklung und Tests

```sh
make test            # go vet + go test + Frontend-Unit-Tests (node --test)
make test-browser    # Browser-Tests; braucht Go und Playwright mit Chromium
make run             # Server lokal
make docker          # Image bauen
```

Die CI (`.github/workflows/ci.yml`) führt gofmt, vet, Go-Tests, die
Frontend-Unit-Tests und einen Docker-Build mit Smoke-Test aus.

## Grenzen

- Kein Benutzerkonto: Wer den Bearbeitungslink hat, kann alles ändern. Der
  Ansichtslink ist ungefährlich, weil Empfänger nur Kopien bearbeiten.
- Entwürfe werden nicht automatisch gelöscht; Aufräumen heisst Ordner unter
  `DATA_DIR/drafts` entfernen.
- Export als Bild oder PDF, Massnahmen wie Tempo-30-Zonen oder Parkplätze
  fehlen noch.
