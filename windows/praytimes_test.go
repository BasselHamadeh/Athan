package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestMatchesJavaScript(t *testing.T) {
	raw, err := os.ReadFile("testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx []struct {
		Date     Date `json:"date"`
		Lat, Lon float64
		Calc     CalcSettings     `json:"calc"`
		Res      map[string]int64 `json:"res"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for _, f := range fx {
		got := ComputeDay(f.Date, f.Lat, f.Lon, f.Calc)
		for k, want := range f.Res {
			if got[k] != want {
				bad++
				if bad < 10 {
					t.Errorf("%+v %v/%v %s %s: got %d want %d (diff %ds)", f.Date, f.Lat, f.Lon, f.Calc.Method, k, got[k], want, (got[k]-want)/1000)
				}
			}
		}
	}
	t.Logf("%d Fälle verglichen, %d Abweichungen", len(fx), bad)
}

func TestHijri(t *testing.T) {
	if h := hijriArithmetic(2026, 2, 20); h.M != 9 || h.D != 3 || h.Y != 1447 {
		t.Fatalf("hijri %+v", h)
	}
}
