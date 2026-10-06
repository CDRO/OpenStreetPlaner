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
| Routen-Rechner | Start A und Ziel B klicken, danach lassen sich A, B und **Zwischenpunkte** auf der Karte ziehen („Zwischenpunkt“ im Routen-Tab oder Rechtsklick auf einen Marker fügt Wegpunkte ein, bis acht je Route; jede Etappe wird als schnellste Verbindung gerechnet). Schnellste Fahrroute im heutigen OSM-Netz vs. im Netz mit dem Entwurf (neue Strassen dazu, Rückbau weg, übernommene Strassen mit ihren Änderungen, nur sichtbare Ebenen), Distanz und Fahrzeit aus Tempolimits, gezeichnete Kreuzungen kosten Zeit (Ampel 20 s, Stop 8 s, Vortritt 3 s), Kreisel verbinden ihre Anschlüsse. **Abbiegen**: an Knoten mit drei und mehr Armen kostet rechts 2 s, links 5 s, wenden 15 s (Rechtsverkehr, aus dem Richtungswechsel berechnet); Abbiegeverbote an gezeichneten Kreuzungen sperren die Richtung, Anschlüsse und Kreisel sind kostenfrei. Die Suche läuft über (Knoten, Vorgänger)-Zustände, damit Verbote korrekt wirken |
| Velo und zu Fuss | Verkehrsmittel je Hauptroute und je Paar: Auto, Bus, Velo, zu Fuss. Velo 17 km/h auf Strassen, Velowege 18, Pfade 12, Fusswege nur mit `bicycle=yes`, keine Autobahnen und Treppen; zu Fuss 4.8 km/h (Treppen 2.5), Einbahnen und Abbiegeverbote gelten nicht, Wartezeit nur an Ampeln. Zusätzliche Kennzahl „unsicher“: Anteil der Strecke auf Strassen ab 50 km/h ohne Velostreifen/Radweg (OSM `cycleway*`, Querschnitt) bzw. ohne Trottoir (OSM `sidewalk`, Querschnitt) – das Schulweg-Argument heute gegen neu |
| Weitere Routen | Routen-Tab: weitere benannte Routen (Schule, Bahnhof, Nachbardorf) mit eigenem Start, Ziel und Zwischenpunkten, je heute/neu mit Differenz, Summe und Mittel der Zeitgewinne; nummerierte Marker auf der Karte lassen sich ziehen, Tabelle im Bericht und im Präsentationsmodus. Alle Routen rechnen auf denselben beiden Netzen |
| Erreichbarkeit | Routen-Tab: Isochronen-Netz ab einem Ursprung für 5/10/15 min (weitere Vorgaben), als „heute“, „neu“ oder Differenz (grün: nur mit Entwurf erreichbar, rot: nur heute). Kennzahl: erreichbare Netz-Kilometer je Band; Suche bricht bei der höchsten Schwelle ab, Kanten werden anteilig gezeichnet. Das OSM-Netz um den Ursprung wird automatisch geladen (Radius aus Minuten × 50 km/h × 0.7) |
| Buslinien | Routen-Tab: Linien mit Nummer, Farbe und Haltezeit je Zwischenhalt (Standard 20 s). „Haltestellen setzen“ und auf die Karte klicken: Klick auf eine bestehende Bushaltestelle hängt sie an, Klick anderswo setzt eine neue (eingerastet) und trägt die Liniennummer ein. Haltestellen lassen sich im Auswahl-Werkzeug am Griff verschieben, in der Linie nach vorne schieben oder entfernen; Liniennummern stehen am Punkt und ab Zoom 15 auf der Karte. Fahrzeit und Distanz heute/neu über alle Halte inkl. Haltezeit, Differenz; Linienverlauf gestrichelt in der Linienfarbe, Tabelle im Bericht und im Präsentationsmodus |
| Fahrplan-Abgleich | Je Buslinie „Fahrplan abgleichen“: holt über den Server die Fahrzeit direkter Busfahrten zwischen erster und letzter Haltestelle aus dem offenen Fahrplan (transport.opendata.ch, nächste Haltestellen zu den Koordinaten, optional nach Liniennummer gefiltert), speichert Median und Zahl der Fahrten in der Linie und zeigt die Abweichung des Modells heute. „Haltezeit kalibrieren“ setzt die Haltezeit je Zwischenhalt so, dass das Modell heute die Fahrplanzeit trifft. Die Zuversicht der Linie bekommt damit eine Messgrundlage: bis 15 % Abweichung hoch, über 30 % tief. `TIMETABLE_URL` leer schaltet ab |
| Bestehender ÖV aus OSM | Routen-Tab, „Bestehende Linien aus OSM“: „Für Ansicht laden“ holt Bushaltestellen (`highway=bus_stop`, `public_transport=platform/stop_position` mit `bus=yes`) und Buslinien (Relationen `route=bus` mit Haltestellenfolge, Nummer, Name, Betreiber, Farbe) für den Kartenausschnitt (ab Zoom 13; beim Setzen von Haltestellen ab Zoom 14 automatisch). Haltestellen erscheinen blau mit „H“ und Namen; beim Setzen von Haltestellen hängt ein Klick darauf sie an die Linie (einmalig als eigene Haltestelle mit OSM-Kennung angelegt). „Übernehmen“ legt eine Linie mit allen Haltestellen in Reihenfolge an, bereits übernommene Haltestellen werden wiederverwendet; danach lässt sich die Linie wie jede andere bearbeiten, und Fahrzeit heute/neu zeigt sofort, was der Entwurf für sie bedeutet |
| Busausnahmen | Zugang je Strasse oder Abschnitt: „Alle Fahrzeuge“ oder „Nur Bus (Busschleuse)“ – für Autos gesperrt, Busse höchstens 30 km/h, gelb gestrichelt mit „BUS“ ab Zoom 16. Fussgängerzonen und andere gesperrte/langsame Flächen können „Busse dürfen durchfahren (20 km/h)“ erhalten. Buslinien rechnen auf dem Bus-Netz (zusätzlich OSM `highway=busway`, `bus=yes`, `psv=yes`), Routen-Rechner, Routenpaare und Erreichbarkeit auf dem Auto-Netz |
| Messen | Werkzeug „Messen“ (Taste M): Klicks setzen Messpunkte, Länge je Abschnitt und Summe stehen auf der Karte, ab drei Punkten auch die Fläche des geschlossenen Rings; Doppelklick oder Enter beendet, Esc löscht. Auch in der Ansicht ohne Bearbeitungsrecht |
| Mehrfachauswahl | Shift+Klick ergänzt oder entfernt Elemente, mit Shift gezogener Rahmen wählt alle Elemente darin, Ctrl+A alles auf sichtbaren Ebenen; Schalter „Mehrfachauswahl“ für Touch. Ziehen auf einem ausgewählten Element verschiebt die ganze Auswahl formtreu; Eigenschaften zeigen die Zusammenfassung mit Ebene, Status (Strassen), Hinzoomen und Löschen (auch Entf) |
| Kontextmenü | Rechtsklick oder Langdruck auf ein Element: Hinzoomen, Eigenschaften, Ebene, Status, Führung des Abschnitts (ebenerdig/Brücke/Tunnel), Zugang, Löschen – für die ganze Auswahl, wenn mehrere gewählt sind. Rechtsklick auf einen Griff löscht wie bisher den Punkt |
| Elementliste | Box „Elemente“ im Zeichnen-Tab: alle Elemente mit Typ, Ebene, Länge oder Status, Filter nach Name, Typ oder Ebene; Klick wählt aus und zoomt hin, Shift+Klick ergänzt die Auswahl |
| Touch | Mit dem Finger sind Griffe und Trefferflächen grösser (16 statt 9 Pixel), Langdruck öffnet das Kontextmenü, die Seitenleiste ist ein Bottom-Sheet |
| Abfahren (Fahrt-Animation) | Routen-Tab und Präsentationsmodus, Knopf „Abfahren“: Auto, Bus, Velo und Fussgänger fahren die Hauptroute gleichzeitig ab – heute (blauer Rand) gegen neu (grüner Rand) – im Zeitraffer 1×/10×/30×/100× (Vorgabe so, dass das Rennen etwa eine Minute dauert). Die Positionen folgen der Zeitachse des Routen-Rechners (Fahrzeit je Pfadpunkt aus Tempolimits, Wartezeiten an Kreuzungen, Abbiegezeiten), nicht dem realen Verkehr; Spur der letzten 90 s, Fahrzeuge als Kreis mit Symbol, Rang bei Ankunft. Zeitleiste zum Springen, Pause, Modus „nur heute / nur neu / beide“, Zuversicht-Punkt der Route daneben; bei Änderungen am Entwurf „Neu berechnen“. Buslinien haben einen eigenen Knopf „Abfahren“: der Bus heute gegen neu mit Pausen an den Zwischenhalten (Haltezeit). Rechnet im Web Worker |
| Gruppen | Mehrere Elemente gruppieren (Mehrfachauswahl → „Gruppieren“ oder Rechtsklick): wer ein Mitglied anklickt, wählt die ganze Gruppe – Ziehen verschiebt alle zusammen, Entf löscht alle, die Eigenschaften zeigen weiterhin das angeklickte Element mit Hinweis und „Gruppe auflösen“. Shift+Klick und Rahmen nehmen Gruppen als Ganzes auf; Gruppen mit nur einem Mitglied lösen sich auf. In der Elementliste mit ⧉ markiert, im GeoJSON als `group` |
| Fortschritt und Status | Länger laufende Arbeiten melden sich in der Statusleiste mit Balken: Laden von Strassennetz, Gebäuden, Haltestellen und Parkplätzen zellenweise (geladen/gesamt), Routen-Berechnung im Worker (ab 300 ms), Parzellen, Höhenprofil, Fahrplan-Abgleich, Variantenvergleich, Export (Kacheln vorladen) und die Vorbereitung der Fahrt-Animation; nach Abschluss steht einige Sekunden eine Meldung („Strassennetz geladen: 412 Strassen.“). Laufen mehrere Arbeiten, zählt die Leiste die übrigen; Fehler kommen weiterhin als Toast |
| Variantenvergleich | Analyse-Tab: „Varianten vergleichen“ rechnet jede Ebene allein sichtbar: Elemente, neue Länge, Kosten, Fahrzeit-Differenz der Hauptroute und Summe der Paare, Parzellen, Gebäude entlang neuer Strassen, Warnungen; Tabelle im Bericht |
| Parkplatzbilanz | Analyse-Tab: neu aus Parkstreifen im Querschnitt (6 m je Platz) und Parkflächen (25 m² je Platz), entfallen aus OSM-Parkstreifen (`parking:*`, `parking:lane:*`) an übernommenen Strassen ohne Parkstreifen im Querschnitt oder bei Rückbau und aus OSM-Parkplätzen (`amenity=parking`, `capacity` oder Fläche), die neue Strassen oder Flächen berühren; Positionen mit Sprung zum Element, Zeile im Bericht |
| Etappierung | Ebenen-Tab: bis zehn Etappen mit Name und Jahr; Etappe je Element in den Eigenschaften, in der Mehrfachauswahl oder per Rechtsklick. Ansicht „bis Etappe“ zeigt den Zustand nach dieser Etappe: spätere Elemente grau gestrichelt, Routen, Paare, Buslinien und Erreichbarkeit im Netz dieses Zustands. Analyse-Tab und Bericht: Elemente, Kosten und Fahrzeit kumuliert je Etappe |
| Ohne Farbsehen | Heute/Neu und Differenzen unterscheiden sich auch durch Muster: Route neu und Paare neu gestrichelt, nicht mehr erreichbares Netz gestrichelt, Versionsvergleich mit durchgezogen/punktiert/gestrichelt, betroffene Gebäude schraffiert (diagonal, Punkte, Kreuz), Zuversicht-Punkte mit ✓ ! ✕ |
| Dunkelmodus | „Darstellung“ in der Karten-Box: wie das System, hell oder dunkel. Oberfläche über Farbtoken, Kacheln werden am Bildschirm invertiert gezeichnet (Export bleibt hell), native Eingabefelder folgen über `color-scheme` |
| DXF-Export | Export-Dialog „DXF (LV95)“: AutoCAD R12 (ASCII) in Schweizer Landeskoordinaten LV95 (swisstopo-Näherungsformeln, rund 1 m), eine DXF-Ebene je Entwurfsebene mit Farbe, Strassen und Flächen als POLYLINE (Rückbau gestrichelt), Punkte als POINT, Kreisel als CIRCLE, Beschriftungen mit Typ, Status, Breite und Liniennummern – für die Übergabe an Ingenieurbüros |
| Offline-Schale und Updates | Der Service Worker cached die App-Dateien (Liste und Version aus `GET /api/shell`, ein Hash über den Inhalt, der sich mit jedem Build ändert). Ohne Netz startet die App aus dem Cache mit der lokalen Arbeitskopie; Kacheln, Suche, OSM-Daten und Speichern brauchen weiterhin das Netz. Nach einem Release muss niemand den Browser-Cache leeren: Startseite und App-Dateien werden mit `Cache-Control: no-cache` und einem ETag aus der Schalen-Version ausgeliefert (unverändert = 304), der Worker lädt beim Installieren am HTTP-Cache vorbei, übernimmt sofort und die offene Seite lädt neu – ohne ungesicherte Änderungen von selbst, sonst mit Hinweis und Knopf. Lange offene Tabs prüfen alle 30 Minuten und beim Zurückkehren auf eine neue Version |
| Zuversicht | Jedes Ergebnis trägt eine von drei Stufen (hoch, mittel, tief) mit aufklappbaren Gründen: Fahrzeiten nach dem Anteil der Strecke mit geschätztem Tempo (OSM ohne `maxspeed`, Entwurf ohne Tempolimit), unvollständig geladenem Netz, Tempolimit- statt Geometriemodell und fehlendem Höhenprofil; Buslinien zusätzlich mit Standard-Haltezeit; OSM-Linien nach Haltepositionen, Plattformen oder fehlenden Rollen; Kosten mit Band ±25 % (eigene Ansätze) bzw. ±40 % (Standardwerte), unbekannte Breiten und pauschale Brücken/Tunnel; Parzellen hoch (amtliche Vermessung), Gebäude und Normen-Check mittel. Keine Statistik, sondern Transparenz über Annahmen. Im PDF-Bericht als Zeile je Ergebnis, im Export-Dialog abschaltbar |
| Geschwindigkeitsmodell | Schalter im Routen-Tab: Fahrzeit aus der Strassenführung statt nur aus dem Limit. Kurvenradien aus der Geometrie (v = √(3 m/s² · R)), Steigung aus dem Höhenprofil, Wartezeiten an Kreuzungen und Kreiseln mit Streuung. Ergebnis als typische Zeit mit Band P15–P85 |
| Glätten / Vereinfachen | Strassen per Catmull-Rom-Spline glätten (Abschnittseigenschaften bleiben) oder per Douglas-Peucker auf 1 m vereinfachen |
| Höhenprofil | Pro Strasse vom swisstopo-Profildienst laden (Koordinaten werden nach LV95 umgerechnet, der Dienst nimmt nur Landeskoordinaten): Gelände, Steigungen, Brücken über und Tunnel unter dem Gelände als Diagramm; fliesst ins Geschwindigkeitsmodell ein. Antworten der Dienste mit Fehlercode stehen samt Erklärung in der Meldung und im Server-Log |
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
| OSM übernehmen / entfernen | Werkzeug „OSM übernehmen“ (Taste O): die OSM-Strassen der Ansicht werden eingeblendet, die Strasse unter dem Zeiger leuchtet orange und steht in der Statusleiste. Klick holt sie als bearbeitbare Kopie in die aktive Ebene (Name, Typ, Brücke/Tunnel, Einbahn, Tempolimit; die Kopie merkt sich den OSM-Way, damit der Routen-Rechner ihn ersetzt) und wählt sie aus. Option „Übernehmen als Rückbau“ oder Shift+Klick entfernt die Strasse aus dem Netz (rot gestrichelt, der Routen-Rechner fährt nicht mehr darüber). Bereits übernommene Strassen werden ausgewählt statt verdoppelt. Im Auswahl-Werkzeug bietet Rechtsklick auf eine OSM-Strasse dasselbe an |
| Zusammenführen | Mehrfachauswahl (Shift+Klick, Rahmen) → „Flächen vereinigen“: sich berührende oder überlappende Flächen werden zu einer (Polygon-Vereinigung ohne Bibliothek, Löcher entfallen; Eigenschaften der ersten bleiben). „Strassen verbinden“: Strassen, deren Enden bis 10 m zusammenliegen, werden Ende an Ende zu einer Strasse (Richtung wird angepasst, Lücke wird Abschnitt, Abschnittseigenschaften bleiben, Einbahn nur wenn beide gleich gerichtet). Beides auch per Rechtsklick, rückgängig mit Ctrl+Z |
| Bearbeiten | Punkte ziehen, Zwischenpunkte einfügen, Punkte per Rechtsklick löschen, Eigenschaften in der Seitenleiste (das Werkzeugraster bleibt beim Scrollen oben), Tooltip beim Überfahren. Tempolimit als runde Schilder: das gestrichelte Standard-Schild zeigt den Wert je Strassentyp, das gewählte ist blau umrandet, ein Zahlenfeld nimmt eigene Werte (5–200, z. B. 10, 40, 60, 70) |
| Oberfläche (v3) | Eigenes SVG-Symbolset (`web/js/icons.js`) für Werkzeuge, Kopfzeile, Reiter und Kontextmenü; Reiter als Symbolleiste, der aktive zeigt sein Label. Einstellungen (Kartenquelle, Overlays, Einrasten, Sprache, Darstellung) und Hilfe (Legende, Tastenkürzel, Einführung) als Panels über der Karte (Zahnrad, Fragezeichen, Taste `?`). Kartenleiste rechts oben: Grundkarte, OSM-Netz laden, Standort, Legende, Vollbild. Erklärtexte in Route, Kommentare und Analyse hinter Info-Knöpfen; Entwürfe-Reiter mit Export-Menü. Einstieg beim ersten Besuch mit drei Schritten |
| Speichern | Entwürfe liegen auf dem Server; der Browser merkt sich die eigenen (mit Bearbeitungs-Token). Arbeitskopie wird lokal automatisch gesichert |
| Historie | Rückgängig/Wiederholen in der Sitzung; jedes Speichern legt eine Version an (Standard: 30), die wiederhergestellt werden kann. **Versionen vergleichen**: zwei Stände (oder Version gegen aktuellen Stand) als Liste hinzugefügter, entfernter und geänderter Elemente mit Beschreibung (Tempolimit 50 → 30, Geometrie 2 → 3 Punkte, Führung der Abschnitte …) und als Karten-Overlay (grün neu, orange geändert, rot gestrichelt entfernt) |
| Lebenszyklus | Entwürfe, die `RETENTION_DAYS` (Standard 365) Tage lang nicht gespeichert wurden, löscht der Server automatisch (Lauf nach dem Start und dann alle 6 Stunden); jedes Speichern verlängert die Frist. Im Reiter „Entwürfe“ steht das Löschdatum; Besitzer können eine E-Mail-Adresse hinterlegen und werden einen Monat und eine Woche vor dem Löschen an die Sicherung erinnert (nur mit `SMTP_HOST`; die Adresse ist nur mit dem Bearbeitungs-Token lesbar und wird bei Kopien und Sicherungen nicht mitgenommen) |
| Sicherung | „Sicherung herunterladen“ liefert eine Datei `<name>.stadtplaner-backup.json` vom Server mit aktuellem Stand, allen Versionen und Kommentaren (ohne Token); „Importieren“ spielt sie als neuen Entwurf mit eigenem Token ein, Versionen behalten Nummer, Datum und Beschriftung. Damit sichern Benutzer ihre Entwürfe selbst, unabhängig vom Server |
| Import | Stadtplaner-JSON ersetzt den Entwurf; eine Sicherung wird als neuer Entwurf eingespielt; GeoJSON, GPX und KML kommen als neue Ebene dazu (Linien → Strassen mit Status „bestehend“, Punkte → Kreuzungen/Punkte, Polygone → Flächen; `highway`, `maxspeed`, `oneway`, `kind`, `status` aus GeoJSON-Eigenschaften werden übernommen). Ohne DOM-Parser, bis 2000 Elemente |
| QR-Code | Im Teilen-Dialog zum Ansichtslink und auf jedem PDF/PNG-Export (rechts unten); eigener Encoder (Byte-Modus, Fehlerkorrektur M, Versionen 1–10) |
| Teilen | **Ansichtslink** `/d/<id>` (Empfänger können eine eigene Kopie weiterbearbeiten), **Präsentationslink** `/d/<id>?present=1` (nur Karte, Legende und Routenvergleich, ohne Werkzeuge, für Sitzungen und Beamer), **Bearbeitungslink** `/d/<id>#edit=<token>` für gemeinsames Bearbeiten, E-Mail-Versand, JSON-Import/-Export, GeoJSON-Export |
| Gemeinsam bearbeiten | Speichern schickt den zuletzt geladenen Serverstand mit; hat inzwischen jemand anderes gespeichert, antwortet der Server mit 409 und die App fragt: eigene Fassung speichern oder Serverstand übernehmen (die eigene bleibt per Rückgängig erreichbar). Offene Seiten erhalten Änderungen und neue Kommentare live über Server-Sent Events: ohne eigene Änderungen wird der neue Stand direkt übernommen, sonst erscheint ein Hinweis |
| Sprachen | Oberfläche, Hinweise, Dialoge, Rückgängig-Beschriftungen und der PDF-Bericht auf Deutsch, Französisch und Italienisch. Die Sprache wird beim ersten Start aus dem Browser abgeleitet und in den Einstellungen umgestellt (`web/js/i18n.js`, Wörterbücher in `web/js/lang/`; der deutsche Text ist der Schlüssel, ein Test prüft die vollständige Abdeckung) |
| Touch / Mobil | Aktionsleiste „Strasse fertig / Letzter Punkt / Abbrechen“ über der Karte während des Zeichnens; langes Drücken wirkt wie Rechtsklick (Strasse beenden, Punkt löschen). Auf schmalen Bildschirmen wird die Seitenleiste zum Bottom-Sheet mit Griff (eingeklappt, halb, voll; Tipp oder Ziehen), Rückgängig/Wiederholen/Einstellungen/Hilfe liegen in einem Menü, auf dem Handy öffnet die Lupe eine Suchzeile und Speichern/Teilen zeigen nur ihr Symbol |

### Tastenkürzel

`V` Auswählen · `S` Strasse · `K` Kreuzung/Punkt · `R` Kreisel · `F` Fläche · `O` OSM übernehmen · `T` Route · `M` Messen · `C` Kommentar ·
`Enter` Strasse beenden · `Esc` abbrechen / Panel schliessen · `⌫` letzter Punkt · `Entf` löschen ·
`Ctrl+Z` / `Ctrl+Y` rückgängig / wiederholen · `Ctrl+S` speichern · `?` Hilfe ·
Karte: Pfeiltasten, `+` / `−`. Die vollständige Tabelle steht im Hilfe-Panel.

## Konfiguration

Umgebungsvariablen (oder gleichnamige Flags, siehe `go run . -h`):

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADDR` | `:8080` | Adresse, auf der der Server lauscht; ohne `ADDR` zählt `PORT` (PaaS wie Deploio setzen nur den Port) |
| `DATA_DIR` | `/data` (Docker) bzw. `./data` | Entwürfe (`drafts/`), VAPID-Schlüssel und Kachel-Cache (`tiles/`); mit `S3_BUCKET` nur noch der Kachel-Cache |
| `S3_BUCKET` | leer | Gesetzt: Entwürfe, Versionen, Kommentare, Push-Abonnements und VAPID-Schlüssel liegen in diesem S3-kompatiblen Bucket statt in `DATA_DIR` (z. B. Deploio/Nine Object Storage) |
| `S3_ENDPOINT` | leer | Endpunkt des Buckets, z. B. `https://cz41.objects.nineapis.ch` (Pfad-Stil) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | leer | Zugangsdaten des Bucket-Users; ersatzweise `AWS_ACCESS_KEY_ID` und `AWS_SECRET_ACCESS_KEY` |
| `S3_REGION` | `us-east-1` | Region für die Signatur (bei Nine immer `us-east-1`); ersatzweise `AWS_REGION` |
| `S3_PREFIX` | leer | Optionaler Schlüssel-Präfix im Bucket, z. B. `stadtplaner/`, wenn der Bucket geteilt wird |
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Kachel-Vorlage der Standardquelle `osm`, z. B. eigener Tile-Server |
| `TILE_SOURCES` | leer | JSON-Liste weiterer oder ersetzender Kartenquellen: `[{"id":"…","label":"…","url":"…{z}/{x}/{y}… oder …{bbox}…","attribution":"…","maxZoom":19,"minZoom":0,"overlay":false}]`. `{bbox}` wird zur EPSG:3857-Box der Kachel (für WMS) |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Geocoder |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Strassengeometrie |
| `PROFILE_URL` | `https://api3.geo.admin.ch/rest/services/profile.json` | Höhenprofil-Dienst (swisstopo, nur Schweiz); leer schaltet ab |
| `PARCEL_URL` | `https://api3.geo.admin.ch/rest/services/api/MapServer/identify` | Identify-Dienst für Parzellen der amtlichen Vermessung (geo.admin, nur Schweiz); leer schaltet ab |
| `TIMETABLE_URL` | `https://transport.opendata.ch/v1` | Offene Fahrplan-API für den Fahrplan-Abgleich der Buslinien; leer schaltet ab |
| `USER_AGENT` | `Stadtplaner/1.0 (+…)` | User-Agent gegenüber den OSM-Diensten – bitte auf die eigene Installation anpassen |
| `MAX_VERSIONS` | `30` | Versionen pro Entwurf |
| `RETENTION_DAYS` | `365` | Entwürfe, die so viele Tage nicht gespeichert wurden, werden gelöscht; `0` schaltet das Löschen (und die Erinnerungen) ab |
| `REMINDER_DAYS` | `30,7` | So viele Tage vor dem Löschen geht je eine Erinnerung an die hinterlegte Adresse (je Stand einmal) |
| `PUBLIC_URL` | leer | Öffentliche Adresse der App für die Links in Erinnerungen, z. B. `https://plan.example.ch` |
| `SMTP_HOST` | leer | SMTP-Server für Erinnerungen; leer = keine E-Mails. Der Server schreibt beim Start in die Startseite (`<meta name="stadtplaner-config">`), ob E-Mails möglich sind; ohne SMTP bietet die Oberfläche die Erinnerung gar nicht an und die API nimmt keine Adresse an |
| `SMTP_PORT` | `587` | `587`/`25` mit STARTTLS, `465` mit TLS |
| `SMTP_USER`, `SMTP_PASSWORD` | leer | Anmeldung (PLAIN); ohne Benutzer wird nicht angemeldet |
| `SMTP_FROM` | `SMTP_USER` | Absenderadresse |
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
| `GET` | `/api/drafts/{id}` | Aktueller Stand: `{doc, updatedAt, versionCount, expiresAt, retentionDays, …}` |
| `PUT` | `/api/drafts/{id}` | Speichern: `{doc, label?, baseUpdatedAt?}` (legt eine Version an). Mit `baseUpdatedAt` (der `updatedAt` des geladenen Stands) antwortet der Server **409** samt aktuellem `doc`, wenn inzwischen jemand anderes gespeichert hat; ohne das Feld wird überschrieben. Header `X-Client-Id` (optional) wird an das Live-Ereignis gehängt |
| `GET` | `/api/drafts/{id}/events` | Server-Sent Events: `updated {updatedAt, clientId, versionCount}` und `comment {id, clientId}`; Keepalive alle 25 s |
| `DELETE` | `/api/drafts/{id}` | Entwurf löschen |
| `POST` | `/api/drafts/{id}/auth` | Token prüfen (204/403) |
| `POST` | `/api/drafts/{id}/fork` | Kopie mit eigenem Token: `{name?}` |
| `GET` | `/api/drafts/{id}/reminder` | `{email, expiresAt, retentionDays, mailEnabled}`; Header `X-Edit-Token` |
| `PUT` | `/api/drafts/{id}/reminder` | `{email}` hinterlegen (leer = entfernen); Header `X-Edit-Token` |
| `GET` | `/api/drafts/{id}/backup` | Sicherungsdatei zum Herunterladen: `{format: "stadtplaner-backup", doc, versions: [{info, doc}], comments}` |
| `POST` | `/api/drafts/import` | Sicherungsdatei als neuen Entwurf einspielen → `{id, editToken, doc, updatedAt, versionCount}` (Body bis 32 MB) |
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
| `GET` | `/api/shell` | `{version, files}` der App-Schale für den Service Worker (Offline-Start) |
| `GET` | `/api/timetable?from=lat,lng&to=lat,lng&line=12` | Fahrplan-Abgleich: `{from, to, line, trips, median, min, max, journeys}` (Sekunden) für direkte Busfahrten zwischen den nächsten Haltestellen, 10 min Cache |
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
internal/blob/           Ablage: Ordner oder S3-Bucket (Signatur V4), blobtest/ = S3-Testserver
internal/store/          Entwurfs-Store auf der Ablage: drafts/<id>/{meta,current,versions/*,comments,push}.json
internal/osm/            Nominatim, Overpass, Kachel-Proxy (Drosselung, Caches)
internal/push/           Web-Push: aes128gcm-Verschlüsselung, VAPID-JWT, Versand, Schlüsselpaar in der Ablage
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
web/js/ui.js             Seitenleiste, Panels, Dialoge, Statuszeile
web/js/icons.js          SVG-Symbolset (Inline, currentColor)
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
  "route": { "from": [47.049, 8.298], "to": [47.053, 8.306], "via": [[47.051, 8.300]], "vehicle": "car" },
  "routePairs": [{ "id": "p_…", "name": "Schule", "from": [47.05, 8.30], "to": [47.06, 8.31], "via": [], "vehicle": "bike" }],
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
`phase` auf eine Etappe verweisen (fehlend = gehört zu jedem Zustand). `group`
(optional, ID) fasst Elemente zu einer Gruppe zusammen, die zusammen ausgewählt und
verschoben wird; Gruppen mit nur einem Mitglied werden beim Normalisieren entfernt.

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
- Anschluss ans Netz: Punkte neuer Strassen, die auf einer OSM-Strasse liegen (Einrasten), teilen
  sie dort. Lose Enden neuer Strassen bis 10 m neben einer Strasse (OSM oder Entwurf) bekommen einen
  kurzen Verbinder zum Lotpunkt; weiter entfernte Enden bleiben Sackgassen (Normen-Check meldet sie).
  Gezeichnete Kreisel verbinden alle Strassen, die ihren Ring berühren oder hindurchführen, auch
  OSM-Strassen, auf die sie gesetzt wurden.
- **Tunnel und Brücken** (Abschnitte im Entwurf, OSM-Ways mit `tunnel=*`/`bridge=*`) sind nur an
  ihren Enden und an den Portalen (Wechsel zu ebenerdig) mit dem übrigen Netz verbunden. Zwischenpunkte,
  die über oder unter einer anderen Strasse liegen, bekommen eigene Netzknoten; lose Enden, Kreisel und
  Start/Ziel hängen sich nicht an Tunnel- oder Brückensegmente, sondern an die Oberfläche.
- Das OSM-Netz wird automatisch um Start, Ziel und Zwischenpunkte (Korridor) **und um jede gezeichnete
  Strasse und jeden Kreisel** (250 m Puffer) nachgeladen, damit neue Trassen ohne Handgriff in die
  Rechnung eingehen; „Netz für Ansicht laden“ bleibt für grössere Ausschnitte.
- Zwischenpunkte: jede Etappe (Start → Zwischenpunkt → … → Ziel) ist für sich die schnellste
  Verbindung; Pfad, Distanz, Zeit und Zeitachse werden aneinandergehängt (`legs`).
- Jede Route trägt eine Zeitachse (`times`, Sekunden ab Start je Pfadpunkt) aus den
  Kosten der Suche; die Fahrt-Animation interpoliert darauf linear. Bei Buslinien steht
  jeder Zwischenhalt doppelt im Pfad (Ankunft, Abfahrt nach der Haltezeit), damit der
  Bus dort anhält.
- Routen, Paare, Erreichbarkeit und Buslinien werden in einem Web Worker
  gerechnet (Modul-Worker `routing.worker.js`), damit die Oberfläche bei
  grossen Netzen flüssig bleibt; veraltete Ergebnisse werden verworfen. Ohne
  Worker-Unterstützung rechnet der Hauptfaden.
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

## Deployment auf Deploio

Die App läuft als Docker-App auf [Deploio](https://deploio.ch) (PaaS von Nine). Im Repo liegen
die [Deploio-Skills für Claude Code](https://github.com/ninech/deploio-skills) unter `.claude/`
(Skills `deploio-deploy`, `deploio-manage`, `deploio-debug`, `deploio-provision`, `deploio-ci-cd`,
Agent `deploio-cli`, Befehle `/deploy` und `/debug`, Schutz-Hook gegen `nctl delete` und
`--replicas 0`). Der SessionStart-Hook `.claude/hooks/session-start.sh` lädt in Claude Code im
Web die CLI `nctl` nach (GitHub-Release, sonst apt-Repository von nine.ch).

Was Deploio braucht:

| Punkt | Wert |
|---|---|
| Build | `Dockerfile` im Repo (`--dockerfile`), Port 8080 (`EXPOSE`); ohne `ADDR` lauscht der Server auf `PORT` |
| Health-Probe | `GET /healthz` |
| Umgebungsvariablen | `TRUST_PROXY=1` (hinter dem Deploio-Ingress), `USER_AGENT=Stadtplaner/… (+<deine URL>)`, `VAPID_SUBJECT=mailto:…`; Ablage im Bucket über `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (siehe unten) |
| Grösse | `micro` reicht (Go, eingebettete Oberfläche); `mini`, wenn der Kachel-Cache wachsen soll |
| Zugangsdaten für `nctl` ohne Browser | API-Service-Account: `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, `NCTL_ORGANIZATION`, dann `nctl auth login` |
| Netzfreigaben (Claude Code im Web) | `github.com`/`objects.githubusercontent.com` (nctl-Download), `nineapis.ch`, `auth.nine.ch`, `git-info.deplo.io` |

### Version aus der Commit-Nachricht: taggen und ausrollen

Ein Commit auf `main`, dessen Betreff mit `Release vX.Y.Z` beginnt, löst `.github/workflows/release.yml`
aus: Go- und Frontend-Tests laufen, der Workflow setzt den annotierten Tag `vX.Y.Z` auf diesen
Commit, veröffentlicht eine GitHub-Release (Notizen aus dem Commit-Text plus automatische
Änderungsliste) und ruft danach den Deploy direkt auf, sofern die NCTL-Secrets gesetzt sind.
Ein bestehender Tag lässt den Lauf scheitern. So reicht ein leerer Commit, auch aus einer
Cloud-Sitzung, deren Git-Proxy nur Branches, aber keine Tags pushen darf:

```bash
git commit --allow-empty -m "Release v2.4.0" -m "Was neu ist …"
git push
```

Hinweis: Tags und Releases, die eine Action mit dem Standard-Token anlegt, lösen keine weiteren
Workflows aus; darum ruft `release.yml` den Deploy als wiederverwendbaren Workflow auf, statt auf
das Release-Ereignis zu warten.

### Automatisch ausrollen bei jeder Release

Der Workflow `.github/workflows/deploy.yml` übergibt bei jeder **veröffentlichten GitHub-Release**
(Tag auf `main`, z. B. `v2.2.0`) den Tag als Revision an die Deploio-App; Deploio baut das
Dockerfile und rollt aus. Über „Run workflow“ lässt sich jede Revision (Tag, Branch, Commit)
von Hand ausrollen. Beim ersten Lauf legt der Workflow die App an (Docker, Port 8080,
Health-Probe `/healthz`, `micro`, `TRUST_PROXY=1`, `USER_AGENT`, optional `VAPID_SUBJECT`).

Einmalige Einrichtung:

1. Lokal `nctl` installieren und anmelden: `nctl auth login`, dann `nctl auth whoami` (Organisation merken).
2. Projekt anlegen und wählen: `nctl create project <org>-openstreetplaner` und
   `nctl auth set-project <org>-openstreetplaner`.
3. Service-Account für den Workflow anlegen (projektgebunden):
   `nctl create apiserviceaccount github-actions-deploy`, danach
   `nctl get apiserviceaccount github-actions-deploy --print-client-id` und `--print-client-secret`.
4. Im GitHub-Repo unter *Settings → Secrets and variables → Actions* eintragen:
   Secrets `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, `NCTL_ORGANIZATION`;
   Variablen `DEPLOIO_PROJECT` (sonst `<org>-openstreetplaner`), `DEPLOIO_APP` (sonst `main`),
   `VAPID_SUBJECT` (z. B. `mailto:…`).
5. Release veröffentlichen (*Releases → Draft a new release*, Tag auf `main`) oder den
   Workflow manuell starten. Die URL steht am Ende des Workflow-Logs (`nctl get app main`).

Soll jeder Push auf `main` ausrollen, genügt im Workflow zusätzlich `push: branches: [main]`
unter `on:`; die Revision ist dann `main`, und Deploio baut den jeweils aktuellen Stand.
Wer den Entwurf einer Release zuerst testen will, nutzt den manuellen Start mit dem Tag.

### Dauerhafte Ablage im Deploio-Bucket

Deploio-Apps haben nur flüchtigen Speicher (2 GiB je App): `DATA_DIR` geht bei jedem Release
und Neustart verloren. Darum legt der Server Entwürfe, Versionen, Kommentare,
Push-Abonnements und das VAPID-Schlüsselpaar in einen S3-kompatiblen Bucket, sobald
`S3_BUCKET` gesetzt ist (`internal/blob`, Signatur V4 ohne SDK). Im Bucket liegen dieselben
Schlüssel wie im Ordner (`drafts/<id>/meta.json`, `current.json`, `versions/<n>.json`,
`comments.json`, `push.json`, `vapid.json`), ein Umzug zwischen Ordner und Bucket ist also ein
Kopieren. Nur der Kachel-Cache bleibt auf der flüchtigen Platte.

Einen bestehenden Bucket anbinden (Bucket und Bucket-User existieren, der User hat
`readwrite`-Rechte auf den Bucket):

```bash
nctl get bucket <bucket> -o yaml            # Endpunkt (status.atProvider.endpoint)
nctl get bucketuser <bucket-user> -o yaml   # Access Key und Secret Key
nctl update app main \
  --env="S3_BUCKET=<bucket>;S3_ENDPOINT=https://cz41.objects.nineapis.ch;S3_PREFIX=stadtplaner" \
  --sensitive-env="S3_ACCESS_KEY=<access-key>;S3_SECRET_KEY=<secret-key>"
```

Neu anlegen geht mit `nctl create bucket <name> --location=nine-cz41`,
`nctl create bucketuser <name>-user --location=nine-cz42` und
`nctl update bucket <name> --permissions=<name>-user:readwrite`. Der Deploy-Workflow setzt die
Variablen beim Anlegen der App, wenn im GitHub-Repo die Variablen `S3_BUCKET`, `S3_ENDPOINT`
(optional `S3_PREFIX`) und die Secrets `S3_ACCESS_KEY`, `S3_SECRET_KEY` eingetragen sind, und
gleicht sie bei jedem Lauf ab. Beim Start prüft der Server den Zugriff auf den Bucket und bricht
mit klarer Meldung ab, wenn Endpunkt oder Schlüssel nicht stimmen.

### Erinnerungen per E-Mail

Alte Entwürfe löscht der Server nach `RETENTION_DAYS` (365) Tagen ohne Speichern. Damit Besitzer
vorher eine Erinnerung zur Sicherung bekommen, braucht die App einen SMTP-Zugang: im GitHub-Repo die
Variablen `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_FROM` und `PUBLIC_URL` (öffentliche Adresse der App,
für den Link in der Mail) sowie die Secrets `SMTP_USER`, `SMTP_PASSWORD` eintragen; der
Deploy-Workflow reicht sie als `--env`/`--sensitive-env` an die App weiter (optional auch
`RETENTION_DAYS`). Von Hand:

```sh
nctl update app main --skip-repo-access-check \
  --env="SMTP_HOST=smtp.example.ch;SMTP_PORT=587;SMTP_FROM=stadtplaner@example.ch;PUBLIC_URL=https://plan.example.ch" \
  --sensitive-env="SMTP_USER=<user>;SMTP_PASSWORD=<passwort>"
```

Ohne `SMTP_HOST` wird trotzdem gelöscht, nur ohne Erinnerung: die Oberfläche bietet dann weder Feld
noch Hinweis zur E-Mail an (der Server schreibt die Konfiguration beim Start in die Startseite, eine
Änderung wechselt die Schalen-Version und damit ETag und Service-Worker-Cache), der Löschtermin
steht aber im Reiter „Entwürfe“.

## Entwicklung und Tests

```sh
make test            # go vet + go test + Frontend-Unit-Tests (node --test)
make test-browser    # Browser-Tests (basics … offline, race, merge, lifecycle, ui); braucht Go und Playwright mit Chromium; läuft auch in der CI (Job „browser“)
make run             # Server lokal
make docker          # Image bauen
```

Die CI (`.github/workflows/ci.yml`) führt gofmt, vet, Go-Tests, die
Frontend-Unit-Tests und einen Docker-Build mit Smoke-Test aus.

## Später und offene Entscheide

- **3D-Vorschau**: ein eigenes Fenster neben dem 2D-Editor mit Gelände aus dem
  swisstopo-Höhendienst, aus OSM extrudierten Gebäuden (3 m je Stockwerk),
  gezeichneten Strassen als Bänder in Querschnittsbreite, Brücken angehoben,
  Tunnel abgesenkt, Buslinien darüber; Kamera frei drehbar, Bild exportierbar.
  Offener Entscheid: Das Frontend ist bewusst ohne Abhängigkeiten. Eine
  3D-Bibliothek (z. B. three.js) wäre die erste; denkbar ist ein Fork des
  Projekts mit dieser Abhängigkeit, damit der Kern abhängigkeitsfrei bleibt.

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
