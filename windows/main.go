package main

// Athan für Windows: Tray-App mit lokalem Webserver (nur 127.0.0.1), Hintergrund-Planer,
// Athan-Wiedergabe und Windows-Benachrichtigungen. Nur Go-Standardbibliothek.

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

var version = "1.0.0"

//go:embed all:web
var webFS embed.FS

//go:embed athan.ico
var iconICO []byte

const fixedPort = 47863

type Location struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Tz   string  `json:"tz"`
}

type Settings struct {
	Location    *Location         `json:"location"`
	Calc        CalcSettings      `json:"calc"`
	Voice       string            `json:"voice"`
	FajrVoice   string            `json:"fajrVoice"`
	Volume      float64           `json:"volume"`
	Modes       map[string]string `json:"modes"`
	Pre         int               `json:"pre"`
	Clock       string            `json:"clock"`
	OpenOnAthan bool              `json:"openOnAthan"`
	AthanLength string            `json:"athanLength"` // "short" = die ersten Verse
}

type Voice struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Place    string    `json:"place"`
	Fajr     string    `json:"fajr"`
	FajrOnly bool      `json:"fajrOnly"`
	Clip     []float64 `json:"clip"` // [Beginn der Stimme, Ende der ersten Verse] in Sekunden
	Src      []string  `json:"src"`
}

type Playing struct {
	Prayer string `json:"prayer"`
	Voice  string `json:"voice"`
	At     int64  `json:"at"`
	Client bool   `json:"client,omitempty"` // true = das Athan-Fenster spielt den Ton (Ersatzweg)
}

type App struct {
	mu        sync.Mutex
	raw       json.RawMessage
	s         Settings
	loc       *time.Location
	fired     map[string]time.Time
	playing   *Playing
	token     string
	port      int
	cfgDir    string
	cacheDir  string
	voices    map[string]Voice
	wake      chan struct{}
	downloads sync.Map // id → *sync.Mutex
	plat      Platform
}

// Platform kapselt alles Betriebssystem-Spezifische (siehe platform_windows.go).
type Platform interface {
	Run(app *App)
	Notify(title, body string, silent bool)
	Play(file string, volume float64, limit time.Duration, done func()) error
	Stop()
	SetTooltip(s string)
	OpenWindow(url string)
	Autostart() bool
	SetAutostart(on bool) error
}

var prayerNames = map[string][2]string{
	"fajr": {"Fajr", "الفجر"}, "sunrise": {"Shuruq", "الشروق"}, "dhuhr": {"Dhuhr", "الظهر"},
	"asr": {"Asr", "العصر"}, "maghrib": {"Maghrib", "المغرب"}, "isha": {"Isha", "العشاء"},
}

func main() {
	background := false
	for _, a := range os.Args[1:] {
		if a == "--background" || a == "/background" {
			background = true
		}
	}
	app := &App{fired: map[string]time.Time{}, wake: make(chan struct{}, 1), voices: map[string]Voice{}}
	base, _ := os.UserConfigDir()
	cache, _ := os.UserCacheDir()
	app.cfgDir = filepath.Join(base, "Athan")
	app.cacheDir = filepath.Join(cache, "Athan")
	os.MkdirAll(app.cfgDir, 0o700)
	os.MkdirAll(filepath.Join(app.cacheDir, "audio"), 0o700)
	if f, err := os.OpenFile(filepath.Join(app.cacheDir, "athan.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		if st, _ := f.Stat(); st != nil && st.Size() > 1<<20 {
			f.Truncate(0)
		}
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
	log.Printf("Athan %s startet", version)

	// Bereits laufende Instanz? Dann nur das Fenster öffnen.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", fixedPort))
	if err != nil {
		if showExisting() {
			return
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
	}
	app.port = ln.Addr().(*net.TCPAddr).Port
	app.token = randomHex(24)
	os.WriteFile(filepath.Join(app.cfgDir, "session"), []byte(fmt.Sprintf("%d %s", app.port, app.token)), 0o600)

	app.loadVoices()
	app.loadSettings()
	app.plat = newPlatform(app)

	// beim ersten Start Autostart einschalten
	marker := filepath.Join(app.cfgDir, "autostart-initialized")
	if _, err := os.Stat(marker); errors.Is(err, os.ErrNotExist) {
		if err := app.plat.SetAutostart(true); err == nil {
			os.WriteFile(marker, []byte("1"), 0o600)
		}
	}

	srv := &http.Server{Handler: app.routes(), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	go app.scheduler()
	go app.prefetch()
	if !background || app.s.Location == nil {
		go func() { time.Sleep(300 * time.Millisecond); app.plat.OpenWindow(app.url()) }()
	}
	app.plat.Run(app) // blockiert (Nachrichtenschleife)
}

func (a *App) url() string { return fmt.Sprintf("http://127.0.0.1:%d/", a.port) }

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func showExisting() bool {
	c := &http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", fixedPort))
	if err != nil {
		return false
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if string(b) != "athan" {
		return false
	}
	base, _ := os.UserConfigDir()
	sess, _ := os.ReadFile(filepath.Join(base, "Athan", "session"))
	var port int
	var tok string
	fmt.Sscanf(string(sess), "%d %s", &port, &tok)
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/show", fixedPort), nil)
	req.Header.Set("X-Athan-Token", tok)
	if r, err := c.Do(req); err == nil {
		r.Body.Close()
	}
	return true
}

// ---------------- Einstellungen ----------------

func (a *App) settingsFile() string { return filepath.Join(a.cfgDir, "settings.json") }

func (a *App) loadSettings() {
	b, err := os.ReadFile(a.settingsFile())
	if err != nil {
		return
	}
	if err := a.applySettings(b); err != nil {
		log.Printf("Einstellungen fehlerhaft: %v", err)
	}
}

func (a *App) applySettings(b []byte) error {
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	var loc *time.Location
	if s.Location != nil {
		if s.Location.Lat < -90 || s.Location.Lat > 90 || s.Location.Lon < -180 || s.Location.Lon > 180 {
			return errors.New("Koordinaten ungültig")
		}
		l, err := time.LoadLocation(s.Location.Tz)
		if err != nil {
			l = time.UTC
		}
		loc = l
	}
	if s.Volume <= 0 || s.Volume > 1 {
		s.Volume = 0.9
	}
	if s.Modes == nil {
		s.Modes = map[string]string{}
	}
	a.mu.Lock()
	a.raw, a.s, a.loc = json.RawMessage(b), s, loc
	a.mu.Unlock()
	select {
	case a.wake <- struct{}{}:
	default:
	}
	return nil
}

func (a *App) saveSettings(b []byte) error {
	if err := a.applySettings(b); err != nil {
		return err
	}
	tmp := a.settingsFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	go a.prefetch()
	return os.Rename(tmp, a.settingsFile())
}

func (a *App) loadVoices() {
	b, err := webFS.ReadFile("web/muezzins.json")
	if err != nil {
		return
	}
	var cat struct{ Voices []Voice }
	json.Unmarshal(b, &cat)
	for _, v := range cat.Voices {
		a.voices[v.ID] = v
	}
}

func (a *App) voiceFor(prayer string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	v := a.s.Voice
	if v == "" {
		v = "makkah_mulla"
	}
	if prayer == "fajr" {
		if a.s.FajrVoice != "" && a.s.FajrVoice != "auto" {
			return a.s.FajrVoice
		}
		if f := a.voices[v].Fajr; f != "" {
			return f
		}
	}
	return v
}

// ---------------- Audio ----------------

func sniffAudio(b []byte) string {
	switch {
	case len(b) < 12:
		return ""
	case bytes.HasPrefix(b, []byte("ID3")) || (b[0] == 0xff && b[1]&0xe0 == 0xe0):
		return ".mp3"
	case string(b[4:8]) == "ftyp":
		return ".m4a"
	case bytes.HasPrefix(b, []byte("OggS")):
		return ".ogg"
	case bytes.HasPrefix(b, []byte("RIFF")):
		return ".wav"
	}
	return ""
}

var mimeByExt = map[string]string{".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav"}

func (a *App) cachedAudio(id string) string {
	for ext := range mimeByExt {
		p := filepath.Join(a.cacheDir, "audio", id+ext)
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			return p
		}
	}
	return ""
}

// ensureAudio lädt eine Aufnahme (einmalig) herunter und liefert den lokalen Pfad.
func (a *App) ensureAudio(id string) (string, error) {
	if id == "chime" {
		return a.chimeFile()
	}
	if p := a.cachedAudio(id); p != "" {
		return p, nil
	}
	v, ok := a.voices[id]
	if !ok {
		return "", fmt.Errorf("unbekannte Stimme %q", id)
	}
	m, _ := a.downloads.LoadOrStore(id, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if p := a.cachedAudio(id); p != "" {
		return p, nil
	}
	client := &http.Client{Timeout: 90 * time.Second}
	var lastErr error
	for _, src := range v.Src {
		req, _ := http.NewRequest("GET", src, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AthanApp/"+version)
		r, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, 40<<20))
		r.Body.Close()
		if err != nil || r.StatusCode != 200 {
			lastErr = fmt.Errorf("HTTP %d", r.StatusCode)
			continue
		}
		ext := sniffAudio(b)
		if ext == "" {
			lastErr = errors.New("keine Audiodatei")
			continue
		}
		p := filepath.Join(a.cacheDir, "audio", id+ext)
		if err := os.WriteFile(p+".tmp", b, 0o600); err != nil {
			return "", err
		}
		os.Rename(p+".tmp", p)
		log.Printf("Aufnahme %s geladen (%d KB)", id, len(b)/1024)
		return p, nil
	}
	return "", fmt.Errorf("Download %s fehlgeschlagen: %v", id, lastErr)
}

// prefetch lädt die gewählten Stimmen vorab, damit der Athan auch ohne Internet erklingt.
func (a *App) prefetch() {
	for _, p := range []string{"dhuhr", "fajr"} {
		if id := a.voiceFor(p); id != "custom" {
			if _, err := a.ensureAudio(id); err != nil {
				log.Print(err)
			}
		}
	}
}

// Sanfter Gong als WAV – Ersatz, falls keine Aufnahme verfügbar ist.
func (a *App) chimeFile() (string, error) {
	p := filepath.Join(a.cacheDir, "audio", "chime.wav")
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	const rate = 22050
	dur := 8.0
	n := int(dur * rate)
	pcm := make([]int16, n)
	notes := []float64{523.25, 659.25, 783.99}
	for r := 0; r < 3; r++ {
		for i, f := range notes {
			start := float64(r)*2.4 + float64(i)*0.42
			for _, h := range [][2]float64{{1, 1}, {2.76, 0.28}, {5.4, 0.1}} {
				for k := int(start * rate); k < n && k < int((start+2.6)*rate); k++ {
					t := float64(k)/rate - start
					env := math.Exp(-t*2.2) * math.Min(1, t*50)
					v := float64(pcm[k]) + 5200*h[1]*env*math.Sin(2*math.Pi*f*h[0]*t)
					pcm[k] = int16(math.Max(-32000, math.Min(32000, v)))
				}
			}
		}
	}
	var buf bytes.Buffer
	w := func(v any) { binaryWrite(&buf, v) }
	buf.WriteString("RIFF")
	w(uint32(36 + n*2))
	buf.WriteString("WAVEfmt ")
	w(uint32(16))
	w(uint16(1))
	w(uint16(1))
	w(uint32(rate))
	w(uint32(rate * 2))
	w(uint16(2))
	w(uint16(16))
	buf.WriteString("data")
	w(uint32(n * 2))
	for _, s := range pcm {
		w(s)
	}
	return p, os.WriteFile(p, buf.Bytes(), 0o600)
}

func binaryWrite(b *bytes.Buffer, v any) {
	switch x := v.(type) {
	case uint32:
		b.Write([]byte{byte(x), byte(x >> 8), byte(x >> 16), byte(x >> 24)})
	case uint16:
		b.Write([]byte{byte(x), byte(x >> 8)})
	case int16:
		b.Write([]byte{byte(x), byte(uint16(x) >> 8)})
	}
}

// ---------------- Planer ----------------

func (a *App) scheduler() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		a.checkSchedule(time.Now())
		select {
		case <-t.C:
		case <-a.wake:
		}
	}
}

func (a *App) displayName(prayer string, at time.Time) (string, string) {
	n := prayerNames[prayer] // freitags ebenfalls „Dhuhr“
	return n[0], n[1]
}

func (a *App) fmtTime(t time.Time) string {
	a.mu.Lock()
	twelve := a.s.Clock == "12"
	a.mu.Unlock()
	if twelve {
		return t.Format("3:04 PM")
	}
	return t.Format("15:04")
}

func (a *App) checkSchedule(now time.Time) {
	a.mu.Lock()
	s, loc := a.s, a.loc
	a.mu.Unlock()
	if s.Location == nil || loc == nil {
		a.plat.SetTooltip("Athan – Ort wählen")
		return
	}
	events := UpcomingEvents(s.Location.Lat, s.Location.Lon, loc, s.Calc, now.Add(-3*time.Minute), 1)
	var next *Event
	for i := range events {
		e := events[i]
		at := e.At.In(loc)
		if next == nil && at.After(now) {
			next = &e
		}
		mode := s.Modes[e.Prayer]
		if mode == "" {
			mode = map[bool]string{true: "off", false: "athan"}[e.Prayer == "sunrise"]
		}
		if mode == "off" {
			continue
		}
		key := fmt.Sprintf("%s:%d", e.Prayer, e.At.Unix())
		name, ar := a.displayName(e.Prayer, at)
		if !at.After(now) && now.Sub(at) < 3*time.Minute && !a.wasFired(key) {
			a.markFired(key)
			go a.fire(e.Prayer, at, mode, name, ar, s)
		}
		if s.Pre > 0 {
			preAt := at.Add(-time.Duration(s.Pre) * time.Minute)
			pk := "pre:" + key
			if !preAt.After(now) && now.Sub(preAt) < 3*time.Minute && at.After(now) && !a.wasFired(pk) {
				a.markFired(pk)
				a.plat.Notify(fmt.Sprintf("%s in %d Minuten", name, s.Pre), fmt.Sprintf("Um %s · %s", a.fmtTime(at), s.Location.Name), false)
			}
		}
	}
	if next != nil {
		name, _ := a.displayName(next.Prayer, next.At.In(loc))
		a.plat.SetTooltip(fmt.Sprintf("Athan – %s um %s (%s)", name, a.fmtTime(next.At.In(loc)), s.Location.Name))
	}
}

func (a *App) wasFired(k string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.fired[k]
	return ok
}

func (a *App) markFired(k string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.fired[k] = time.Now()
	for key, t := range a.fired {
		if time.Since(t) > 6*time.Hour {
			delete(a.fired, key)
		}
	}
}

func (a *App) fire(prayer string, at time.Time, mode, name, ar string, s Settings) {
	athan := mode == "athan" && prayer != "sunrise"
	title := fmt.Sprintf("Zeit für %s (%s)", name, ar)
	if prayer == "sunrise" {
		title = fmt.Sprintf("Sonnenaufgang (%s)", ar)
	}
	a.plat.Notify(title, fmt.Sprintf("%s · %s", a.fmtTime(at), s.Location.Name), athan)
	log.Printf("%s um %s (%s)", name, a.fmtTime(at), mode)
	if !athan {
		return
	}
	voice := a.voiceFor(prayer)
	a.playVoice(voice, prayer, at)
	if s.OpenOnAthan {
		a.plat.OpenWindow(a.url())
	}
}

func (a *App) playVoice(voice, prayer string, at time.Time) {
	file := ""
	if voice == "custom" {
		file = a.cachedAudio("custom")
	} else if p, err := a.ensureAudio(voice); err == nil {
		file = p
	} else {
		log.Print(err)
	}
	if file == "" {
		file, _ = a.chimeFile()
		voice = "chime"
	}
	a.mu.Lock()
	vol := a.s.Volume
	limit := a.athanLimit(voice)
	a.playing = &Playing{Prayer: prayer, Voice: voice, At: at.UnixMilli()}
	a.mu.Unlock()
	err := a.plat.Play(file, vol, limit, func() {
		a.mu.Lock()
		a.playing = nil
		a.mu.Unlock()
	})
	if err != nil {
		// Ersatzweg: das Athan-Fenster (Edge) spielt die Aufnahme ab
		log.Printf("Windows-Wiedergabe fehlgeschlagen (%v) – Athan spielt im Fenster", err)
		atMs := at.UnixMilli()
		a.mu.Lock()
		a.playing = &Playing{Prayer: prayer, Voice: voice, At: atMs, Client: true}
		a.mu.Unlock()
		a.plat.OpenWindow(a.url())
		time.AfterFunc(10*time.Minute, func() {
			a.mu.Lock()
			if a.playing != nil && a.playing.At == atMs {
				a.playing = nil
			}
			a.mu.Unlock()
		})
		return
	}
	if limit > 0 {
		log.Printf("Athan spielt: %s (%s), erste Verse bis %.1f s", voice, filepath.Base(file), limit.Seconds())
	} else {
		log.Printf("Athan spielt: %s (%s)", voice, filepath.Base(file))
	}
}

// athanLimit: bei „Erste Verse“ bis zur Atempause vor 30 s (muezzins.json), eigene Aufnahme 30 s, Gong ganz.
// Aufruf mit gesperrtem a.mu.
func (a *App) athanLimit(voice string) time.Duration {
	if a.s.AthanLength != "short" || voice == "chime" {
		return 0
	}
	if v, ok := a.voices[voice]; ok && len(v.Clip) == 2 && v.Clip[1] > 1 {
		return time.Duration(v.Clip[1] * float64(time.Second))
	}
	return 30 * time.Second
}

func (a *App) stop() {
	a.plat.Stop()
	a.mu.Lock()
	a.playing = nil
	a.mu.Unlock()
}

// ---------------- HTTP ----------------

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
	".png": "image/png", ".ico": "image/x-icon",
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "athan") })
	mux.HandleFunc("GET /api/state", a.auth(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		raw := a.raw
		a.mu.Unlock()
		writeJSON(w, map[string]any{"settings": raw, "autostart": a.plat.Autostart(), "hasCustom": a.cachedAudio("custom") != "", "version": version})
	}))
	mux.HandleFunc("GET /api/status", a.auth(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		p := a.playing
		a.mu.Unlock()
		writeJSON(w, map[string]any{"playing": p, "autostart": a.plat.Autostart()})
	}))
	mux.HandleFunc("PUT /api/settings", a.auth(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil || !json.Valid(b) {
			http.Error(w, "ungültig", 400)
			return
		}
		if err := a.saveSettings(b); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/stop", a.auth(func(w http.ResponseWriter, r *http.Request) { a.stop(); writeJSON(w, map[string]bool{"ok": true}) }))
	mux.HandleFunc("POST /api/show", a.auth(func(w http.ResponseWriter, r *http.Request) {
		a.plat.OpenWindow(a.url())
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/test", a.auth(func(w http.ResponseWriter, r *http.Request) {
		a.plat.Notify("Athan – Test", "So sieht eine Gebetszeit-Benachrichtigung aus.", false)
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/test-athan", a.auth(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		s, loc := a.s, a.loc
		a.mu.Unlock()
		if s.Location == nil || loc == nil {
			http.Error(w, "Ort fehlt", 400)
			return
		}
		now := time.Now().In(loc)
		name, ar := a.displayName("maghrib", now)
		go a.fire("maghrib", now, "athan", name, ar, s)
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/notify", a.auth(func(w http.ResponseWriter, r *http.Request) {
		var m struct{ Title, Body string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&m)
		a.plat.Notify(trim(m.Title, 60), trim(m.Body, 200), false)
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/autostart", a.auth(func(w http.ResponseWriter, r *http.Request) {
		var m struct{ Enabled bool }
		json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&m)
		if err := a.plat.SetAutostart(m.Enabled); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, map[string]bool{"autostart": a.plat.Autostart()})
	}))
	mux.HandleFunc("POST /api/custom-audio", a.auth(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(io.LimitReader(r.Body, 26<<20))
		ext := sniffAudio(b)
		if err != nil || ext == "" {
			http.Error(w, "Keine unterstützte Audiodatei (MP3, M4A, OGG, WAV)", 400)
			return
		}
		for e := range mimeByExt {
			os.Remove(filepath.Join(a.cacheDir, "audio", "custom"+e))
		}
		if err := os.WriteFile(filepath.Join(a.cacheDir, "audio", "custom"+ext), b, 0o600); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/audio/{id}", a.auth(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !validID(id) {
			http.Error(w, "unbekannte Stimme", 404)
			return
		}
		var p string
		var err error
		if id == "custom" {
			if p = a.cachedAudio("custom"); p == "" {
				err = errors.New("keine eigene Aufnahme")
			}
		} else {
			p, err = a.ensureAudio(id)
		}
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		st, _ := f.Stat()
		w.Header().Set("Content-Type", mimeByExt[filepath.Ext(p)])
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeContent(w, r, "", st.ModTime(), f)
	}))

	// statische Dateien (eingebettet); Token wird in index.html eingesetzt
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		b, err := fs.ReadFile(sub, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if name == "index.html" {
			b = bytes.Replace(b, []byte("<head>"), []byte(`<head>
  <meta name="athan-desktop" content="`+a.token+`">`), 1)
		}
		if ct, ok := contentTypes[path.Ext(name)]; ok {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})

	// Schutz: nur 127.0.0.1/localhost als Host (gegen DNS-Rebinding), Sicherheits-Header
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if host != fmt.Sprintf("127.0.0.1:%d", a.port) && host != fmt.Sprintf("localhost:%d", a.port) {
			http.Error(w, "Verboten", 403)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}

// auth verlangt das Sitzungs-Token (Header oder ?t= für <audio>). Fremde Webseiten kennen es nicht.
func (a *App) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("X-Athan-Token")
		if tok == "" && r.Method == "GET" {
			tok = r.URL.Query().Get("t")
		}
		if len(tok) != len(a.token) || subtleEq(tok, a.token) != 1 {
			http.Error(w, "Nicht erlaubt", 401)
			return
		}
		h(w, r)
	}
}

func subtleEq(x, y string) int {
	var v byte
	for i := 0; i < len(x) && i < len(y); i++ {
		v |= x[i] ^ y[i]
	}
	if v == 0 && len(x) == len(y) {
		return 1
	}
	return 0
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func validID(id string) bool {
	if id == "" || len(id) > 40 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func trim(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
