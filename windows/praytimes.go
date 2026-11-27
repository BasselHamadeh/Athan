package main

// Gebetszeiten-Engine – 1:1-Portierung von web/js/praytimes.js (gleiche Ergebnisse, per Test geprüft).

import (
	"math"
	"sort"
	"time"
)

var Kaaba = struct{ Lat, Lon float64 }{21.422487, 39.826206}

type method struct {
	Fajr, Isha, IshaMin, Maghrib float64
	HasIsha, HasIshaMin          bool
	HasMaghrib                   bool
	RamadanIshaMin               float64
	Jafari                       bool
	Adjust                       map[string]float64
}

var methods = map[string]method{
	"MWL":       {Fajr: 18, Isha: 17, HasIsha: true},
	"ISNA":      {Fajr: 15, Isha: 15, HasIsha: true},
	"Egypt":     {Fajr: 19.5, Isha: 17.5, HasIsha: true},
	"Makkah":    {Fajr: 18.5, IshaMin: 90, HasIshaMin: true, RamadanIshaMin: 120},
	"Karachi":   {Fajr: 18, Isha: 18, HasIsha: true},
	"Turkey":    {Fajr: 18, Isha: 17, HasIsha: true, Adjust: map[string]float64{"sunrise": -7, "dhuhr": 5, "asr": 4, "maghrib": 7}},
	"Dubai":     {Fajr: 18.2, Isha: 18.2, HasIsha: true, Adjust: map[string]float64{"sunrise": -3, "dhuhr": 3, "asr": 3, "maghrib": 3}},
	"Kuwait":    {Fajr: 18, Isha: 17.5, HasIsha: true},
	"Qatar":     {Fajr: 18, IshaMin: 90, HasIshaMin: true},
	"Gulf":      {Fajr: 19.5, IshaMin: 90, HasIshaMin: true},
	"Singapore": {Fajr: 20, Isha: 18, HasIsha: true},
	"JAKIM":     {Fajr: 20, Isha: 18, HasIsha: true},
	"France":    {Fajr: 12, Isha: 12, HasIsha: true},
	"Russia":    {Fajr: 16, Isha: 15, HasIsha: true},
	"Tehran":    {Fajr: 17.7, Isha: 14, HasIsha: true, Maghrib: 4.5, HasMaghrib: true, Jafari: true},
	"Jafari":    {Fajr: 16, Isha: 14, HasIsha: true, Maghrib: 4, HasMaghrib: true, Jafari: true},
	"Custom":    {Fajr: 18, Isha: 17, HasIsha: true},
}

var Prayers = []string{"fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"}

type CalcSettings struct {
	Method  string             `json:"method"`
	Asr     string             `json:"asr"`
	HighLat string             `json:"highLat"`
	Adjust  map[string]float64 `json:"adjust"`
	Custom  struct {
		Fajr       *float64 `json:"fajr"`
		Isha       *float64 `json:"isha"`
		IshaMin    *float64 `json:"ishaMin"`
		MaghribMin *float64 `json:"maghribMin"`
	} `json:"custom"`
}

type Date struct{ Y, M, D int }

const deg = math.Pi / 180

func dsin(d float64) float64        { return math.Sin(d * deg) }
func dcos(d float64) float64        { return math.Cos(d * deg) }
func dtan(d float64) float64        { return math.Tan(d * deg) }
func darcsin(x float64) float64     { return math.Asin(x) / deg }
func darccos(x float64) float64     { return math.Acos(x) / deg }
func darctan2(y, x float64) float64 { return math.Atan2(y, x) / deg }
func darccot(x float64) float64     { return math.Atan(1/x) / deg }
func fixf(a, b float64) float64 {
	a = a - b*math.Floor(a/b)
	if a < 0 {
		a += b
	}
	return a
}
func fixAngle(a float64) float64      { return fixf(a, 360) }
func fixHour(a float64) float64       { return fixf(a, 24) }
func timeDiff(t1, t2 float64) float64 { return fixHour(t2 - t1) }
func finite(x float64) bool           { return !math.IsNaN(x) && !math.IsInf(x, 0) }

func julian(y, m, d int) float64 {
	if m <= 2 {
		y--
		m += 12
	}
	A := math.Floor(float64(y) / 100)
	B := 2 - A + math.Floor(A/4)
	return math.Floor(365.25*float64(y+4716)) + math.Floor(30.6001*float64(m+1)) + float64(d) + B - 1524.5
}

func sunPosition(jd float64) (decl, eqt float64) {
	D := jd - 2451545.0
	g := fixAngle(357.529 + 0.98560028*D)
	q := fixAngle(280.459 + 0.98564736*D)
	L := fixAngle(q + 1.915*dsin(g) + 0.020*dsin(2*g))
	e := 23.439 - 0.00000036*D
	RA := darctan2(dcos(e)*dsin(L), dcos(L)) / 15
	eqt = q/15 - fixHour(RA)
	decl = darcsin(dsin(e) * dsin(L))
	return
}

func floorDiv(a, b float64) float64 { return math.Floor(a / b) }

// Tabellarischer Hidschri-Kalender (identisch zu hijriArithmetic in JS)
func hijriArithmetic(y, m, d int) Date {
	jd := math.Floor(julian(y, m, d) + 0.5)
	l0 := jd - 1948440 + 10632
	n := floorDiv(l0-1, 10631)
	l1 := l0 - 10631*n + 354
	j := floorDiv(10985-l1, 5316)*floorDiv(50*l1, 17719) + floorDiv(l1, 5670)*floorDiv(43*l1, 15238)
	l2 := l1 - floorDiv(30-j, 15)*floorDiv(17719*j, 50) - floorDiv(j, 16)*floorDiv(15238*j, 43) + 29
	hm := floorDiv(24*l2, 709)
	hd := l2 - floorDiv(709*hm, 24)
	hy := 30*n + j - 30
	return Date{int(hy), int(hm), int(hd)}
}

type params struct {
	fajr, isha, ishaMin, maghrib, maghribMin       float64
	hasIsha, hasIshaMin, hasMaghrib, hasMaghribMin bool
	jafari                                         bool
	asrFactor                                      float64
	highLat                                        string
	adjust                                         map[string]float64
}

func resolveParams(c CalcSettings, date Date) params {
	m, ok := methods[c.Method]
	if !ok {
		m = methods["MWL"]
	}
	p := params{
		fajr: m.Fajr, isha: m.Isha, hasIsha: m.HasIsha, ishaMin: m.IshaMin, hasIshaMin: m.HasIshaMin,
		maghrib: m.Maghrib, hasMaghrib: m.HasMaghrib, jafari: m.Jafari,
		asrFactor: 1, highLat: c.HighLat, adjust: map[string]float64{},
	}
	if c.Asr == "hanafi" {
		p.asrFactor = 2
	}
	if p.highLat == "" {
		p.highLat = "angle"
	}
	if c.Method == "Custom" {
		get := func(v *float64, d float64) float64 {
			if v == nil || !finite(*v) {
				return d
			}
			return *v
		}
		p.fajr = get(c.Custom.Fajr, 18)
		if im := get(c.Custom.IshaMin, 0); im > 0 {
			p.ishaMin, p.hasIshaMin, p.hasIsha = im, true, false
		} else {
			p.isha, p.hasIsha, p.hasIshaMin = get(c.Custom.Isha, 17), true, false
		}
		if mm := get(c.Custom.MaghribMin, 0); mm > 0 {
			p.maghribMin, p.hasMaghribMin = mm, true
		}
	}
	if m.RamadanIshaMin > 0 && hijriArithmetic(date.Y, date.M, date.D).M == 9 {
		p.ishaMin, p.hasIshaMin = m.RamadanIshaMin, true
	}
	for _, k := range Prayers {
		p.adjust[k] = m.Adjust[k] + c.Adjust[k]
	}
	return p
}

type DayTimes map[string]int64 // Epoch-Millisekunden; 0 = nicht bestimmbar

func ComputeDay(date Date, lat, lon float64, c CalcSettings) DayTimes {
	out := computeDayAt(date, lat, lon, c)
	hl := c.HighLat
	if hl == "" {
		hl = "angle"
	}
	if hl != "none" && math.Abs(lat) > 65 && (out["sunrise"] == 0 || out["sunset"] == 0) {
		s := 1.0
		if lat < 0 {
			s = -1
		}
		return computeDayAt(date, s*65, lon, c)
	}
	return out
}

func computeDayAt(date Date, lat, lon float64, c CalcSettings) DayTimes {
	p := resolveParams(c, date)
	jDate := julian(date.Y, date.M, date.D) - lon/(15*24)
	midDay := func(t float64) float64 { _, eqt := sunPosition(jDate + t); return fixHour(12 - eqt) }
	sunAngleTime := func(angle, t float64, ccw bool) float64 {
		decl, _ := sunPosition(jDate + t)
		noon := midDay(t)
		x := (-dsin(angle) - dsin(decl)*dsin(lat)) / (dcos(decl) * dcos(lat))
		if !(x >= -1 && x <= 1) {
			return math.NaN()
		}
		T := darccos(x) / 15
		if ccw {
			return noon - T
		}
		return noon + T
	}
	asrTime := func(factor, t float64) float64 {
		decl, _ := sunPosition(jDate + t)
		angle := -darccot(factor + dtan(math.Abs(lat-decl)))
		return sunAngleTime(angle, t, false)
	}
	riseSet := 0.833
	t := map[string]float64{
		"fajr":    sunAngleTime(p.fajr, 5.0/24, true),
		"sunrise": sunAngleTime(riseSet, 6.0/24, true),
		"dhuhr":   midDay(12.0 / 24),
		"asr":     asrTime(p.asrFactor, 13.0/24),
		"sunset":  sunAngleTime(riseSet, 18.0/24, false),
		"maghrib": math.NaN(),
		"isha":    math.NaN(),
	}
	if p.hasMaghrib {
		t["maghrib"] = sunAngleTime(p.maghrib, 18.0/24, false)
	}
	if p.hasIsha {
		t["isha"] = sunAngleTime(p.isha, 18.0/24, false)
	}
	for k := range t {
		t[k] += -lon / 15
	}
	if !p.hasMaghrib {
		t["maghrib"] = t["sunset"]
	}
	if p.highLat != "none" && finite(t["sunrise"]) && finite(t["sunset"]) {
		night := timeDiff(t["sunset"], t["sunrise"])
		portion := func(angle float64) float64 {
			switch p.highLat {
			case "seventh":
				return night / 7
			case "middle":
				return night / 2
			}
			return angle / 60 * night
		}
		fp := portion(p.fajr)
		if !finite(t["fajr"]) || timeDiff(t["fajr"], t["sunrise"]) > fp {
			t["fajr"] = t["sunrise"] - fp
		}
		if p.hasIsha {
			ip := portion(p.isha)
			if !finite(t["isha"]) || timeDiff(t["sunset"], t["isha"]) > ip {
				t["isha"] = t["sunset"] + ip
			}
		}
		if p.hasMaghrib {
			mp := portion(p.maghrib)
			if !finite(t["maghrib"]) || timeDiff(t["sunset"], t["maghrib"]) > mp {
				t["maghrib"] = t["sunset"] + mp
			}
		}
	}
	if p.hasMaghribMin {
		t["maghrib"] = t["sunset"] + p.maghribMin/60
	}
	if p.hasIshaMin {
		t["isha"] = t["maghrib"] + p.ishaMin/60
	}
	nightEnd := t["sunrise"]
	if p.jafari {
		nightEnd = t["fajr"]
	}
	nightLen := timeDiff(t["sunset"], nightEnd)
	midnight := t["sunset"] + nightLen/2
	lastThird := t["sunset"] + nightLen*2/3
	for _, k := range Prayers {
		t[k] += p.adjust[k] / 60
	}
	base := float64(time.Date(date.Y, time.Month(date.M), date.D, 0, 0, 0, 0, time.UTC).UnixMilli())
	toEpoch := func(h float64) int64 {
		if !finite(h) {
			return 0
		}
		// gleiche Rundung wie Math.round in JS (halbe Minuten aufrunden)
		return int64(math.Floor((base+h*3600000)/60000+0.5)) * 60000
	}
	out := DayTimes{}
	for _, k := range Prayers {
		out[k] = toEpoch(t[k])
	}
	out["sunset"] = toEpoch(t["sunset"])
	out["midnight"] = toEpoch(midnight)
	out["lastThird"] = toEpoch(lastThird)
	if out["fajr"] != 0 {
		out["imsak"] = out["fajr"] - 10*60000
	}
	return out
}

type Event struct {
	Prayer string
	At     time.Time
}

// UpcomingEvents liefert alle Gebete ab `from` für die nächsten Tage (in der Zeitzone des Ortes).
func UpcomingEvents(lat, lon float64, loc *time.Location, c CalcSettings, from time.Time, days int) []Event {
	local := from.In(loc)
	var ev []Event
	for i := -1; i <= days; i++ {
		d := time.Date(local.Year(), local.Month(), local.Day()+i, 12, 0, 0, 0, time.UTC)
		dt := ComputeDay(Date{d.Year(), int(d.Month()), d.Day()}, lat, lon, c)
		for _, k := range Prayers {
			if ms := dt[k]; ms != 0 {
				at := time.UnixMilli(ms)
				if !at.Before(from) {
					ev = append(ev, Event{k, at})
				}
			}
		}
	}
	sort.Slice(ev, func(i, j int) bool { return ev[i].At.Before(ev[j].At) })
	return ev
}

func QiblaBearing(lat, lon float64) float64 {
	p1, p2, dl := lat*deg, Kaaba.Lat*deg, (Kaaba.Lon-lon)*deg
	b := math.Atan2(math.Sin(dl)*math.Cos(p2), math.Cos(p1)*math.Sin(p2)-math.Sin(p1)*math.Cos(p2)*math.Cos(dl))
	return fixAngle(b / deg)
}
