//go:build !windows

package main

// Entwicklungs-Platzhalter für Linux/macOS: gleiche App, aber Ausgaben nur im Terminal.

import (
	"errors"
	"log"
	"os"
	"os/signal"
	"sync"
	"time"
)

type devPlatform struct {
	mu    sync.Mutex
	timer *time.Timer
	done  func()
	auto  bool
}

func newPlatform(app *App) Platform { return &devPlatform{} }

func (p *devPlatform) Run(app *App) {
	log.Printf("Oberfläche: %s", app.url())
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	<-c
}
func (p *devPlatform) Notify(title, body string, silent bool) {
	log.Printf("[Benachrichtigung] %s – %s (leise=%v)", title, body, silent)
}
func (p *devPlatform) Play(file string, volume float64, limit time.Duration, done func()) error {
	if os.Getenv("ATHAN_DEV_PLAY_FAIL") == "1" {
		return errors.New("simuliert: kein Audiogerät")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d := 20 * time.Second
	if limit > 0 && limit < d {
		d = limit
	}
	log.Printf("[Wiedergabe] %s (Lautstärke %.0f%%, Dauer %s)", file, volume*100, d)
	p.done = done
	p.timer = time.AfterFunc(d, func() { p.Stop() })
	return nil
}
func (p *devPlatform) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.timer != nil {
		p.timer.Stop()
	}
	if p.done != nil {
		go p.done()
		p.done = nil
		log.Print("[Wiedergabe] gestoppt")
	}
}
func (p *devPlatform) SetTooltip(s string)        {}
func (p *devPlatform) OpenWindow(url string)      { log.Printf("[Fenster] %s", url) }
func (p *devPlatform) Autostart() bool            { return p.auto }
func (p *devPlatform) SetAutostart(on bool) error { p.auto = on; return nil }
