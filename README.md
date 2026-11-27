# Athan – Gebetszeiten, Athan & Qibla

Ohne Werbung, ohne Konto, ohne Tracking. Eine Oberfläche für drei Wege:

| | Windows | iPhone / Android (Web-App) |
|---|---|---|
| Installation | `Athan-Setup-1.0.0.msi` doppelklicken | Web-App hosten → in Safari „Zum Home-Bildschirm“ |
| Gebetszeiten, Monatsplan, Qibla | ✓ | ✓ (Live-Kompass mit Handy-Sensor) |
| Athan zur Gebetszeit | ✓ auch bei geschlossenem Fenster (läuft im Infobereich) | ✓ solange die App geöffnet ist |
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

### B) Mit Push-Server – Hinweise auch bei geschlossener App (empfohlen fürs iPhone)

Der Server (`server/`, nur Node.js, keine Pakete) liefert die Web-App aus und schickt zu jeder Gebetszeit eine Push-Benachrichtigung – verschlüsselt nach Web-Push-Standard (VAPID, RFC 8291).

Mit Docker auf einem kleinen Server (VPS, Raspberry Pi o. ä.) mit eigener Domain:

```bash
cd deploy
ATHAN_DOMAIN=athan.deine-domain.de ATHAN_EMAIL=du@example.org docker compose up -d
```

Caddy besorgt das HTTPS-Zertifikat automatisch. Ohne Docker: `node server/server.mjs` hinter einem HTTPS-Proxy (Beispiel für systemd: `deploy/athan.service`).

| Einstellung | Bedeutung |
|---|---|
| `PORT` | Port (Standard 8080) |
| `DATA_DIR` | Speicherort für Schlüssel, Abos, Aufnahmen (Standard `./data`) |
| `VAPID_SUBJECT` | `mailto:deine@adresse` – Apple verlangt eine gültige Kontaktangabe |
| `TLS_CERT`, `TLS_KEY` | optional: HTTPS direkt im Server |

### Auf dem iPhone einrichten

1. Adresse in **Safari** öffnen.
2. **Teilen** → **Zum Home-Bildschirm** → Hinzufügen.
3. Athan **vom Home-Bildschirm** öffnen, Ort wählen, **Athan aktivieren** tippen und Benachrichtigungen erlauben.

**Was iOS erlaubt – und was nicht:** Bei geschlossener App kommt die Benachrichtigung zur Gebetszeit mit dem iPhone-Standardton. Ein eigener Athan-Ton im Hintergrund ist für Web-Apps auf dem iPhone technisch gesperrt. Tippst du auf die Benachrichtigung, öffnet sich Athan direkt mit dem Athan-Bildschirm; ein Tipp spielt den Athan ab. Ist die App geöffnet, erklingt der Athan automatisch.

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
python3 tests/msicheck.py dist/Athan-Setup-1.0.0.msi dist/Athan.exe   # MSI zurücklesen
```

## Aufbau

```
web/        Web-App (PWA) – auch die Oberfläche der Windows-App
  js/praytimes.js   Gebetszeiten, Qibla, Zeitzonen
  js/app.js         Oberfläche, Planer, Kompass
  sw.js             Offline + Push
server/     Push-Server (Node, ohne Abhängigkeiten)
windows/    Windows-App (Go): Tray, Athan, Benachrichtigungen, Autostart
tools/      mksyso (Icon/Version für die EXE), mkmsi (MSI-Erzeuger)
installer/  WiX-Quelle (Alternative)
deploy/     Docker, Caddy, systemd
```
