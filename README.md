# Athan – Gebetszeiten, Athan & Qibla

Ohne Werbung, ohne Konto, ohne Tracking. Eine Oberfläche für drei Wege:

| | Windows | iPhone / Android (Web-App) |
|---|---|---|
| Installation | `Athan-Setup-1.0.0.msi` doppelklicken | Web-App hosten → in Safari „Zum Home-Bildschirm“ |
| Gebetszeiten, Monatsplan, Qibla | ✓ | ✓ (Live-Kompass mit Handy-Sensor) |
| Athan zur Gebetszeit | ✓ auch bei geschlossenem Fenster (läuft im Infobereich) | ✓ bei geöffneter App; iPhone gesperrt: die ersten Verse über **Bark** |
| Athan-Länge | ganz oder die ersten Verse | ganz oder die ersten Verse |
| Widget | – | ✓ iPhone (Home- und Sperrbildschirm) über **Scriptable** |
| Benachrichtigung | ✓ Windows-Benachrichtigung | ✓ bei geschlossener App **mit Push-Server** (siehe unten) |
| Autostart | ✓ (abschaltbar) | – |

## Muezzins

Ali Ahmed Mulla (Mekka), Haram-Athan (Mekka), Prophetenmoschee (Medina), Abdul Basit Abdus-Samad, Mahmoud Khalil Al-Husary, Muhammad Rifaat, Muhammad Siddiq Al-Minshawi (Ägypten), Athan aus Syrien, Naji Qazzaz (Al-Aqsa), Mishary Rashid Alafasy (Kuwait), Nasser Al-Qatami, Ezan aus der Türkei, Kamal Al-Maroosh (Marokko) – dazu eigene **Fajr-Athans** (Mekka, Medina, Kairo, Jerusalem, Kuwait), ein **sanfter Gong** (ohne Download) und **eigene Aufnahmen** (MP3/M4A).

Die Aufnahmen kommen von islamweb.net (Ministerium für Awqaf, Katar), das sie frei zum Download anbietet. Sie werden beim ersten Abspielen geladen und danach lokal gespeichert. Ist die Quelle einmal nicht erreichbar, erklingt der Gong – kein Gebet wird verpasst. Die Liste steht in `web/muezzins.json` und lässt sich erweitern.

---

## Windows

1. `Athan-Setup-1.0.0.msi` herunterladen und doppelklicken.
2. Windows zeigt bei neuen, nicht signierten Programmen „Der Computer wurde durch Windows geschützt“ → **Weitere Informationen → Trotzdem ausführen**.
3. Athan installiert sich **ohne Admin-Rechte** nach `%LOCALAPPDATA%\Programs\Athan`, legt Startmenü- und Desktop-Verknüpfung an, startet mit Windows und öffnet sich direkt.
4. Ort wählen – fertig. Das Fenster darf geschlossen werden: Athan bleibt im Infobereich (Symbol unten rechts), spielt den Athan und zeigt Benachrichtigungen. Rechtsklick aufs Symbol: Öffnen, Athan stoppen, Autostart, Beenden.

Deinstallieren: Einstellungen → Apps → Athan. Ohne Installation geht es auch: `Athan.exe` einfach starten.

> Vor einem Update Athan über das Symbol im Infobereich beenden, dann die neue MSI ausführen – die alte Version wird automatisch ersetzt.

## iPhone & Android (Web-App)

iPhone-Apps außerhalb des App Stores gehen nur über eine Web-App. Die braucht eine **HTTPS-Adresse**. Zwei Wege:

### A) Schnell und kostenlos – ohne Push

Den Ordner `web/` auf einen kostenlosen Static-Host legen:

- **Netlify Drop**: <https://app.netlify.com/drop> öffnen und den Ordner `web` hineinziehen → du bekommst sofort eine `https://…netlify.app`-Adresse.
- **GitHub Pages**: Projekt auf GitHub hochladen, unter Settings → Pages „GitHub Actions“ wählen. Der mitgelieferte Workflow `.github/workflows/pages.yml` veröffentlicht `web/` automatisch.

Gebetszeiten, Qibla, Monatsplan und Athan funktionieren – Athan und Hinweise aber nur, **solange die App geöffnet ist**.

### B) Kostenlos mit Mitteilungen bei geschlossener App: Cloudflare (empfohlen)

Cloudflare Workers ist kostenlos und prüft **jede Minute**, ob ein Gebet fällig ist – auch wenn das Handy gesperrt ist. Keine Datenbank, kein eigener Server. (Vercel kann das im Gratis-Tarif nicht: dort laufen zeitgesteuerte Aufgaben nur einmal am Tag.)

1. Kostenloses Konto auf **dash.cloudflare.com** anlegen.
2. Links **Workers & Pages** öffnen (legt deine Adresse `…workers.dev` an).
3. Die **Account ID** kopieren (steht auf der Workers-Seite rechts).
4. **Profil → API Tokens → Create Token → Vorlage „Edit Cloudflare Workers“** → Token kopieren.
5. Im GitHub-Repo unter **Settings → Secrets and variables → Actions** zwei Secrets anlegen: `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID`.
6. **Actions → „Athan auf Cloudflare“ → Run workflow.** In der Zusammenfassung steht danach deine Adresse.

Ab dann veröffentlicht jeder Push auf `main` automatisch neu.

### C) Eigener Server (Alternative)

Der Node-Server (`server/`, keine Pakete) kann dasselbe auf einem VPS oder Raspberry Pi: `cd deploy && ATHAN_DOMAIN=athan.deine-domain.de ATHAN_EMAIL=du@example.org docker compose up -d`.

### Auf dem iPhone einrichten

1. Adresse in **Safari** öffnen.
2. **Teilen** → **Zum Home-Bildschirm** → Hinzufügen.
3. Athan **vom Home-Bildschirm** öffnen, Ort wählen, **Athan aktivieren** tippen und Benachrichtigungen erlauben.

**Was iOS erlaubt – und was nicht:** Web-Apps dürfen auf dem iPhone keinen eigenen Mitteilungston spielen; ohne Hilfe kommt die Mitteilung mit dem Standardton. Ist die App geöffnet, erklingt der Athan automatisch.

### Athan-Ton bei gesperrtem iPhone (Bark)

Die kostenlose, quelloffene App [Bark](https://apps.apple.com/app/id1403753865) (ohne Werbung, sammelt keine Daten) spielt eigene Mitteilungstöne. iOS erlaubt dafür höchstens 30 Sekunden – darum klingen dort **die ersten Verse** (bis zur Atempause vor 30 s, je Stimme ermittelt mit `scripts/athan-sounds.mjs`).

1. Bark laden, öffnen, Mitteilungen erlauben.
2. In Bark den Link mit deinem Schlüssel kopieren (`https://api.day.app/…`).
3. In Athan: Einstellungen → iPhone → einfügen → Speichern. Es kommt sofort ein Test mit Athan-Ton.

Optional „Auch wenn das iPhone lautlos ist“ (kritischer Hinweis, Bark fragt einmal nach der Erlaubnis). Klappt Bark einmal nicht, kommt die normale Mitteilung.

### Widget (Scriptable)

Alle Zeiten auf Home- und Sperrbildschirm – Fajr, Shuruq, Dhuhr, Asr, Maghrib, Isha, Qiyam (Beginn des letzten Nachtdrittels) – mit Countdown, Hidschri-Datum, Mondphase und dem Himmel der App. Rechnet auf dem iPhone ohne Internet.

1. [Scriptable](https://apps.apple.com/app/id1405459188) laden (kostenlos, ohne Werbung).
2. Athan: Einstellungen → iPhone → **Widget-Code kopieren**.
3. Scriptable → `+` → einfügen → oben „Athan“ nennen → Fertig.
4. Home-Bildschirm gedrückt halten → Bearbeiten → Widget hinzufügen → Scriptable → Größe wählen → Widget antippen → Script „Athan“.

Der Code entsteht mit `node scripts/build-widget.mjs` aus derselben Engine wie die App (`web/widget/athan-widget.js`).

Android (Chrome): genauso, „Zum Startbildschirm hinzufügen“ bzw. „App installieren“.

---

## Berechnung

Astronomische Berechnung (Verfahren von PrayTimes.org), geprüft gegen veröffentlichte Tabellen – z. B. Mekka/Umm al-Qura am 9.11. und 1.12.2026 minutengenau wie Halaltrip. Methoden: Muslimische Weltliga, ISNA, Ägypten, Umm al-Qura (Ramadan +30 Min. Isha), Karachi, Diyanet, Dubai, Kuwait, Katar, Golf, Singapur, JAKIM, UOIF, Russland, Teheran, Ithna Ashari, eigene Winkel. Asr Standard oder Hanafi. Die Methode wird nach Land vorgeschlagen.

**Deutschland im Sommer:** Ab etwa 48° Nord wird es im Juni nachts nicht mehr dunkel genug für 18°. Die Regel „Hohe Breiten“ (Standard: winkelbasiert) ergibt dann sinnvolle Fajr- und Isha-Zeiten. Unter Einstellungen → Berechnung lassen sich alle Zeiten minutengenau an deine Moschee anpassen.

## Sicherheit & Datenschutz

- Keine Werbung, keine Analyse, keine Konten, keine Drittanbieter-Skripte. Strenge Content-Security-Policy.
- Einstellungen bleiben auf dem Gerät. Der Push-Server kennt nur den Ort, den du ihm schickst – und er gehört dir.
- Windows-App: lauscht nur auf `127.0.0.1`, jede Anfrage braucht ein zufälliges Sitzungs-Token, fremde Host-Namen werden abgewiesen (Schutz vor DNS-Rebinding). Keine Admin-Rechte.
- Ortssuche über Open-Meteo, Standortname über OpenStreetMap – nur, wenn du suchst.

## Selbst bauen

Voraussetzung: Go ≥ 1.22 (für die Tests zusätzlich Node.js ≥ 18).

```bash
VERSION=1.0.0 ./build.sh      # → dist/Athan.exe, dist/Athan-Setup-1.0.0.msi
```

Die MSI entsteht ohne WiX mit `tools/mkmsi` (eigener MSI-Erzeuger in Go). Wer lieber das offizielle WiX-Toolset nutzt: `installer/athan.wxs`. Der Workflow `.github/workflows/build.yml` baut bei jedem Push auf `main` die MSI auf Windows, **installiert und deinstalliert sie testweise** und stellt sie als Release bereit.

Tests:

```bash
node tests/engine.test.mjs         # Gebetszeiten an Referenzorten
cd windows && go test ./...        # Go-Engine = JS-Engine (7.140 Fälle)
node tests/webpush.test.mjs        # Verschlüsselung = RFC-8291-Testvektor
node tests/e2e-push.mjs            # Server → Push-Dienst → Entschlüsselung
node tests/worker.test.mjs         # Cloudflare Worker: Planer, Sicherheit, Audio, Bark
node tests/widget.test.mjs         # iPhone-Widget mit nachgebauter Scriptable-API
node tests/widget-preview.mjs w.html   # Widget-Vorschau zum Ansehen
python3 tests/msicheck.py dist/Athan-Setup-1.0.0.msi dist/Athan.exe   # MSI zurücklesen
```

## Aufbau

```
web/        Web-App (PWA) – auch die Oberfläche der Windows-App
  js/praytimes.js   Gebetszeiten, Qibla, Zeitzonen
  js/app.js         Oberfläche, Planer, Kompass
  sw.js             Offline + Push
server/     Push-Server (Node, ohne Abhängigkeiten) + gemeinsamer Kern
cloudflare/ Cloudflare Worker (Web-App + Push jede Minute)
windows/    Windows-App (Go): Tray, Athan, Benachrichtigungen, Autostart
tools/      mksyso (Icon/Version für die EXE), mkmsi (MSI-Erzeuger)
installer/  WiX-Quelle (Alternative)
deploy/     Docker, Caddy, systemd
```
