# Kennzeichen-Finder

Findet das **kürzeste noch freie Wunschkennzeichen** einer Zulassungsstelle —
live im echten Behördenportal, nicht aus einer veralteten Liste.

## Warum ein lokales Tool und keine Website

Die Portale (`stadt-muenster.de/wkz`, `kreis-coesfeld.de/wkz`, …) sind
server-gerenderte Java-Wizards mit Session-State und ohne CORS-Header. Browser-Code
von einer fremden Domain kommt dort nicht durch. Deshalb steuert dieses Tool einen
echten Browser fern — die Oberfläche läuft lokal davor.

## Der Trick

Die Suchmaske akzeptiert `?` als Platzhalter für genau ein Zeichen. Statt zehntausende
Kombinationen einzeln durchzuprobieren, fragt das Tool **acht Muster** ab:

| Buchstaben | Ziffern | Beispiel   |
|-----------:|--------:|------------|
| 1 | 1 | `MS-A 1`    |
| 1 | 2 | `MS-A 12`   |
| 2 | 1 | `MS-AB 1`   |
| 1 | 3 | `MS-A 123`  |
| 2 | 2 | `MS-AB 12`  |
| 1 | 4 | `MS-A 1234` |
| 2 | 3 | `MS-AB 123` |
| 2 | 4 | `MS-AB 1234`|

Ein kompletter Scan sind also acht Anfragen in 30–90 Sekunden.

## Motorrad ≠ PKW

Das Portal führt einen eigenen Motorrad-Zweig mit **anderen Formatregeln**:

> 1 Buchstabe mit 2 oder 3 Ziffern · 2 Buchstaben mit 1 oder 2 Ziffern

Motorradschilder sind zweizeilig und kleiner, deshalb ist bei **6 Zeichen Schluss**.
`MS-A 1234` existiert dort nicht, und `MS-A 1` weist das Portal als ungültig ab.
Wer im PKW-Zweig sucht, bekommt für ein Motorrad also Kombinationen angeboten,
die es gar nicht geben kann. Deshalb `--krad` benutzen bzw. in der Oberfläche
die Fahrzeugart umstellen — dann sind es nur vier Muster in rund 15 Sekunden.

## Installation

```bash
cd ~/kennzeichen-finder
npm install
```

Playwright benutzt das installierte Google Chrome. Falls keines vorhanden ist:

```bash
npx playwright install chromium
```

## Benutzung

**Oberfläche:**

```bash
npm start
```

Dann `http://localhost:4173` öffnen.

**Kommandozeile:**

```bash
node cli.js ms          # Stadt Münster, PKW
node cli.js ms --krad   # Stadt Münster, Motorrad
node cli.js coe LH      # Kreis Coesfeld, Kürzel LH
node cli.js --url "https://…/wkz/?LICENSEIDENTIFIER=xx" --id XX
```

## Andere Zulassungsstellen

Das gleiche Portalsystem läuft bei vielen Kreisen unter `/wkz/`. Die Start-URL in der
Oberfläche unter „Andere Zulassungsstelle eintragen" hinterlegen — oder dauerhaft in
`lib/districts.js` ergänzen.

## Die Auswertung

Nach dem Scan bewertet das Tool selbst:

- **Kürzeste erreichbare Länge** und über welche Muster sie geht
- **Seltenheit** (extrem knapp … reichlich)
- **Empfehlungen** mit Begründung. Kürze schlägt alles; bei gleicher Länge zählt,
  wie ruhig sich die Kombination liest: ein einzelner Buchstabe ist seltener als zwei,
  `I/O/Q/X/Y` wirken unruhig, gleiche oder auf-/absteigende Ziffern lesen sich besser.

Die Logik steht in `lib/score.js` und lässt sich an eigenen Geschmack anpassen.

## Beobachten statt nachsehen

`watch.js` scannt, vergleicht mit dem letzten Stand und meldet nur, was **neu frei
geworden** ist — als macOS-Mitteilung plus Eintrag in `data/watch.log.ndjson`.

```bash
node watch.js          # prüfen und vergleichen
node watch.js --init   # Ausgangszustand neu setzen, ohne zu melden
```

Vier Ziele sind eingerichtet — Auto und Motorrad, jeweils für Münster und
Lüdinghausen. Sie stehen in `data/watch.config.json`:

```json
{
  "label": "Auto Lüdinghausen",
  "district": "coe",
  "identifier": "LH",
  "vehicle": "pkw",
  "maxLength": 5,
  "onlyPatterns": []
}
```

`maxLength` ist die Gesamtlänge inklusive Bezirkskürzel — bei `5` meldet sich das
Tool für `LH-AB 1`, nicht für `LH-AB 12`. Mit `onlyPatterns` lässt sich zusätzlich
auf einzelne Muster einschränken, z. B. `["1 Buchstabe + 2 Ziffern"]`.

Für Lüdinghausen ist bewusst nur **LH** eingetragen, nicht COE: mit zwei statt drei
Buchstaben ist LH immer kürzer, COE könnte das Ergebnis also nie verbessern.

### Zwei Feinheiten, die Fehlalarme und Last vermeiden

**Gedeckelte Muster werden übersprungen.** Meldet das Portal „100+", zeigt es nur
die ersten 100 alphabetisch. Verschiebt sich der Bestand dahinter, wandern Schilder
durch dieses Fenster, ohne dass sich real etwas ändert — das gäbe Fehlalarme. Und
wo über 100 frei sind, ist eine Meldung ohnehin überflüssig. Bei LH bleiben so
genau die beiden seltenen Einbuchstaben-Kennzeichen in Beobachtung.

**Nur passende Muster werden abgefragt.** Bei `maxLength: 5` fragt der Wächter gar
nicht erst nach vier Ziffern. Das verkürzt einen Durchlauf über alle vier Ziele auf
rund 40 Sekunden und umgeht nebenbei das Muster, an dem das Portal-Fachverfahren
regelmäßig abbricht.

### Mitteilung aufs Handy

Läuft über [ntfy.sh](https://ntfy.sh) — kostenlos, ohne Konto.

1. App installieren (App Store / Play Store: **ntfy**)
2. Dort ein Topic abonnieren: `kennzeichen-3ax2icb2yn4q7r2r`
3. Testen: `node watch.js --test-push`

Das Topic steht in `data/watch.config.json` und ist zufällig erzeugt. ntfy-Topics
sind öffentlich — wer den Namen kennt, liest mit. Deshalb der lange Zufallsname.
Inhalt sind ohnehin nur freie Kennzeichen, nichts Persönliches. Zum Wechseln
einfach den Wert in der Konfiguration ändern und im Handy neu abonnieren.

Auto und Motorrad teilen sich denselben Kennzeichen-Pool. Taucht ein Schild bei
mehreren Zielen auf, kommt trotzdem nur **eine** Meldung. Bei vier Zeichen
(`MS-A 1`, in Münster der Sonderfall) geht die Meldung mit Priorität `urgent` raus.

### In der Cloud laufen lassen (GitHub Actions)

Unabhängig davon, ob dein Mac läuft. `.github/workflows/watch.yml` prüft dreimal
täglich und schickt bei Änderung den Push.

1. Repo auf GitHub anlegen und pushen:
   ```bash
   git remote add origin git@github.com:DEINNAME/kennzeichen-finder.git
   git push -u origin main
   ```
2. Im Repo unter **Settings → Secrets and variables → Actions → New repository
   secret** anlegen:
   - Name: `NTFY_TOPIC`
   - Wert: das Topic aus `data/watch.local.json`
3. Unter **Actions** den Workflow einmal über **Run workflow** starten und
   zusehen, ob er durchläuft.

Das Topic liegt bewusst nur im Secret und in der lokal ignorierten Datei
`data/watch.local.json` — die eingecheckte Konfiguration enthält es nicht.
Das Repo darf also öffentlich sein.

**Der Stand wird ins Repo zurückgeschrieben.** Runner sind flüchtig, ohne das
gäbe es bei jedem Lauf einen leeren Ausgangszustand und damit keine Erkennung.
Nebeneffekt: Die Git-Historie wird zum Protokoll darüber, wann welches
Kennzeichen frei wurde. Weil jeder Lauf einen Zeitstempel schreibt, entstehen
etwa drei Commits pro Tag — das hält zugleich den Zeitplan aktiv, denn GitHub
schaltet geplante Workflows nach 60 Tagen ohne Aktivität im Repo ab.

Zwei Eigenheiten von GitHub Actions: Die Cron-Zeiten sind **UTC** (im Workflow
also 06/11/17 Uhr für 08/13/19 Uhr Sommerzeit), und geplante Läufe starten unter
Last gelegentlich mit einigen Minuten Verspätung. Für diesen Zweck ohne Belang.

### Lokal automatisch laufen lassen (launchd)

```bash
cp ~/kennzeichen-finder/de.kennzeichen-finder.watch.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/de.kennzeichen-finder.watch.plist
```

Läuft dann täglich um 08:00, 13:00 und 19:00 Uhr. Prüfen mit `launchctl list | grep kennzeichen`,
abschalten mit `launchctl unload ~/Library/LaunchAgents/de.kennzeichen-finder.watch.plist`.
War der Mac zur Uhrzeit aus, holt launchd den Lauf beim nächsten Start nach.
Ausgabe landet in `data/watch.out.log`.

## Feedback

Das Formular am Seitenende speichert nach `data/feedback.json` — mit Bewertung,
Kommentar und dem Kontext des Scans. Auslesen über `GET /api/feedback`.

## Grenzen

- Das Portal zeigt **maximal 100 Treffer pro Muster**. Steht dort „100+", gibt es mehr.
- `2 Buchstaben + 4 Ziffern` bricht bei manchen Kreisen serverseitig ab
  („Keine oder fehlerhafte Antwort des Fachverfahrens") — 6,76 Mio. Kombinationen sind
  dem Fachverfahren zu viel. Für die Frage nach dem *kürzesten* Kennzeichen ist das ohne Belang.
- Nicht jedes Muster ist überall erlaubt: bei 3-buchstabigen Kürzeln wie `COE` lehnt das
  Portal `1 Buchstabe + 1 Ziffer` ab.
- **Reserviert wird hier nichts.** Das Tool liest nur die öffentliche Verfügbarkeitsauskunft.
  Die Reservierung mit Namen und Daten machst du im Portal selbst.

## Rücksicht auf das Portal

Ein Scan gleichzeitig, 900 ms Pause zwischen den Anfragen, acht Anfragen pro Durchlauf.
Das ist weniger Last als ein Mensch, der das Formular von Hand durchklickt.

## Aufbau

```
lib/districts.js   Bezirke und die acht Suchmuster
lib/wkz.js         Playwright-Treiber für das Portal
lib/score.js       Bewertung und Auswertungstext
server.js          Lokaler Server, SSE-Fortschritt, Feedback-API
cli.js             Scan ohne Oberfläche
public/            Oberfläche
```
