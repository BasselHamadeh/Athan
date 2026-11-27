//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

func init() { runtime.LockOSThread() } // Nachrichtenschleife bleibt auf dem Hauptthread

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	winmm    = syscall.NewLazyDLL("winmm.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	uxtheme  = syscall.NewLazyDLL("uxtheme.dll")

	pRegisterClassExW       = user32.NewProc("RegisterClassExW")
	pCreateWindowExW        = user32.NewProc("CreateWindowExW")
	pDefWindowProcW         = user32.NewProc("DefWindowProcW")
	pGetMessageW            = user32.NewProc("GetMessageW")
	pTranslateMessage       = user32.NewProc("TranslateMessage")
	pDispatchMessageW       = user32.NewProc("DispatchMessageW")
	pPostMessageW           = user32.NewProc("PostMessageW")
	pPostQuitMessage        = user32.NewProc("PostQuitMessage")
	pLoadImageW             = user32.NewProc("LoadImageW")
	pCreatePopupMenu        = user32.NewProc("CreatePopupMenu")
	pAppendMenuW            = user32.NewProc("AppendMenuW")
	pTrackPopupMenu         = user32.NewProc("TrackPopupMenu")
	pSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	pGetCursorPos           = user32.NewProc("GetCursorPos")
	pDestroyMenu            = user32.NewProc("DestroyMenu")
	pSetMenuDefaultItem     = user32.NewProc("SetMenuDefaultItem")
	pRegisterWindowMessageW = user32.NewProc("RegisterWindowMessageW")
	pGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	pEnumWindows            = user32.NewProc("EnumWindows")
	pGetWindowTextW         = user32.NewProc("GetWindowTextW")
	pGetClassNameW          = user32.NewProc("GetClassNameW")
	pIsWindowVisible        = user32.NewProc("IsWindowVisible")
	pShowWindow             = user32.NewProc("ShowWindow")
	pIsIconic               = user32.NewProc("IsIconic")
	pSetProcessDpiAwareCtx  = user32.NewProc("SetProcessDpiAwarenessContext")
	pShellNotifyIconW       = shell32.NewProc("Shell_NotifyIconW")
	pShellExecuteW          = shell32.NewProc("ShellExecuteW")
	pGetModuleHandleW       = kernel32.NewProc("GetModuleHandleW")
	pGetCurrentThreadId     = kernel32.NewProc("GetCurrentThreadId")
	pGetProcAddress         = kernel32.NewProc("GetProcAddress")
	pMciSendStringW         = winmm.NewProc("mciSendStringW")
	pMciGetErrorStringW     = winmm.NewProc("mciGetErrorStringW")
	pRegOpenKeyExW          = advapi32.NewProc("RegOpenKeyExW")
	pRegSetValueExW         = advapi32.NewProc("RegSetValueExW")
	pRegDeleteValueW        = advapi32.NewProc("RegDeleteValueW")
	pRegQueryValueExW       = advapi32.NewProc("RegQueryValueExW")
	pRegCloseKey            = advapi32.NewProc("RegCloseKey")
)

const (
	wmDestroy       = 0x0002
	wmNull          = 0x0000
	wmQueryEndSess  = 0x0011
	wmEndSession    = 0x0016
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205
	wmContextMenu   = 0x007B
	wmApp           = 0x8000
	wmTray          = wmApp + 1
	wmInvoke        = wmApp + 2
	ninBalloonClick = 0x0405
	mmMciNotify     = 0x03B9
	nimAdd          = 0
	nimModify       = 1
	nimDelete       = 2
	nifMessage      = 0x01
	nifIcon         = 0x02
	nifTip          = 0x04
	nifInfo         = 0x10
	niifUser        = 0x04
	niifNoSound     = 0x10
	niifLargeIcon   = 0x20
	mfString        = 0x0000
	mfGrayed        = 0x0001
	mfChecked       = 0x0008
	mfSeparator     = 0x0800
	tpmReturnCmd    = 0x0100
	tpmNoNotify     = 0x0080
	tpmRightButton  = 0x0002
	hkeyCurrentUser = 0x80000001
	keyQueryValue   = 0x0001
	keySetValue     = 0x0002
	regSZ           = 1
	imageIcon       = 1
	lrLoadFromFile  = 0x0010
	smCxIcon        = 11
	smCxSmIcon      = 49
	swRestore       = 9
	swShowNormal    = 1
	idOpen          = 1
	idStop          = 2
	idAutostart     = 3
	idQuit          = 4
	runKey          = `Software\Microsoft\Windows\CurrentVersion\Run`
)

type point struct{ X, Y int32 }

type msgT struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         [16]byte
	HBalloonIcon     uintptr
}

type winPlatform struct {
	app        *App
	hwnd       uintptr
	uiThread   uintptr
	iconSmall  uintptr
	iconLarge  uintptr
	mu         sync.Mutex
	tip        string
	queue      []func()
	qmu        sync.Mutex
	playDone   func()
	playing    bool
	taskbarMsg uintptr
}

var thePlatform *winPlatform
var wndProcCb = syscall.NewCallback(wndProc)

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func copyU16(dst []uint16, s string) {
	u := syscall.StringToUTF16(s)
	if len(u) > len(dst) {
		u = u[:len(dst)-1]
		u = append(u, 0)
	}
	copy(dst, u)
}

func newPlatform(app *App) Platform {
	// Scharfe Symbole auf hochauflösenden Bildschirmen
	if pSetProcessDpiAwareCtx.Find() == nil {
		pSetProcessDpiAwareCtx.Call(uintptr(^uintptr(3))) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	}
	enableDarkMenus()
	p := &winPlatform{app: app}
	thePlatform = p
	p.uiThread, _, _ = pGetCurrentThreadId.Call()
	hInst, _, _ := pGetModuleHandleW.Call(0)

	icoPath := filepath.Join(app.cacheDir, "athan.ico")
	os.WriteFile(icoPath, iconICO, 0o600)
	sm, _, _ := pGetSystemMetrics.Call(smCxSmIcon)
	lg, _, _ := pGetSystemMetrics.Call(smCxIcon)
	p.iconSmall, _, _ = pLoadImageW.Call(0, uintptr(unsafe.Pointer(u16(icoPath))), imageIcon, sm, sm, lrLoadFromFile)
	p.iconLarge, _, _ = pLoadImageW.Call(0, uintptr(unsafe.Pointer(u16(icoPath))), imageIcon, lg*2, lg*2, lrLoadFromFile)

	cls := u16("AthanTrayWindow")
	wc := wndClassEx{WndProc: wndProcCb, Instance: hInst, ClassName: cls, Icon: p.iconLarge, IconSm: p.iconSmall}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	p.hwnd, _, _ = pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(u16("Athan"))), 0, 0, 0, 0, 0, 0, 0, hInst, 0)
	p.taskbarMsg, _, _ = pRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(u16("TaskbarCreated"))))
	p.tip = "Athan"
	p.addIcon()
	return p
}

// Dunkle Kontextmenüs, wenn Windows im Dunkelmodus ist (uxtheme, Ordinal 135/136)
func enableDarkMenus() {
	defer func() { recover() }()
	if uxtheme.Load() != nil {
		return
	}
	h := uxtheme.Handle()
	setMode, _, _ := pGetProcAddress.Call(h, 135)
	flush, _, _ := pGetProcAddress.Call(h, 136)
	if setMode != 0 {
		syscall.SyscallN(setMode, 1) // AllowDark
	}
	if flush != 0 {
		syscall.SyscallN(flush)
	}
}

func (p *winPlatform) baseNID() notifyIconData {
	var n notifyIconData
	n.CbSize = uint32(unsafe.Sizeof(n))
	n.HWnd = p.hwnd
	n.UID = 1
	return n
}

func (p *winPlatform) addIcon() {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := p.baseNID()
	n.UFlags = nifMessage | nifIcon | nifTip
	n.UCallbackMessage = wmTray
	n.HIcon = p.iconSmall
	copyU16(n.SzTip[:], p.tip)
	pShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&n)))
}

func (p *winPlatform) SetTooltip(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if s == p.tip {
		return
	}
	p.tip = s
	n := p.baseNID()
	n.UFlags = nifTip
	copyU16(n.SzTip[:], s)
	pShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&n)))
}

func (p *winPlatform) Notify(title, body string, silent bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := p.baseNID()
	n.UFlags = nifInfo
	copyU16(n.SzInfoTitle[:], title)
	copyU16(n.SzInfo[:], body)
	n.DwInfoFlags = niifUser | niifLargeIcon
	if silent {
		n.DwInfoFlags |= niifNoSound
	}
	n.HBalloonIcon = p.iconLarge
	pShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&n)))
}

// onUI führt f auf dem Fenster-Thread aus (MCI ist threadgebunden).
func (p *winPlatform) onUI(f func() error) error {
	if tid, _, _ := pGetCurrentThreadId.Call(); tid == p.uiThread {
		return f()
	}
	done := make(chan error, 1)
	p.qmu.Lock()
	p.queue = append(p.queue, func() { done <- f() })
	p.qmu.Unlock()
	pPostMessageW.Call(p.hwnd, wmInvoke, 0, 0)
	return <-done
}

func mci(cmd string, hwnd uintptr) error {
	r, _, _ := pMciSendStringW.Call(uintptr(unsafe.Pointer(u16(cmd))), 0, 0, hwnd)
	if r != 0 {
		buf := make([]uint16, 256)
		pMciGetErrorStringW.Call(r, uintptr(unsafe.Pointer(&buf[0])), 256)
		return fmt.Errorf("MCI (%s): %s", strings.SplitN(cmd, " ", 2)[0], syscall.UTF16ToString(buf))
	}
	return nil
}

func (p *winPlatform) Play(file string, volume float64, done func()) error {
	return p.onUI(func() error {
		p.stopLocked()
		if err := mci(fmt.Sprintf(`open "%s" type mpegvideo alias athan`, file), 0); err != nil {
			return err
		}
		mci(fmt.Sprintf("setaudio athan volume to %d", int(volume*1000)), 0)
		p.playDone, p.playing = done, true
		if err := mci("play athan notify", p.hwnd); err != nil {
			p.stopLocked()
			return err
		}
		return nil
	})
}

func (p *winPlatform) stopLocked() {
	if p.playing {
		mci("stop athan", 0)
	}
	mci("close athan", 0)
	if p.playDone != nil {
		d := p.playDone
		p.playDone = nil
		go d()
	}
	p.playing = false
}

func (p *winPlatform) Stop() { p.onUI(func() error { p.stopLocked(); return nil }) }

// OpenWindow öffnet die Oberfläche als eigenes App-Fenster (Edge/Chrome im App-Modus).
func (p *winPlatform) OpenWindow(url string) {
	if focusExisting() {
		return
	}
	browser := ""
	for _, rel := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
		for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
			c := filepath.Join(os.Getenv(env), rel)
			if _, err := os.Stat(c); err == nil {
				browser = c
				break
			}
		}
		if browser != "" {
			break
		}
	}
	if browser != "" {
		cmd := exec.Command(browser, "--app="+url, "--user-data-dir="+filepath.Join(p.app.cacheDir, "window"),
			"--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-size=1180,820",
			"--autoplay-policy=no-user-gesture-required")
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return
		}
	}
	pShellExecuteW.Call(0, uintptr(unsafe.Pointer(u16("open"))), uintptr(unsafe.Pointer(u16(url))), 0, 0, swShowNormal)
}

var foundWnd uintptr
var enumCb = syscall.NewCallback(func(h, _ uintptr) uintptr {
	if v, _, _ := pIsWindowVisible.Call(h); v == 0 {
		return 1
	}
	cls := make([]uint16, 64)
	pGetClassNameW.Call(h, uintptr(unsafe.Pointer(&cls[0])), 64)
	if syscall.UTF16ToString(cls) != "Chrome_WidgetWin_1" {
		return 1
	}
	t := make([]uint16, 256)
	pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&t[0])), 256)
	title := syscall.UTF16ToString(t)
	if title == "Athan" || strings.HasSuffix(title, "– Athan") {
		foundWnd = h
		return 0
	}
	return 1
})

func focusExisting() bool {
	foundWnd = 0
	pEnumWindows.Call(enumCb, 0)
	if foundWnd == 0 {
		return false
	}
	if ic, _, _ := pIsIconic.Call(foundWnd); ic != 0 {
		pShowWindow.Call(foundWnd, swRestore)
	}
	pSetForegroundWindow.Call(foundWnd)
	return true
}

// ---------- Autostart (HKCU\...\Run) ----------

func (p *winPlatform) Autostart() bool {
	var h uintptr
	if r, _, _ := pRegOpenKeyExW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(runKey))), 0, keyQueryValue, uintptr(unsafe.Pointer(&h))); r != 0 {
		return false
	}
	defer pRegCloseKey.Call(h)
	var typ, size uint32
	r, _, _ := pRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(u16("Athan"))), 0, uintptr(unsafe.Pointer(&typ)), 0, uintptr(unsafe.Pointer(&size)))
	return r == 0
}

func (p *winPlatform) SetAutostart(on bool) error {
	var h uintptr
	if r, _, _ := pRegOpenKeyExW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(u16(runKey))), 0, keySetValue|keyQueryValue, uintptr(unsafe.Pointer(&h))); r != 0 {
		return fmt.Errorf("Registry nicht beschreibbar (%d)", r)
	}
	defer pRegCloseKey.Call(h)
	if !on {
		pRegDeleteValueW.Call(h, uintptr(unsafe.Pointer(u16("Athan"))))
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	val := syscall.StringToUTF16(`"` + exe + `" --background`)
	r, _, _ := pRegSetValueExW.Call(h, uintptr(unsafe.Pointer(u16("Athan"))), 0, regSZ, uintptr(unsafe.Pointer(&val[0])), uintptr(len(val)*2))
	if r != 0 {
		return errors.New("Autostart konnte nicht gesetzt werden")
	}
	return nil
}

// ---------- Nachrichtenschleife ----------

func (p *winPlatform) Run(app *App) {
	var m msgT
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	p.removeIcon()
	log.Print("Athan beendet")
}

func (p *winPlatform) removeIcon() {
	n := p.baseNID()
	pShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&n)))
}

func (p *winPlatform) showMenu() {
	m, _, _ := pCreatePopupMenu.Call()
	add := func(flags uintptr, id uintptr, text string) {
		var t uintptr
		if text != "" {
			t = uintptr(unsafe.Pointer(u16(text)))
		}
		pAppendMenuW.Call(m, flags, id, t)
	}
	p.mu.Lock()
	tip := strings.TrimPrefix(p.tip, "Athan – ")
	p.mu.Unlock()
	add(mfString|mfGrayed, 0, tip)
	add(mfSeparator, 0, "")
	add(mfString, idOpen, "Athan öffnen")
	pSetMenuDefaultItem.Call(m, idOpen, 0)
	stopFlags := uintptr(mfString)
	if !p.playing {
		stopFlags |= mfGrayed
	}
	add(stopFlags, idStop, "Athan stoppen")
	add(mfSeparator, 0, "")
	auto := uintptr(mfString)
	if p.Autostart() {
		auto |= mfChecked
	}
	add(auto, idAutostart, "Mit Windows starten")
	add(mfSeparator, 0, "")
	add(mfString, idQuit, "Beenden")
	var pt point
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	pSetForegroundWindow.Call(p.hwnd)
	cmd, _, _ := pTrackPopupMenu.Call(m, tpmReturnCmd|tpmNoNotify|tpmRightButton, uintptr(pt.X), uintptr(pt.Y), 0, p.hwnd, 0)
	pPostMessageW.Call(p.hwnd, wmNull, 0, 0)
	pDestroyMenu.Call(m)
	switch cmd {
	case idOpen:
		go p.OpenWindow(p.app.url())
	case idStop:
		p.stopLocked()
		p.app.mu.Lock()
		p.app.playing = nil
		p.app.mu.Unlock()
	case idAutostart:
		p.SetAutostart(!p.Autostart())
	case idQuit:
		p.stopLocked()
		p.removeIcon()
		pPostQuitMessage.Call(0)
	}
}

func wndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	p := thePlatform
	if p == nil {
		r, _, _ := pDefWindowProcW.Call(hwnd, msg, wparam, lparam)
		return r
	}
	switch {
	case msg == wmTray:
		switch lparam & 0xffff {
		case wmLButtonUp, wmLButtonDblClk, ninBalloonClick:
			go p.OpenWindow(p.app.url())
		case wmRButtonUp, wmContextMenu:
			p.showMenu()
		}
		return 0
	case msg == wmInvoke:
		p.qmu.Lock()
		q := p.queue
		p.queue = nil
		p.qmu.Unlock()
		for _, f := range q {
			f()
		}
		return 0
	case msg == mmMciNotify:
		// 1 = fertig, 8 = Fehler; bei Abbruch (4) räumt stopLocked bereits auf
		if wparam == 1 || wparam == 8 {
			p.stopLocked()
		}
		return 0
	case p.taskbarMsg != 0 && msg == p.taskbarMsg:
		p.addIcon() // Explorer wurde neu gestartet
		return 0
	case msg == wmQueryEndSess:
		return 1
	case msg == wmEndSession:
		p.removeIcon()
		return 0
	case msg == wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}
