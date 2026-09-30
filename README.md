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
| Tempolimit | Pro Strasse in km/h (Schnellwahl 20/30/50/80 oder Standard je Strassentyp); wird beim Übernehmen aus OSM `maxspeed` gelesen (auch `30 mph`, `CH:urban` usw.) und ab Zoom 16 als Schild gezeichnet |
| Routen-Rechner | Start A und Ziel B klicken: schnellste Fahrroute im heutigen OSM-Netz vs. im Netz mit dem Entwurf (neue Strassen dazu, Rückbau weg, übernommene Strassen mit ihren Änderungen), Distanz und Fahrzeit aus Tempolimits, gezeichnete Kreuzungen kosten Zeit (Ampel 20 s, Stop 8 s, Vortritt 3 s), Kreisel verbinden ihre Anschlüsse |
| Bild / PDF | Export-Dialog: aktuelle Ansicht oder ganzer Entwurf, A4/A3, Hoch- oder Querformat, 96/150/300 dpi. Die Karte wird dafür offscreen neu gezeichnet (Kacheln werden vorgeladen), mit Titel, Legende, Massstab, Routenvergleich und OSM-Attribution; PNG oder einseitiges PDF, beides ohne Bibliothek |
| Abschnitte | Jeder Abschnitt zwischen zwei Punkten hat seine eigene Führung: **Ebenerdig, Brücke oder Tunnel** |
| Kreuzungen / Punkte | Punkt mit Art (Kreuzung, Ampel, Vortritt, Stop, Fussgängerstreifen, Bushaltestelle) |
| Flächen | Polygone als Tempo-30-Zone, Begegnungszone (20), Fussgängerzone, Parkplatz oder sonstige Fläche; Eckpunkte ziehen, einfügen, löschen. Zonen mit Tempolimit deckeln im Routen-Rechner alle Strassen darin, Fussgängerzonen sperren sie |
| Kommentare | Wer den Ansichtslink hat, heftet Kommentare an Kartenpunkte und antwortet auf Kommentare (eine Ebene). Besitzer und Verfasser können erledigen oder löschen; Löschen eines Kommentars nimmt seine Antworten mit. Kommentare liegen getrennt vom Entwurf auf dem Server |
| Benachrichtigungen | Web-Push ohne Fremdbibliothek (RFC 8291 aes128gcm, RFC 8292 VAPID): der Besitzer abonniert alle neuen Kommentare und Antworten, andere Antworten auf ihre eigenen Kommentare. Klick auf die Benachrichtigung öffnet den Entwurf beim Kommentar. Bei offener Seite prüft die App zusätzlich alle 45 s auf neue Kommentare |
| Kreisel | Zentrum klicken, Radius mit der Maus wählen; später in Metern editierbar |
| Einrasten | Beim Zeichnen und Verschieben rastet der Cursor an eigene Punkte, Abschnitte, Kreisel-Ringe und – ab Zoom 16 – an OSM-Strassen. Wird auf einen eigenen Abschnitt eingerastet, wird dieser dort geteilt, damit das Netz verbunden ist. **Shift** (einstellbar: Shift/Ctrl/Alt) gedrückt halten setzt das Einrasten für die aktuelle Aktion aus. |
| OSM übernehmen | Bestehende OSM-Strasse anklicken und als bearbeitbare Kopie holen (Name, Typ, Brücke/Tunnel, Einbahn, Tempolimit werden übernommen; die Kopie merkt sich den OSM-Way, damit der Routen-Rechner ihn ersetzt) |
| Bearbeiten | Punkte ziehen, Zwischenpunkte einfügen, Punkte per Rechtsklick löschen, Eigenschaften in der Seitenleiste, Tooltip beim Überfahren |
| Speichern | Entwürfe liegen auf dem Server; der Browser merkt sich die eigenen (mit Bearbeitungs-Token). Arbeitskopie wird lokal automatisch gesichert |
| Historie | Rückgängig/Wiederholen in der Sitzung; jedes Speichern legt eine Version an (Standard: 30), die wiederhergestellt werden kann |
| Teilen | **Ansichtslink** `/d/<id>` (Empfänger können eine eigene Kopie weiterbearbeiten), **Bearbeitungslink** `/d/<id>#edit=<token>` für gemeinsames Bearbeiten, E-Mail-Versand, JSON-Import/-Export, GeoJSON-Export |

### Tastenkürzel

`V` Auswählen · `S` Strasse · `K` Kreuzung/Punkt · `R` Kreisel · `F` Fläche · `O` OSM übernehmen · `T` Route · `C` Kommentar ·
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
| `WRITE_RATE` | `60` | Schreibende API-Aufrufe pro Minute und Client-IP (Burst 20); `0` schaltet die Drosselung aus |
| `TRUST_PROXY` | leer | `1`, wenn die Client-IP aus `X-Forwarded-For` gelesen werden soll (hinter einem Reverse-Proxy) |
| `PUSH` | `1` | `0` schaltet Web-Push ab. Das VAPID-Schlüsselpaar entsteht beim ersten Start in `DATA_DIR/vapid.json` |
| `VAPID_SUBJECT` | Repo-URL | Kontakt für die Push-Dienste, z. B. `mailto:du@example.org` |

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
| `GET` | `/api/drafts/{id}/comments` | Kommentare (älteste zuerst) |
| `POST` | `/api/drafts/{id}/comments` | Kommentar anlegen: `{lat, lng, author?, text, clientId?}` oder Antwort `{parentId, author?, text}` → `{comment, commentToken}` (kein Edit-Token nötig) |
| `PATCH` | `/api/drafts/{id}/comments/{cid}` | `{resolved}`; Header `X-Edit-Token` (Besitzer) oder `X-Comment-Token` (Verfasser) |
| `DELETE` | `/api/drafts/{id}/comments/{cid}` | Kommentar löschen (samt Antworten); gleiche Berechtigung |
| `GET` | `/api/push/key` | `{enabled, publicKey}` für `PushManager.subscribe` |
| `PUT` | `/api/drafts/{id}/push` | Abonnement `{clientId, subscription, role, threads}`; `role: all` braucht das Edit-Token, sonst `replies` |
| `DELETE` | `/api/drafts/{id}/push?clientId=` | Abonnement lösen |
| `GET` | `/sw.js` | Service Worker (Push-Empfang, Klick öffnet den Kommentar) |
| `GET` | `/api/search?q=` | Ortssuche |
| `GET` | `/api/roads?bbox=s,w,n,e` | OSM-Strassen im Bereich (max. 0.06°) |
| `GET` | `/tiles/{z}/{x}/{y}.png` | Kachel-Proxy mit Cache |
| `GET` | `/healthz` | Lebenszeichen |

Der Server prüft eingehende Entwürfe (Struktur, Grenzen, Aufzählungswerte)
und lehnt Ungültiges mit `400` ab; Bodies sind auf 8 MB begrenzt. Schreibende
Aufrufe sind pro Client-IP gedrosselt (`429` mit `Retry-After`).

## Aufbau

```
main.go                  Konfiguration, HTTP-Server, eingebettetes web/
internal/model/          Entwurfsmodell, Validierung, Kennzahlen
internal/store/          Datei-Store: drafts/<id>/{meta,current,versions/*}.json
internal/osm/            Nominatim, Overpass, Kachel-Proxy (Drosselung, Caches)
internal/push/           Web-Push: aes128gcm-Verschlüsselung, VAPID-JWT, Versand, Schlüsseldatei
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
web/js/routing.js        Routen-Rechner: Netz aus OSM + Entwurf, Dijkstra, maxspeed-Parser
web/js/export.js         PNG/PDF-Export (Bildkomposition, handgeschriebener PDF-Writer)
web/js/api.js            Aufrufe ans Backend
web/js/local.js          Browser-lokal: eigene Entwürfe, Arbeitskopie, Einstellungen, Browser-Kennung
web/js/push.js           Service Worker registrieren, Push-Abonnement anlegen/lösen
web/sw.js                Service Worker: Benachrichtigung anzeigen, Klick öffnet den Kommentar
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
      "status": "new", "oneway": false, "maxspeed": 50, "osmId": null,
      "nodes": [[47.05, 8.30], [47.051, 8.302], [47.052, 8.305]],
      "segments": [{ "level": "ground" }, { "level": "tunnel" }] },
    { "id": "j_…", "type": "junction", "layerId": "l_…", "kind": "signals", "at": [47.05, 8.30] },
    { "id": "k_…", "type": "roundabout", "layerId": "l_…", "center": [47.052, 8.305], "radius": 14 },
    { "id": "z_…", "type": "zone", "layerId": "l_…", "kind": "tempo30",
      "nodes": [[47.049, 8.299], [47.049, 8.303], [47.052, 8.303], [47.052, 8.299]] }
  ],
  "route": { "from": [47.049, 8.298], "to": [47.053, 8.306] }
}
```

`segments` hat immer einen Eintrag weniger als `nodes`. `maxspeed` ist
optional (null = Standard je Strassentyp), `osmId` verweist auf den
übernommenen OSM-Way, `route` ist die gespeicherte Anfrage des Routen-Rechners.

### Routen-Rechner: Annahmen

- Befahrbar sind OSM-Ways mit `highway` in motorway…service und
  living_street; Fusswege, Velowege, Feldwege und `access=no/private` nicht.
- Geschwindigkeit: OSM `maxspeed`, sonst Standard je `highway` (z. B.
  residential 50, service 30, living_street 20). Für gezeichnete Strassen das
  gesetzte Tempolimit, sonst Standard je Typ (Hauptstrasse 50, Quartierstrasse
  30, Zufahrt 20; Fuss-/Veloweg nicht befahrbar).
- Einbahnen werden beachtet (OSM `oneway`, Zeichenrichtung im Entwurf).
- Zonen mit Tempolimit deckeln jeden Abschnitt, dessen Mittelpunkt in der
  Fläche liegt; Fussgängerzonen sperren ihn.
- Das Netz wird in Zellen von 0.025° (etwa 2,8 km × 1,9 km) geladen, für den
  Bereich um Start und Ziel plus Rand, höchstens 100 Zellen pro Anfrage. Der
  Server begrenzt weiterhin jede einzelne Abfrage auf 0.06°. Ohne Abbiege- und
  Verkehrsmodell sind die Zeiten Richtwerte für den Vergleich, keine Prognose.

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

- Web-Push braucht HTTPS (oder localhost) und einen Browser mit Push-
  Unterstützung; auf iOS erst, wenn die Seite zum Home-Bildschirm hinzugefügt
  ist. Ohne Push bleibt die Abfrage bei offener Seite.

- Kein Benutzerkonto: Wer den Bearbeitungslink hat, kann alles ändern. Der
  Ansichtslink ist ungefährlich, weil Empfänger nur Kopien bearbeiten.
- Entwürfe werden nicht automatisch gelöscht; Aufräumen heisst Ordner unter
  `DATA_DIR/drafts` entfernen.
- Der Routen-Rechner kennt keine Abbiegebeziehungen, Ampeln aus OSM oder
  Verkehrsaufkommen; er vergleicht Netzgeometrie und Tempolimits.
- Der Export in 300 dpi auf A3 erzeugt Bilder um 4900 × 3500 Pixel; auf
  schwachen Geräten dauert das einige Sekunden.
