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
| Karte | Kacheln über den eigenen Proxy: OpenStreetMap, swisstopo Landeskarte (farbig, grau), Luftbild, dazu das Parzellen-Overlay der amtlichen Vermessung (WMS, ab Zoom 15). Eigene Quellen über `TILE_SOURCES`. Massstab, Zoom 2–20, Maus, Touch (Pinch), Tastatur |
| Suche | Ort/Adresse wie in einer Karten-App, oder direkt `lat, lng`; Button „Mein Standort“ |
| Ebenen | Beliebig viele, ein-/ausblenden, umbenennen, einfärben, sortieren; jedes Element gehört zu einer Ebene |
| Strassen | Linienzug zeichnen (Klick für Punkte, Doppelklick/Enter/Rechtsklick beendet), Strassentyp (Autobahn 120, Autostrasse 100, Haupt-, Neben-, Quartierstrasse, Zufahrt, Fuss-/Veloweg), Status *Neu / Bestehend / Rückbau*, Einbahn mit Pfeilen, Beschriftung ab Zoom 16. Autobahnen und Strassen mit Mittelstreifen werden ab Zoom 15 als zwei getrennte Fahrbahnen gezeichnet; Autobahn/Autostrasse sind für Fussgänger und Velos gesperrt |
| Querschnitte | Pro Strasse: Zahl und Breite der Fahrstreifen, Mittelstreifen, Pannenstreifen, Velostreifen, Trottoir und Parkstreifen links/rechts mit Breiten. Die Gesamtbreite ersetzt die Breitenangabe; ab Zoom 17 werden die Bänder gezeichnet, ab Zoom 18 mit Fahrstreifen-Markierungen. Standard je Strassentyp, wenn keiner gesetzt ist |
| Tempolimit | Pro Strasse in km/h (Schnellwahl 20/30/50/80 oder Standard je Strassentyp); wird beim Übernehmen aus OSM `maxspeed` gelesen (auch `30 mph`, `CH:urban` usw.) und ab Zoom 16 als Schild gezeichnet |
| Routen-Rechner | Start A und Ziel B klicken: schnellste Fahrroute im heutigen OSM-Netz vs. im Netz mit dem Entwurf (neue Strassen dazu, Rückbau weg, übernommene Strassen mit ihren Änderungen, nur sichtbare Ebenen), Distanz und Fahrzeit aus Tempolimits, gezeichnete Kreuzungen kosten Zeit (Ampel 20 s, Stop 8 s, Vortritt 3 s), Kreisel verbinden ihre Anschlüsse. **Abbiegen**: an Knoten mit drei und mehr Armen kostet rechts 2 s, links 5 s, wenden 15 s (Rechtsverkehr, aus dem Richtungswechsel berechnet); Abbiegeverbote an gezeichneten Kreuzungen sperren die Richtung, Anschlüsse und Kreisel sind kostenfrei. Die Suche läuft über (Knoten, Vorgänger)-Zustände, damit Verbote korrekt wirken |
| Routenpaare | Routen-Tab: weitere benannte Start-Ziel-Paare (Schule, Bahnhof, Nachbardorf), je heute/neu mit Differenz, Summe und Mittel der Zeitgewinne; nummerierte Marker auf der Karte, Tabelle im Bericht und im Präsentationsmodus. Alle Paare rechnen auf denselben beiden Netzen |
| Erreichbarkeit | Routen-Tab: Isochronen-Netz ab einem Ursprung für 5/10/15 min (weitere Vorgaben), als „heute“, „neu“ oder Differenz (grün: nur mit Entwurf erreichbar, rot: nur heute). Kennzahl: erreichbare Netz-Kilometer je Band; Suche bricht bei der höchsten Schwelle ab, Kanten werden anteilig gezeichnet. Das OSM-Netz um den Ursprung wird automatisch geladen (Radius aus Minuten × 50 km/h × 0.7) |
| Buslinien | Routen-Tab: Linien mit Nummer, Farbe und Haltezeit je Zwischenhalt (Standard 20 s). „Haltestellen setzen“ und auf die Karte klicken: Klick auf eine bestehende Bushaltestelle hängt sie an, Klick anderswo setzt eine neue (eingerastet) und trägt die Liniennummer ein. Haltestellen lassen sich im Auswahl-Werkzeug am Griff verschieben, in der Linie nach vorne schieben oder entfernen; Liniennummern stehen am Punkt und ab Zoom 15 auf der Karte. Fahrzeit und Distanz heute/neu über alle Halte inkl. Haltezeit, Differenz; Linienverlauf gestrichelt in der Linienfarbe, Tabelle im Bericht und im Präsentationsmodus |
| Bestehender ÖV aus OSM | Routen-Tab, „Bestehende Linien aus OSM“: „Für Ansicht laden“ holt Bushaltestellen (`highway=bus_stop`, `public_transport=platform/stop_position` mit `bus=yes`) und Buslinien (Relationen `route=bus` mit Haltestellenfolge, Nummer, Name, Betreiber, Farbe) für den Kartenausschnitt (ab Zoom 13; beim Setzen von Haltestellen ab Zoom 14 automatisch). Haltestellen erscheinen blau mit „H“ und Namen; beim Setzen von Haltestellen hängt ein Klick darauf sie an die Linie (einmalig als eigene Haltestelle mit OSM-Kennung angelegt). „Übernehmen“ legt eine Linie mit allen Haltestellen in Reihenfolge an, bereits übernommene Haltestellen werden wiederverwendet; danach lässt sich die Linie wie jede andere bearbeiten, und Fahrzeit heute/neu zeigt sofort, was der Entwurf für sie bedeutet |
| Busausnahmen | Zugang je Strasse oder Abschnitt: „Alle Fahrzeuge“ oder „Nur Bus (Busschleuse)“ – für Autos gesperrt, Busse höchstens 30 km/h, gelb gestrichelt mit „BUS“ ab Zoom 16. Fussgängerzonen und andere gesperrte/langsame Flächen können „Busse dürfen durchfahren (20 km/h)“ erhalten. Buslinien rechnen auf dem Bus-Netz (zusätzlich OSM `highway=busway`, `bus=yes`, `psv=yes`), Routen-Rechner, Routenpaare und Erreichbarkeit auf dem Auto-Netz |
| Messen | Werkzeug „Messen“ (Taste M): Klicks setzen Messpunkte, Länge je Abschnitt und Summe stehen auf der Karte, ab drei Punkten auch die Fläche des geschlossenen Rings; Doppelklick oder Enter beendet, Esc löscht. Auch in der Ansicht ohne Bearbeitungsrecht |
| Mehrfachauswahl | Shift+Klick ergänzt oder entfernt Elemente, mit Shift gezogener Rahmen wählt alle Elemente darin, Ctrl+A alles auf sichtbaren Ebenen; Schalter „Mehrfachauswahl“ für Touch. Ziehen auf einem ausgewählten Element verschiebt die ganze Auswahl formtreu; Eigenschaften zeigen die Zusammenfassung mit Ebene, Status (Strassen), Hinzoomen und Löschen (auch Entf) |
| Kontextmenü | Rechtsklick oder Langdruck auf ein Element: Hinzoomen, Eigenschaften, Ebene, Status, Führung des Abschnitts (ebenerdig/Brücke/Tunnel), Zugang, Löschen – für die ganze Auswahl, wenn mehrere gewählt sind. Rechtsklick auf einen Griff löscht wie bisher den Punkt |
| Elementliste | Box „Elemente“ im Zeichnen-Tab: alle Elemente mit Typ, Ebene, Länge oder Status, Filter nach Name, Typ oder Ebene; Klick wählt aus und zoomt hin, Shift+Klick ergänzt die Auswahl |
| Touch | Mit dem Finger sind Griffe und Trefferflächen grösser (16 statt 9 Pixel), Langdruck öffnet das Kontextmenü, die Seitenleiste ist ein Bottom-Sheet |
| Variantenvergleich | Analyse-Tab: „Varianten vergleichen“ rechnet jede Ebene allein sichtbar: Elemente, neue Länge, Kosten, Fahrzeit-Differenz der Hauptroute und Summe der Paare, Parzellen, Gebäude entlang neuer Strassen, Warnungen; Tabelle im Bericht |
| Parkplatzbilanz | Analyse-Tab: neu aus Parkstreifen im Querschnitt (6 m je Platz) und Parkflächen (25 m² je Platz), entfallen aus OSM-Parkstreifen (`parking:*`, `parking:lane:*`) an übernommenen Strassen ohne Parkstreifen im Querschnitt oder bei Rückbau und aus OSM-Parkplätzen (`amenity=parking`, `capacity` oder Fläche), die neue Strassen oder Flächen berühren; Positionen mit Sprung zum Element, Zeile im Bericht |
| Etappierung | Ebenen-Tab: bis zehn Etappen mit Name und Jahr; Etappe je Element in den Eigenschaften, in der Mehrfachauswahl oder per Rechtsklick. Ansicht „bis Etappe“ zeigt den Zustand nach dieser Etappe: spätere Elemente grau gestrichelt, Routen, Paare, Buslinien und Erreichbarkeit im Netz dieses Zustands. Analyse-Tab und Bericht: Elemente, Kosten und Fahrzeit kumuliert je Etappe |
| Ohne Farbsehen | Heute/Neu und Differenzen unterscheiden sich auch durch Muster: Route neu und Paare neu gestrichelt, nicht mehr erreichbares Netz gestrichelt, Versionsvergleich mit durchgezogen/punktiert/gestrichelt, betroffene Gebäude schraffiert (diagonal, Punkte, Kreuz), Zuversicht-Punkte mit ✓ ! ✕ |
| Dunkelmodus | „Darstellung“ in der Karten-Box: wie das System, hell oder dunkel. Oberfläche über Farbtoken, Kacheln werden am Bildschirm invertiert gezeichnet (Export bleibt hell), native Eingabefelder folgen über `color-scheme` |
| Zuversicht | Jedes Ergebnis trägt eine von drei Stufen (hoch, mittel, tief) mit aufklappbaren Gründen: Fahrzeiten nach dem Anteil der Strecke mit geschätztem Tempo (OSM ohne `maxspeed`, Entwurf ohne Tempolimit), unvollständig geladenem Netz, Tempolimit- statt Geometriemodell und fehlendem Höhenprofil; Buslinien zusätzlich mit Standard-Haltezeit; OSM-Linien nach Haltepositionen, Plattformen oder fehlenden Rollen; Kosten mit Band ±25 % (eigene Ansätze) bzw. ±40 % (Standardwerte), unbekannte Breiten und pauschale Brücken/Tunnel; Parzellen hoch (amtliche Vermessung), Gebäude und Normen-Check mittel. Keine Statistik, sondern Transparenz über Annahmen. Im PDF-Bericht als Zeile je Ergebnis, im Export-Dialog abschaltbar |
| Geschwindigkeitsmodell | Schalter im Routen-Tab: Fahrzeit aus der Strassenführung statt nur aus dem Limit. Kurvenradien aus der Geometrie (v = √(3 m/s² · R)), Steigung aus dem Höhenprofil, Wartezeiten an Kreuzungen und Kreiseln mit Streuung. Ergebnis als typische Zeit mit Band P15–P85 |
| Glätten / Vereinfachen | Strassen per Catmull-Rom-Spline glätten (Abschnittseigenschaften bleiben) oder per Douglas-Peucker auf 1 m vereinfachen |
| Höhenprofil | Pro Strasse vom swisstopo-Profildienst laden: Gelände, Steigungen, Brücken über und Tunnel unter dem Gelände als Diagramm; fliesst ins Geschwindigkeitsmodell ein |
| Bild / PDF | Export-Dialog: aktuelle Ansicht oder ganzer Entwurf, A4/A3, Hoch- oder Querformat, 96/150/300 dpi. Die Karte wird dafür offscreen neu gezeichnet (Kacheln werden vorgeladen), mit Titel, Legende, Massstab, Nordpfeil, QR-Code, Routenvergleich und OSM-Attribution; PNG oder PDF, beides ohne Bibliothek. **Fester Massstab** 1:500 bis 1:10'000 um die Kartenmitte mit Planrahmen (Titel, Massstab, Blatt, Datum); liegt der Massstab über der Kachelgrenze (Zoom 19), steht der tatsächlich gezeichnete daneben. Option **Bericht anhängen**: weitere PDF-Seiten mit Massnahmenliste (Strassen mit Typ, Länge, Tempo, Brücken/Tunnel; Punkte; Flächen), Routenvergleich, Kommentaren samt Antworten und Link zum Entwurf |
| Abschnitte | Jeder Abschnitt zwischen zwei Punkten hat seine eigene Führung: **Ebenerdig, Brücke oder Tunnel** |
| Kreuzungen / Punkte | Punkt mit Art (Kreuzung, Ampel, Vortritt, Stop, Anschluss (kreuzungsfrei, Raute), Fussgängerstreifen, Bushaltestelle) und **Abbiegeregeln** (links, geradeaus, rechts, wenden erlaubt; Verbote werden als rote Marken gezeichnet) |
| Flächen | Polygone als Tempo-30-Zone, Begegnungszone (20), Fussgängerzone, Parkplatz oder sonstige Fläche; Eckpunkte ziehen, einfügen, löschen. Zonen mit Tempolimit deckeln im Routen-Rechner alle Strassen darin, Fussgängerzonen sperren sie |
| Parzellen | Pro Strasse „Betroffene Parzellen ermitteln“: fragt über den Identify-Dienst von geo.admin die Liegenschaften der amtlichen Vermessung ab, die die Strasse berührt, und rechnet die Meter je Parzelle (Abtastung alle 1 m). Liste mit Nummer, Kanton und EGRID in den Eigenschaften und im Bericht, Umringe während der Sitzung orange auf der Karte; nach einer Geometrieänderung als veraltet markiert. Nur Schweiz, `PARCEL_URL` leer schaltet ab |
| Betroffene Gebäude | Tab „Analyse“: Gebäude aus OpenStreetMap für die Ansicht laden, dann Zahl der Gebäude innerhalb 25/50/100 m der heutigen Route, der neuen Route und aller neuen Strassen; Differenz heute/neu als Kennzahl, Hervorhebung auf der Karte (rot neu betroffen, grün entlastet, orange beides), Zahlen im Bericht |
| Kostenschätzung | Tab „Analyse“: Richtwerte je Strassentyp pro Kilometer (mit der Breite skaliert), Brücke und Tunnel als Zuschlag pro Meter, Kreisel, Kreuzungen und Flächen pauschal, Parkplätze pro m². Einheitskosten sind pro Entwurf anpassbar (`costs`), bestehende Strassen zählen nicht, das Total umfasst nur sichtbare Ebenen (Varianten per Ein-/Ausblenden). Positionen und Summen stehen auch im Bericht |
| Normen-Check | Tab „Analyse“: Kurvenradius gegen das Tempo (Richtwerte 25 m bei 30, 80 m bei 50, 240 m bei 80 km/h), Steigung aus dem Höhenprofil (über 8 % Hinweis, über 12 % Warnung), Kreiselradius 11–25 m, Fahrstreifenbreite je Strassentyp, Trottoir auf Autobahnen, Tempo über dem Zonenlimit, nicht angeschlossene Enden, Kreuzungen abseits des Netzes. Klick springt zum Element; die Liste steht auch im Bericht |
| Kommentare | Wer den Ansichtslink hat, heftet Kommentare an Kartenpunkte und antwortet auf Kommentare (eine Ebene). Besitzer und Verfasser können erledigen oder löschen; Löschen eines Kommentars nimmt seine Antworten mit. Kommentare liegen getrennt vom Entwurf auf dem Server |
| Benachrichtigungen | Web-Push ohne Fremdbibliothek (RFC 8291 aes128gcm, RFC 8292 VAPID): der Besitzer abonniert alle neuen Kommentare und Antworten, andere Antworten auf ihre eigenen Kommentare. Klick auf die Benachrichtigung öffnet den Entwurf beim Kommentar. Bei offener Seite prüft die App zusätzlich alle 45 s auf neue Kommentare |
| Kreisel | Zentrum klicken, Radius mit der Maus wählen; später in Metern editierbar |
| Einrasten | Beim Zeichnen und Verschieben rastet der Cursor an eigene Punkte, Abschnitte, Kreisel-Ringe und – ab Zoom 16 – an OSM-Strassen. Wird auf einen eigenen Abschnitt eingerastet, wird dieser dort geteilt, damit das Netz verbunden ist. **Shift** (einstellbar: Shift/Ctrl/Alt) gedrückt halten setzt das Einrasten für die aktuelle Aktion aus. |
| OSM übernehmen | Bestehende OSM-Strasse anklicken und als bearbeitbare Kopie holen (Name, Typ, Brücke/Tunnel, Einbahn, Tempolimit werden übernommen; die Kopie merkt sich den OSM-Way, damit der Routen-Rechner ihn ersetzt) |
| Bearbeiten | Punkte ziehen, Zwischenpunkte einfügen, Punkte per Rechtsklick löschen, Eigenschaften in der Seitenleiste, Tooltip beim Überfahren |
| Speichern | Entwürfe liegen auf dem Server; der Browser merkt sich die eigenen (mit Bearbeitungs-Token). Arbeitskopie wird lokal automatisch gesichert |
| Historie | Rückgängig/Wiederholen in der Sitzung; jedes Speichern legt eine Version an (Standard: 30), die wiederhergestellt werden kann. **Versionen vergleichen**: zwei Stände (oder Version gegen aktuellen Stand) als Liste hinzugefügter, entfernter und geänderter Elemente mit Beschreibung (Tempolimit 50 → 30, Geometrie 2 → 3 Punkte, Führung der Abschnitte …) und als Karten-Overlay (grün neu, orange geändert, rot gestrichelt entfernt) |
| Import | Stadtplaner-JSON ersetzt den Entwurf; GeoJSON, GPX und KML kommen als neue Ebene dazu (Linien → Strassen mit Status „bestehend“, Punkte → Kreuzungen/Punkte, Polygone → Flächen; `highway`, `maxspeed`, `oneway`, `kind`, `status` aus GeoJSON-Eigenschaften werden übernommen). Ohne DOM-Parser, bis 2000 Elemente |
| QR-Code | Im Teilen-Dialog zum Ansichtslink und auf jedem PDF/PNG-Export (rechts unten); eigener Encoder (Byte-Modus, Fehlerkorrektur M, Versionen 1–10) |
| Teilen | **Ansichtslink** `/d/<id>` (Empfänger können eine eigene Kopie weiterbearbeiten), **Präsentationslink** `/d/<id>?present=1` (nur Karte, Legende und Routenvergleich, ohne Werkzeuge, für Sitzungen und Beamer), **Bearbeitungslink** `/d/<id>#edit=<token>` für gemeinsames Bearbeiten, E-Mail-Versand, JSON-Import/-Export, GeoJSON-Export |
| Gemeinsam bearbeiten | Speichern schickt den zuletzt geladenen Serverstand mit; hat inzwischen jemand anderes gespeichert, antwortet der Server mit 409 und die App fragt: eigene Fassung speichern oder Serverstand übernehmen (die eigene bleibt per Rückgängig erreichbar). Offene Seiten erhalten Änderungen und neue Kommentare live über Server-Sent Events: ohne eigene Änderungen wird der neue Stand direkt übernommen, sonst erscheint ein Hinweis |
| Sprachen | Oberfläche, Hinweise, Dialoge, Rückgängig-Beschriftungen und der PDF-Bericht auf Deutsch, Französisch und Italienisch. Die Sprache wird beim ersten Start aus dem Browser abgeleitet und im Zeichnen-Tab unter „Karte“ umgestellt (`web/js/i18n.js`, Wörterbücher in `web/js/lang/`; der deutsche Text ist der Schlüssel, ein Test prüft die vollständige Abdeckung) |
| Touch / Mobil | Aktionsleiste „Strasse fertig / Letzter Punkt / Abbrechen“ über der Karte während des Zeichnens; langes Drücken wirkt wie Rechtsklick (Strasse beenden, Punkt löschen); auf schmalen Bildschirmen wird die Seitenleiste zum Bottom-Sheet, das eingeklappt startet und per Tipp auf einen Tab aufgeht |

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
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Kachel-Vorlage der Standardquelle `osm`, z. B. eigener Tile-Server |
| `TILE_SOURCES` | leer | JSON-Liste weiterer oder ersetzender Kartenquellen: `[{"id":"…","label":"…","url":"…{z}/{x}/{y}… oder …{bbox}…","attribution":"…","maxZoom":19,"minZoom":0,"overlay":false}]`. `{bbox}` wird zur EPSG:3857-Box der Kachel (für WMS) |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Geocoder |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Strassengeometrie |
| `PROFILE_URL` | `https://api3.geo.admin.ch/rest/services/profile.json` | Höhenprofil-Dienst (swisstopo, nur Schweiz); leer schaltet ab |
| `PARCEL_URL` | `https://api3.geo.admin.ch/rest/services/api/MapServer/identify` | Identify-Dienst für Parzellen der amtlichen Vermessung (geo.admin, nur Schweiz); leer schaltet ab |
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
| `POST` | `/api/drafts` | Entwurf anlegen: `{doc, label?}` → `{id, editToken, doc, updatedAt}` |
| `GET` | `/api/drafts/{id}` | Aktueller Stand: `{doc, updatedAt, versionCount, …}` |
| `PUT` | `/api/drafts/{id}` | Speichern: `{doc, label?, baseUpdatedAt?}` (legt eine Version an). Mit `baseUpdatedAt` (der `updatedAt` des geladenen Stands) antwortet der Server **409** samt aktuellem `doc`, wenn inzwischen jemand anderes gespeichert hat; ohne das Feld wird überschrieben. Header `X-Client-Id` (optional) wird an das Live-Ereignis gehängt |
| `GET` | `/api/drafts/{id}/events` | Server-Sent Events: `updated {updatedAt, clientId, versionCount}` und `comment {id, clientId}`; Keepalive alle 25 s |
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
| `POST` | `/api/parcels` | `{coords: [[lat, lng], …]}` → `{parcels: [{id, egrid, number, label, canton, polygons}]}` (geo.admin identify, Blöcke zu 25 Punkten, dedupliziert, 6 h Cache) |
| `GET` | `/api/buildings?bbox=s,w,n,e` | OSM-Gebäude (`building=*`) als Umringe, bbox ≤ 0.06° |
| `GET` | `/api/parking?bbox=s,w,n,e` | OSM-Parkplätze (`amenity=parking`) als Umringe mit `parking`, `capacity`, `name`, bbox ≤ 0.06° |
| `GET` | `/api/transit?bbox=s,w,n,e` | `{stops: [{id, name, at, lines}], routes: [{id, ref, name, from, to, operator, colour, stops}]}` – Bushaltestellen im Bereich und Buslinien (`route=bus`), die ihn berühren, bbox ≤ 0.06°, höchstens 80 Linien à 60 Halte |
| `POST` | `/api/profile` | `{coords: [[lat,lng],…]}` → `{points: [[dist,height],…]}` Höhenprofil |
| `GET` | `/tiles/{z}/{x}/{y}.png` | Kachel-Proxy mit Cache (Standardquelle) |
| `GET` | `/tiles/{source}/{z}/{x}/{y}.png` | Kachel einer benannten Quelle |
| `GET` | `/api/tiles/sources` | Verfügbare Kartenquellen (ohne Upstream-URLs) |
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
web/js/smooth.js         Glätten (Catmull-Rom), Vereinfachen (Douglas-Peucker), Kurvenradien
web/js/speedmodel.js     Erwartete Geschwindigkeit aus Kurve, Steigung und Umfeld; Streuung und Zeitband
web/js/export.js         PNG/PDF-Export (Bildkomposition, handgeschriebener PDF-Writer)
web/js/i18n.js           Übersetzung: t(), Spracherkennung, statische Texte (data-i18n)
web/js/lang/{fr,it}.js   Wörterbücher (deutscher Text als Schlüssel)
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
      "status": "new", "oneway": false, "maxspeed": 50, "width": null, "osmId": null,
      "section": { "lanes": 2, "laneWidth": 3.25, "median": 0, "shoulder": 0,
                   "bikeLeft": false, "bikeRight": true, "bikeWidth": 1.5,
                   "walkLeft": true, "walkRight": true, "walkWidth": 2,
                   "parkLeft": false, "parkRight": false, "parkWidth": 2 },
      "nodes": [[47.05, 8.30], [47.051, 8.302], [47.052, 8.305]],
      "segments": [{ "level": "ground", "maxspeed": null }, { "level": "tunnel", "maxspeed": 30 }] },
    { "id": "j_…", "type": "junction", "layerId": "l_…", "kind": "signals", "at": [47.05, 8.30],
      "turns": { "left": false, "right": true, "straight": true, "uturn": false } },
    { "id": "j_h1", "type": "junction", "layerId": "l_…", "kind": "busstop", "at": [47.051, 8.302],
      "name": "Dorf", "lines": ["12", "45"], "osmId": 123456 },
    { "id": "k_…", "type": "roundabout", "layerId": "l_…", "center": [47.052, 8.305], "radius": 14 },
    { "id": "z_…", "type": "zone", "layerId": "l_…", "kind": "tempo30",
      "nodes": [[47.049, 8.299], [47.049, 8.303], [47.052, 8.303], [47.052, 8.299]],
      "busAllowed": false }
  ],
  "route": { "from": [47.049, 8.298], "to": [47.053, 8.306] },
  "busLines": [{ "id": "b_…", "name": "12", "color": "#e53935", "stops": ["j_h1", "j_…"], "dwell": 20, "osmId": 7890 }],
  "phases": [{ "id": "e_…", "name": "Etappe 1", "year": 2027 }]
}
```

`segments` hat immer einen Eintrag weniger als `nodes`. `maxspeed` ist
optional (null = Standard je Strassentyp), ebenso `width` (Meter) und
`section` (Querschnitt; wenn gesetzt, ergibt sich die Breite daraus).
`kind` einer Strasse ist `motorway`, `trunk`, `main`, `secondary`,
`residential`, `service`, `path` oder `other`; `kind` einer Kreuzung
`plain`, `signals`, `priority`, `stop`, `interchange`, `crossing` oder
`busstop`. `turns` einer Kreuzung ist optional (null = links, rechts und
geradeaus erlaubt, wenden nicht); `lines` einer Bushaltestelle sind bis zu
zehn Liniennummern. `access` einer Strasse und `access` eines Abschnitts
sind optional (`all` oder `bus`; Abschnitt vor Strasse, Standard alle).
`busAllowed` einer Fläche erlaubt Bussen die Durchfahrt mit 20 km/h.
`osmId` verweist auf den übernommenen OSM-Way, `route` ist die gespeicherte
Anfrage des Routen-Rechners. `busLines` sind bis zu 20 Linien mit je bis zu
60 Haltestellen (IDs von Bushaltestellen) und Haltezeit in Sekunden. `osmId`
einer Bushaltestelle ist der OSM-Knoten, `osmId` einer Linie die OSM-Relation,
aus der sie übernommen wurde (optional; verhindert Doppelte beim Übernehmen).
`phases` sind bis zu zehn Etappen (Name, Jahr optional); jedes Element kann mit
`phase` auf eine Etappe verweisen (fehlend = gehört zu jedem Zustand).

### Routen-Rechner: Annahmen

- Befahrbar sind OSM-Ways mit `highway` in motorway…service und
  living_street; Fusswege, Velowege, Feldwege und `access=no/private` nicht.
- Geschwindigkeit: OSM `maxspeed`, sonst Standard je `highway` (z. B.
  residential 50, service 30, living_street 20). Für gezeichnete Strassen das
  gesetzte Tempolimit, sonst Standard je Typ (Hauptstrasse 50, Quartierstrasse
  30, Zufahrt 20; Fuss-/Veloweg nicht befahrbar).
- Einbahnen werden beachtet (OSM `oneway`, Zeichenrichtung im Entwurf).
- Zonen mit Tempolimit deckeln jeden Abschnitt, dessen Mittelpunkt in der
  Fläche liegt; Fussgängerzonen sperren ihn (für Busse mit Freigabe 20 km/h).
- Busschleusen (Zugang „Nur Bus“) fehlen im Auto-Netz; im Bus-Netz gelten sie
  mit höchstens 30 km/h. Buslinien addieren je Zwischenhalt die Haltezeit.
- Zuversicht: jede Kante merkt sich, ob ihr Tempo aus einem Tag bzw. gesetzten
  Limit stammt oder geschätzt ist, ob sie zum Entwurf gehört und ob die
  Steigung bekannt ist. Der Pfad summiert diese Anteile; über 20 % geschätztes
  Tempo ergibt „mittel“, über 50 % „tief“. Ampeln und Vortritt im heutigen
  Netz werden nicht modelliert und stehen als fester Hinweis dabei.
- Geschwindigkeitsmodell (optional): erwartete Geschwindigkeit je Abschnitt
  = min(Limit, Kurvengeschwindigkeit √(a·R) mit a = 3 m/s², Limit ×
  Steigungsfaktor). Streuung der freien Fahrgeschwindigkeit je Tempo-Niveau
  (Variationskoeffizient 0,22 bis 0,10), Wartezeiten Ampel 20 ± 15 s, Stop
  8 ± 5 s, Vortritt 3 ± 3 s, Fussgängerstreifen 2 ± 2 s, Kreisel 5 ± 4 s.
  Varianzen werden als unabhängig summiert; das Band ist P15–P85. Das
  Modell liefert Vergleichbarkeit, keine kalibrierte Prognose.
- Das Netz wird in Zellen von 0.025° (etwa 2,8 km × 1,9 km) geladen, für den
  Bereich um Start und Ziel plus Rand, höchstens 100 Zellen pro Anfrage. Der
  Server begrenzt weiterhin jede einzelne Abfrage auf 0.06°. Ohne Abbiege- und
  Verkehrsmodell sind die Zeiten Richtwerte für den Vergleich, keine Prognose.

## Entwicklung und Tests

```sh
make test            # go vet + go test + Frontend-Unit-Tests (node --test)
make test-browser    # Browser-Tests (basics … edit, theme); braucht Go und Playwright mit Chromium
make run             # Server lokal
make docker          # Image bauen
```

Die CI (`.github/workflows/ci.yml`) führt gofmt, vet, Go-Tests, die
Frontend-Unit-Tests und einen Docker-Build mit Smoke-Test aus.

## Grenzen

- Die swisstopo-Dienste (WMTS `wmts.geo.admin.ch`, WMS `wms.geo.admin.ch`)
  sind frei nutzbar, ihre Ebenennamen stammen aus der Dokumentation von
  api3.geo.admin.ch und sollten beim Ausrollen einmal geprüft werden; sie
  decken nur die Schweiz ab.

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
