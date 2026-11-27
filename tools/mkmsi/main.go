// mkmsi baut ein Windows-Installer-Paket (.msi) ohne WiX: Compound File (MS-CFB),
// MSI-Datenbank (Stringpool, Tabellen) und eingebettetes CAB (MSZIP).
//
// Installation pro Benutzer (keine Admin-Rechte) nach %LOCALAPPDATA%\Programs\Athan,
// Startmenü- und Desktop-Verknüpfung, Autostart, Updates per UpgradeCode, Start nach Installation.
//
//	go run ./mkmsi -exe ../dist/Athan.exe -version 1.0.0 -out ../dist/Athan-Setup-1.0.0.msi
package main

import (
	"bytes"
	"compress/flate"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

const upgradeCode = "{6B1D3A54-2F0E-4C8B-9A61-7E35C2D4A9F1}"

var (
	cabMode = "none"
	cabCsum = true
)

func main() {
	exe := flag.String("exe", "Athan.exe", "Programmdatei")
	ver := flag.String("version", "1.0.0", "Version (x.y.z)")
	out := flag.String("out", "Athan-Setup.msi", "Ausgabe")
	flag.StringVar(&cabMode, "cabmode", "none", "CAB-Kompression: fixed | flate | stored | none")
	flag.BoolVar(&cabCsum, "csum", true, "CAB-Prüfsummen berechnen")
	cabOut := flag.String("cabout", "", "nur das CAB schreiben (Diagnose)")
	flag.Parse()

	data, err := os.ReadFile(*exe)
	if err != nil {
		log.Fatal(err)
	}
	now := time.Now()
	cab := buildCab([]cabFile{{name: "AthanExe", data: data}}, now)
	if *cabOut != "" {
		if err := os.WriteFile(*cabOut, cab, 0o644); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%s: %d KB (%s, Prüfsumme %v)\n", *cabOut, len(cab)/1024, cabMode, cabCsum)
		return
	}
	db := buildDatabase(*ver, len(data))
	streams := db.streams()
	streams = append(streams, stream{name: mangle("athan.cab", false), data: cab})
	streams = append(streams, stream{name: "\x05SummaryInformation", data: summaryInfo(*ver, now)})
	cfb := buildCFB(streams)
	if err := os.WriteFile(*out, cfb, 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s: %d KB (Programm %d KB, CAB %d KB)\n", *out, len(cfb)/1024, len(data)/1024, len(cab)/1024)
}

// ======================= MSI-Datenbank =======================

type colType uint16

const (
	tValid     = 0x0100
	tLocal     = 0x0200
	tNonBinary = 0x0400
	tString    = 0x0800
	tNullable  = 0x1000
	tKey       = 0x2000
)

func s(n int) colType            { return colType(tValid | tString | tNonBinary | n) }
func l(n int) colType            { return colType(tValid | tString | tNonBinary | tLocal | n) }
func i2() colType                { return colType(tValid | tNonBinary | 2) }
func i4() colType                { return colType(tValid | 4) }
func (c colType) N() colType     { return c | tNullable }
func (c colType) K() colType     { return c | tKey }
func (c colType) isString() bool { return c&tString != 0 }
func (c colType) width() int {
	if c.isString() || c&0xff == 2 {
		return 2
	}
	return 4
}

type column struct {
	name string
	typ  colType
}
type table struct {
	name string
	cols []column
	rows [][]any // string, int, nil
}

type database struct {
	tables []*table
	strs   []string
	ids    map[string]int
	refs   map[int]int
}

func (d *database) add(name string, cols []column, rows ...[]any) {
	d.tables = append(d.tables, &table{name, cols, rows})
}

func (d *database) intern(v string) int {
	if v == "" {
		return 0
	}
	id, ok := d.ids[v]
	if !ok {
		log.Fatalf("String nicht im Pool: %q", v)
	}
	d.refs[id]++
	return id
}

// assignIDs vergibt String-IDs in alphabetischer Reihenfolge – so ist die Sortierung
// nach ID identisch mit der nach Text.
func (d *database) assignIDs() {
	set := map[string]bool{}
	for _, t := range d.tables {
		set[t.name] = true
		for _, c := range t.cols {
			set[c.name] = true
		}
		for _, row := range t.rows {
			for _, v := range row {
				if x, ok := v.(string); ok && x != "" {
					set[x] = true
				}
			}
		}
	}
	for k := range set {
		d.strs = append(d.strs, k)
	}
	sort.Strings(d.strs)
	for i, k := range d.strs {
		d.ids[k] = i + 1
	}
}

func guidFrom(parts ...string) string {
	h := sha1.Sum([]byte(strings.Join(parts, "|")))
	h[6] = (h[6] & 0x0f) | 0x50
	h[8] = (h[8] & 0x3f) | 0x80
	return strings.ToUpper(fmt.Sprintf("{%x-%x-%x-%x-%x}", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16]))
}
func randomGUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return strings.ToUpper(fmt.Sprintf("{%x-%x-%x-%x-%x}", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]))
}

func buildDatabase(ver string, exeSize int) *database {
	d := &database{ids: map[string]int{}, refs: map[int]int{}}
	productCode := guidFrom(upgradeCode, "product", ver)
	fileVer := ver
	if strings.Count(fileVer, ".") < 3 {
		fileVer += strings.Repeat(".0", 3-strings.Count(fileVer, "."))
	}
	desc := "Gebetszeiten, Athan und Qibla"

	d.add("Property", []column{{"Property", s(72).K()}, {"Value", l(0)}},
		[]any{"ProductCode", productCode},
		[]any{"ProductName", "Athan"},
		[]any{"ProductVersion", ver},
		[]any{"ProductLanguage", "1031"},
		[]any{"Manufacturer", "Athan"},
		[]any{"UpgradeCode", upgradeCode},
		[]any{"ARPNOMODIFY", "1"},
		[]any{"ARPCOMMENTS", desc + " – ohne Werbung"},
		[]any{"SecureCustomProperties", "OLDERFOUND"},
		[]any{"DISABLEADVTSHORTCUTS", "1"},
	)
	d.add("Directory", []column{{"Directory", s(72).K()}, {"Directory_Parent", s(72).N()}, {"DefaultDir", l(255)}},
		[]any{"TARGETDIR", nil, "SourceDir"},
		[]any{"LocalAppDataFolder", "TARGETDIR", "."},
		[]any{"UserPrograms", "LocalAppDataFolder", "Programs"},
		[]any{"INSTALLDIR", "UserPrograms", "Athan"},
		[]any{"ProgramMenuFolder", "TARGETDIR", "."},
		[]any{"DesktopFolder", "TARGETDIR", "."},
	)
	d.add("Component", []column{{"Component", s(72).K()}, {"ComponentId", s(38).N()}, {"Directory_", s(72)}, {"Attributes", i2()}, {"Condition", s(255).N()}, {"KeyPath", s(72).N()}},
		[]any{"MainExe", guidFrom(upgradeCode, "comp-exe"), "INSTALLDIR", 0, nil, "AthanExe"},
		[]any{"Shortcuts", guidFrom(upgradeCode, "comp-shortcuts"), "INSTALLDIR", 4, nil, "RegShortcuts"},
		[]any{"Autostart", guidFrom(upgradeCode, "comp-autostart"), "INSTALLDIR", 4, nil, "RegAutostart"},
	)
	d.add("Feature", []column{{"Feature", s(38).K()}, {"Feature_Parent", s(38).N()}, {"Title", l(64).N()}, {"Description", l(255).N()}, {"Display", i2().N()}, {"Level", i2()}, {"Directory_", s(72).N()}, {"Attributes", i2()}},
		[]any{"Main", nil, "Athan", desc, 1, 1, "INSTALLDIR", 16},
	)
	d.add("FeatureComponents", []column{{"Feature_", s(38).K()}, {"Component_", s(72).K()}},
		[]any{"Main", "MainExe"}, []any{"Main", "Shortcuts"}, []any{"Main", "Autostart"},
	)
	d.add("File", []column{{"File", s(72).K()}, {"Component_", s(72)}, {"FileName", l(255)}, {"FileSize", i4()}, {"Version", s(72).N()}, {"Language", s(20).N()}, {"Attributes", i2().N()}, {"Sequence", i2()}},
		[]any{"AthanExe", "MainExe", "ATHAN.EXE|Athan.exe", exeSize, fileVer, "0", 512, 1},
	)
	d.add("Media", []column{{"DiskId", i2().K()}, {"LastSequence", i2()}, {"DiskPrompt", l(64).N()}, {"Cabinet", s(255).N()}, {"VolumeLabel", s(32).N()}, {"Source", s(72).N()}},
		[]any{1, 1, nil, "#athan.cab", nil, nil},
	)
	d.add("Shortcut", []column{{"Shortcut", s(72).K()}, {"Directory_", s(72)}, {"Name", l(128)}, {"Component_", s(72)}, {"Target", s(72)}, {"Arguments", s(255).N()}, {"Description", l(255).N()}, {"Hotkey", i2().N()}, {"Icon_", s(72).N()}, {"IconIndex", i2().N()}, {"ShowCmd", i2().N()}, {"WkDir", s(72).N()}},
		[]any{"StartMenuShortcut", "ProgramMenuFolder", "ATHAN|Athan", "Shortcuts", "[#AthanExe]", nil, desc, nil, nil, nil, nil, "INSTALLDIR"},
		[]any{"DesktopShortcut", "DesktopFolder", "ATHAN|Athan", "Shortcuts", "[#AthanExe]", nil, desc, nil, nil, nil, nil, "INSTALLDIR"},
	)
	d.add("Registry", []column{{"Registry", s(72).K()}, {"Root", i2()}, {"Key", l(255)}, {"Name", l(255).N()}, {"Value", l(0).N()}, {"Component_", s(72)}},
		[]any{"RegShortcuts", 1, `Software\Athan`, "Shortcuts", "1", "Shortcuts"},
		[]any{"RegAutostart", 1, `Software\Athan`, "Autostart", "1", "Autostart"},
		[]any{"RegRun", 1, `Software\Microsoft\Windows\CurrentVersion\Run`, "Athan", `"[#AthanExe]" --background`, "Autostart"},
		[]any{"RegInstallDir", 1, `Software\Athan`, "InstallDir", "[INSTALLDIR]", "Shortcuts"},
	)
	d.add("Upgrade", []column{{"UpgradeCode", s(38).K()}, {"VersionMin", s(20).N().K()}, {"VersionMax", s(20).N().K()}, {"Language", s(255).N().K()}, {"Attributes", i4().K()}, {"Remove", s(255).N()}, {"ActionProperty", s(72)}},
		[]any{upgradeCode, "0.0.0", ver, nil, 256 | 512, nil, "OLDERFOUND"},
	)
	d.add("CustomAction", []column{{"Action", s(72).K()}, {"Type", i2()}, {"Source", s(72).N()}, {"Target", s(255).N()}},
		[]any{"LaunchAthan", 18 | 192, "AthanExe", "--installed"},
	)
	seq := []column{{"Action", s(72).K()}, {"Condition", s(255).N()}, {"Sequence", i2().N()}}
	d.add("InstallExecuteSequence", seq,
		[]any{"FindRelatedProducts", nil, 25},
		[]any{"ValidateProductID", nil, 700},
		[]any{"CostInitialize", nil, 800},
		[]any{"FileCost", nil, 900},
		[]any{"CostFinalize", nil, 1000},
		[]any{"InstallValidate", nil, 1400},
		[]any{"RemoveExistingProducts", nil, 1401},
		[]any{"InstallInitialize", nil, 1500},
		[]any{"ProcessComponents", nil, 1600},
		[]any{"UnpublishFeatures", nil, 1800},
		[]any{"RemoveRegistryValues", nil, 2600},
		[]any{"RemoveShortcuts", nil, 3200},
		[]any{"RemoveFiles", nil, 3500},
		[]any{"InstallFiles", nil, 4000},
		[]any{"CreateShortcuts", nil, 4500},
		[]any{"WriteRegistryValues", nil, 5000},
		[]any{"RegisterUser", nil, 6000},
		[]any{"RegisterProduct", nil, 6100},
		[]any{"PublishFeatures", nil, 6300},
		[]any{"PublishProduct", nil, 6400},
		[]any{"InstallFinalize", nil, 6600},
	)
	d.add("InstallUISequence", seq,
		[]any{"FindRelatedProducts", nil, 25},
		[]any{"CostInitialize", nil, 800},
		[]any{"FileCost", nil, 900},
		[]any{"CostFinalize", nil, 1000},
		[]any{"ExecuteAction", nil, 1300},
		[]any{"LaunchAthan", "NOT Installed AND NOT REMOVE", 1301},
	)
	return d
}

type stream struct {
	name string
	data []byte
}

// streams erzeugt _StringPool, _StringData, _Tables, _Columns und je Tabelle einen Datenstrom.
func (d *database) streams() []stream {
	sort.Slice(d.tables, func(i, j int) bool { return d.tables[i].name < d.tables[j].name })
	d.assignIDs()
	tableIDs := make([]int, len(d.tables))
	for i, t := range d.tables {
		tableIDs[i] = d.intern(t.name)
	}
	type colRow struct{ table, num, name, typ int }
	var colRows []colRow
	for i, t := range d.tables {
		for n, c := range t.cols {
			d.refs[tableIDs[i]]++
			colRows = append(colRows, colRow{tableIDs[i], n + 1, d.intern(c.name), int(c.typ)})
		}
	}
	var out []stream
	for _, t := range d.tables {
		// Werte in gespeicherte Form bringen
		enc := make([][]uint32, len(t.rows))
		for r, row := range t.rows {
			if len(row) != len(t.cols) {
				log.Fatalf("%s: Zeile %d hat %d statt %d Spalten", t.name, r, len(row), len(t.cols))
			}
			enc[r] = make([]uint32, len(t.cols))
			for c, v := range row {
				ct := t.cols[c].typ
				switch x := v.(type) {
				case nil:
					if ct&tNullable == 0 {
						log.Fatalf("%s.%s darf nicht leer sein", t.name, t.cols[c].name)
					}
					enc[r][c] = 0
				case string:
					if !ct.isString() {
						log.Fatalf("%s.%s erwartet Zahl", t.name, t.cols[c].name)
					}
					if _, err := cp1252(x); err != nil {
						log.Fatalf("%s.%s: %v", t.name, t.cols[c].name, err)
					}
					enc[r][c] = uint32(d.intern(x))
				case int:
					if ct.isString() {
						log.Fatalf("%s.%s erwartet Text", t.name, t.cols[c].name)
					}
					if ct.width() == 2 {
						if x < -32767 || x > 32767 {
							log.Fatalf("%s.%s: %d außerhalb i2", t.name, t.cols[c].name, x)
						}
						enc[r][c] = uint32(uint16(x + 0x8000))
					} else {
						enc[r][c] = uint32(int32(x)) ^ 0x80000000
					}
				}
			}
		}
		// nach Primärschlüssel sortieren (gespeicherte Werte)
		var keys []int
		for c, col := range t.cols {
			if col.typ&tKey != 0 {
				keys = append(keys, c)
			}
		}
		sort.SliceStable(enc, func(a, b int) bool {
			for _, k := range keys {
				if enc[a][k] != enc[b][k] {
					return enc[a][k] < enc[b][k]
				}
			}
			return false
		})
		var buf bytes.Buffer
		for c, col := range t.cols {
			for r := range enc {
				if col.typ.width() == 2 {
					binary.Write(&buf, binary.LittleEndian, uint16(enc[r][c]))
				} else {
					binary.Write(&buf, binary.LittleEndian, enc[r][c])
				}
			}
		}
		out = append(out, stream{mangle(t.name, true), buf.Bytes()})
	}
	if len(d.strs) > 0xffff {
		log.Fatal("zu viele Strings")
	}
	// _Tables
	var tb bytes.Buffer
	for _, id := range tableIDs {
		binary.Write(&tb, binary.LittleEndian, uint16(id))
	}
	// _Columns (spaltenweise: Table, Number, Name, Type)
	sort.SliceStable(colRows, func(a, b int) bool {
		if colRows[a].table != colRows[b].table {
			return colRows[a].table < colRows[b].table
		}
		return colRows[a].num < colRows[b].num
	})
	var cb bytes.Buffer
	for _, r := range colRows {
		binary.Write(&cb, binary.LittleEndian, uint16(r.table))
	}
	for _, r := range colRows {
		binary.Write(&cb, binary.LittleEndian, uint16(r.num+0x8000))
	}
	for _, r := range colRows {
		binary.Write(&cb, binary.LittleEndian, uint16(r.name))
	}
	for _, r := range colRows {
		binary.Write(&cb, binary.LittleEndian, uint16(r.typ+0x8000))
	}
	// Stringpool (Codepage 1252) + Stringdaten
	var pool, sdata bytes.Buffer
	binary.Write(&pool, binary.LittleEndian, []uint16{1252, 0})
	for i, str := range d.strs {
		b, _ := cp1252(str)
		if len(b) > 0xffff {
			log.Fatal("String zu lang")
		}
		binary.Write(&pool, binary.LittleEndian, []uint16{uint16(len(b)), uint16(d.refs[i+1])})
		sdata.Write(b)
	}
	out = append(out,
		stream{mangle("_StringPool", true), pool.Bytes()},
		stream{mangle("_StringData", true), sdata.Bytes()},
		stream{mangle("_Tables", true), tb.Bytes()},
		stream{mangle("_Columns", true), cb.Bytes()},
	)
	return out
}

var cp1252Extra = map[rune]byte{'€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95}

func cp1252(s string) ([]byte, error) {
	var b []byte
	for _, r := range s {
		switch {
		case r < 0x80 || (r >= 0xA0 && r <= 0xFF):
			b = append(b, byte(r))
		case cp1252Extra[r] != 0:
			b = append(b, cp1252Extra[r])
		default:
			return nil, fmt.Errorf("Zeichen %q nicht in Codepage 1252", r)
		}
	}
	return b, nil
}

// mangle kodiert Stream-Namen wie Windows Installer (zwei Zeichen pro UTF-16-Einheit).
func mangle(name string, isTable bool) string {
	idx := func(c rune) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'A' && c <= 'Z':
			return int(c-'A') + 10
		case c >= 'a' && c <= 'z':
			return int(c-'a') + 36
		case c == '.':
			return 62
		case c == '_':
			return 63
		}
		return -1
	}
	var out []uint16
	if isTable {
		out = append(out, 0x4840)
	}
	rs := []rune(name)
	for i := 0; i < len(rs); i++ {
		a := idx(rs[i])
		if a < 0 {
			out = append(out, uint16(rs[i]))
			continue
		}
		if i+1 < len(rs) {
			if b := idx(rs[i+1]); b >= 0 {
				out = append(out, uint16(0x3800+a+(b<<6)))
				i++
				continue
			}
		}
		out = append(out, uint16(0x4800+a))
	}
	return string(utf16.Decode(out))
}

// ======================= Summary Information =======================

func summaryInfo(ver string, t time.Time) []byte {
	ft := uint64(t.UnixNano()/100) + 116444736000000000
	type prop struct {
		id  uint32
		val []byte
	}
	lpstr := func(s string) []byte {
		b, _ := cp1252(s)
		b = append(b, 0)
		var v bytes.Buffer
		binary.Write(&v, binary.LittleEndian, uint32(30))
		binary.Write(&v, binary.LittleEndian, uint32(len(b)))
		v.Write(b)
		for v.Len()%4 != 0 {
			v.WriteByte(0)
		}
		return v.Bytes()
	}
	i4v := func(n int32) []byte {
		var v bytes.Buffer
		binary.Write(&v, binary.LittleEndian, uint32(3))
		binary.Write(&v, binary.LittleEndian, n)
		return v.Bytes()
	}
	i2v := func(n int16) []byte {
		var v bytes.Buffer
		binary.Write(&v, binary.LittleEndian, uint32(2))
		binary.Write(&v, binary.LittleEndian, n)
		binary.Write(&v, binary.LittleEndian, uint16(0))
		return v.Bytes()
	}
	ftv := func() []byte {
		var v bytes.Buffer
		binary.Write(&v, binary.LittleEndian, uint32(64))
		binary.Write(&v, binary.LittleEndian, ft)
		return v.Bytes()
	}
	props := []prop{
		{1, i2v(1252)},
		{2, lpstr("Installationsdatenbank")},
		{3, lpstr("Athan " + ver)},
		{4, lpstr("Athan")},
		{5, lpstr("Installer, Athan, Gebetszeiten")},
		{6, lpstr("Gebetszeiten, Athan und Qibla für Windows")},
		{7, lpstr("Intel;1031")},
		{9, lpstr(randomGUID())},
		{12, ftv()},
		{13, ftv()},
		{14, i4v(500)},
		{15, i4v(2 | 8)}, // komprimiert, keine Erhöhung der Rechte nötig
		{18, lpstr("Athan mkmsi")},
		{19, i4v(2)},
	}
	var body bytes.Buffer
	offsets := make([]uint32, len(props))
	hdr := 8 + 8*len(props)
	for i, p := range props {
		offsets[i] = uint32(hdr + body.Len())
		body.Write(p.val)
	}
	var sec bytes.Buffer
	binary.Write(&sec, binary.LittleEndian, uint32(hdr+body.Len()))
	binary.Write(&sec, binary.LittleEndian, uint32(len(props)))
	for i, p := range props {
		binary.Write(&sec, binary.LittleEndian, p.id)
		binary.Write(&sec, binary.LittleEndian, offsets[i])
	}
	sec.Write(body.Bytes())

	var f bytes.Buffer
	binary.Write(&f, binary.LittleEndian, []uint16{0xFFFE, 0})
	binary.Write(&f, binary.LittleEndian, uint32(0x00020006))
	f.Write(make([]byte, 16))
	binary.Write(&f, binary.LittleEndian, uint32(1))
	f.Write([]byte{0xE0, 0x85, 0x9F, 0xF2, 0xF9, 0x4F, 0x68, 0x10, 0xAB, 0x91, 0x08, 0x00, 0x2B, 0x27, 0xB3, 0xD9})
	binary.Write(&f, binary.LittleEndian, uint32(48))
	f.Write(sec.Bytes())
	return f.Bytes()
}

// ======================= CAB (MSZIP) =======================

type cabFile struct {
	name string
	data []byte
}

func buildCab(files []cabFile, t time.Time) []byte {
	var all []byte
	for _, f := range files {
		all = append(all, f.data...)
	}
	// Datenblöcke à 32 KB, jeder als eigener Deflate-Strom mit "CK"-Kennung
	var blocks [][]byte
	var sizes []int
	for off := 0; off < len(all); off += 32768 {
		end := min(off+32768, len(all))
		blocks = append(blocks, compressBlock(all[off:end]))
		sizes = append(sizes, end-off)
	}
	dosDate := uint16((t.Year()-1980)<<9 | int(t.Month())<<5 | t.Day())
	dosTime := uint16(t.Hour()<<11 | t.Minute()<<5 | t.Second()/2)

	hdrSize := 36
	folderSize := 8
	var fileEntries bytes.Buffer
	var uoff uint32
	for _, f := range files {
		binary.Write(&fileEntries, binary.LittleEndian, uint32(len(f.data)))
		binary.Write(&fileEntries, binary.LittleEndian, uoff)
		binary.Write(&fileEntries, binary.LittleEndian, uint16(0)) // Ordner 0
		binary.Write(&fileEntries, binary.LittleEndian, dosDate)
		binary.Write(&fileEntries, binary.LittleEndian, dosTime)
		binary.Write(&fileEntries, binary.LittleEndian, uint16(0x20)) // Archiv
		fileEntries.WriteString(f.name)
		fileEntries.WriteByte(0)
		uoff += uint32(len(f.data))
	}
	dataStart := hdrSize + folderSize + fileEntries.Len()
	total := dataStart
	for _, b := range blocks {
		total += 8 + len(b)
	}
	var c bytes.Buffer
	c.WriteString("MSCF")
	binary.Write(&c, binary.LittleEndian, uint32(0))
	binary.Write(&c, binary.LittleEndian, uint32(total))
	binary.Write(&c, binary.LittleEndian, uint32(0))
	binary.Write(&c, binary.LittleEndian, uint32(hdrSize+folderSize)) // coffFiles
	binary.Write(&c, binary.LittleEndian, uint32(0))
	c.Write([]byte{3, 1})                                      // Version 1.3
	binary.Write(&c, binary.LittleEndian, uint16(1))           // Ordner
	binary.Write(&c, binary.LittleEndian, uint16(len(files)))  // Dateien
	binary.Write(&c, binary.LittleEndian, uint16(0))           // Flags
	binary.Write(&c, binary.LittleEndian, uint16(0x4154))      // setID
	binary.Write(&c, binary.LittleEndian, uint16(0))           // iCabinet
	binary.Write(&c, binary.LittleEndian, uint32(dataStart))   // CFFOLDER.coffCabStart
	binary.Write(&c, binary.LittleEndian, uint16(len(blocks))) // cCFData
	compType := uint16(1)                                      // MSZIP
	if cabMode == "none" {
		compType = 0
	}
	binary.Write(&c, binary.LittleEndian, compType)
	c.Write(fileEntries.Bytes())
	for i, b := range blocks {
		sum := uint32(0)
		if cabCsum {
			sum = cabChecksum(b, uint16(len(b)), uint16(sizes[i]))
		}
		binary.Write(&c, binary.LittleEndian, sum)
		binary.Write(&c, binary.LittleEndian, uint16(len(b)))
		binary.Write(&c, binary.LittleEndian, uint16(sizes[i]))
		c.Write(b)
	}
	return c.Bytes()
}

// compressBlock erzeugt einen CFDATA-Block. Standard: eigener Deflate-Kodierer mit festen
// Huffman-Codes (ein abgeschlossener BFINAL-Block je CFDATA) – so, wie der Windows-Entpacker
// es sicher versteht.
func compressBlock(data []byte) []byte {
	switch cabMode {
	case "none":
		return append([]byte(nil), data...)
	case "stored":
		b := []byte{'C', 'K', 1, byte(len(data)), byte(len(data) >> 8), ^byte(len(data)), ^byte(len(data) >> 8)}
		return append(b, data...)
	case "flate":
		var b bytes.Buffer
		b.WriteString("CK")
		w, _ := flate.NewWriter(&b, flate.BestCompression)
		w.Write(data)
		w.Close()
		return b.Bytes()
	}
	return append([]byte{'C', 'K'}, deflateFixed(data)...)
}

type bitWriter struct {
	buf []byte
	acc uint64
	n   uint
}

func (w *bitWriter) bits(v uint32, n uint) {
	w.acc |= uint64(v) << w.n
	w.n += n
	for w.n >= 8 {
		w.buf = append(w.buf, byte(w.acc))
		w.acc >>= 8
		w.n -= 8
	}
}

// huff schreibt einen Huffman-Code (MSB zuerst, wie RFC 1951 verlangt).
func (w *bitWriter) huff(code uint32, n uint) {
	var r uint32
	for i := uint(0); i < n; i++ {
		r = r<<1 | (code>>i)&1
	}
	w.bits(r, n)
}

func (w *bitWriter) flush() []byte {
	if w.n > 0 {
		w.buf = append(w.buf, byte(w.acc))
		w.acc, w.n = 0, 0
	}
	return w.buf
}

var (
	lenBase   = [29]int{3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258}
	lenExtra  = [29]uint{0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0}
	distBase  = [30]int{1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577}
	distExtra = [30]uint{0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13}
)

func fixedSym(w *bitWriter, sym int) {
	switch {
	case sym <= 143:
		w.huff(uint32(0x30+sym), 8)
	case sym <= 255:
		w.huff(uint32(0x190+sym-144), 9)
	case sym <= 279:
		w.huff(uint32(sym-256), 7)
	default:
		w.huff(uint32(0xC0+sym-280), 8)
	}
}

// deflateFixed: LZ77 (Hash-Ketten) + feste Huffman-Codes, ein einziger Block mit BFINAL.
func deflateFixed(data []byte) []byte {
	w := &bitWriter{}
	w.bits(1, 1) // BFINAL
	w.bits(1, 2) // BTYPE = 01 (fest)
	const hbits = 15
	head := make([]int32, 1<<hbits)
	for i := range head {
		head[i] = -1
	}
	prev := make([]int32, len(data))
	hash := func(p int) int { return (int(data[p])<<10 ^ int(data[p+1])<<5 ^ int(data[p+2])) & (1<<hbits - 1) }
	insert := func(p int) {
		if p+2 < len(data) {
			h := hash(p)
			prev[p] = head[h]
			head[h] = int32(p)
		}
	}
	for i := 0; i < len(data); {
		bestLen, bestDist := 0, 0
		if i+2 < len(data) {
			maxLen := min(258, len(data)-i)
			for j, steps := head[hash(i)], 0; j >= 0 && i-int(j) <= 32768 && steps < 128; j, steps = prev[j], steps+1 {
				k := 0
				for k < maxLen && data[int(j)+k] == data[i+k] {
					k++
				}
				if k > bestLen {
					bestLen, bestDist = k, i-int(j)
					if k == maxLen {
						break
					}
				}
			}
		}
		if bestLen >= 3 {
			li := 28
			for lenBase[li] > bestLen {
				li--
			}
			fixedSym(w, 257+li)
			w.bits(uint32(bestLen-lenBase[li]), lenExtra[li])
			di := 29
			for distBase[di] > bestDist {
				di--
			}
			w.huff(uint32(di), 5)
			w.bits(uint32(bestDist-distBase[di]), distExtra[di])
			for k := 0; k < bestLen; k++ {
				insert(i + k)
			}
			i += bestLen
		} else {
			fixedSym(w, int(data[i]))
			insert(i)
			i++
		}
	}
	fixedSym(w, 256) // Blockende
	return w.flush()
}

// cabChecksum nach MS-CAB (wie libmspack): XOR über 32-Bit-Wörter, Restbytes in umgekehrter Folge.
func cabChecksum(data []byte, cbData, cbUncomp uint16) uint32 {
	compute := func(b []byte, seed uint32) uint32 {
		csum := seed
		n := len(b) / 4
		for i := 0; i < n; i++ {
			csum ^= binary.LittleEndian.Uint32(b[i*4:])
		}
		var ul uint32
		rest := b[n*4:]
		switch len(rest) {
		case 3:
			ul = uint32(rest[0])<<16 | uint32(rest[1])<<8 | uint32(rest[2])
		case 2:
			ul = uint32(rest[0])<<8 | uint32(rest[1])
		case 1:
			ul = uint32(rest[0])
		}
		return csum ^ ul
	}
	var hdr [4]byte
	binary.LittleEndian.PutUint16(hdr[0:], cbData)
	binary.LittleEndian.PutUint16(hdr[2:], cbUncomp)
	return compute(hdr[:], compute(data, 0))
}

// ======================= Compound File (MS-CFB v3) =======================

const (
	secSize   = 512
	miniSize  = 64
	cutoff    = 4096
	endChain  = 0xFFFFFFFE
	freeSect  = 0xFFFFFFFF
	fatSect   = 0xFFFFFFFD
	difSect   = 0xFFFFFFFC
	noStream  = 0xFFFFFFFF
	entrySize = 128
)

func cfbLess(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	if len(ua) != len(ub) {
		return len(ua) < len(ub)
	}
	for i := range ua {
		ca, cb := uint16(unicode.ToUpper(rune(ua[i]))), uint16(unicode.ToUpper(rune(ub[i])))
		if ca != cb {
			return ca < cb
		}
	}
	return false
}

func buildCFB(streams []stream) []byte {
	sort.Slice(streams, func(i, j int) bool { return cfbLess(streams[i].name, streams[j].name) })
	for i := 1; i < len(streams); i++ {
		if !cfbLess(streams[i-1].name, streams[i].name) {
			log.Fatalf("doppelter Stream-Name %q", streams[i].name)
		}
	}
	for _, s := range streams {
		if len(utf16.Encode([]rune(s.name))) > 31 {
			log.Fatalf("Stream-Name zu lang: %q", s.name)
		}
	}
	n := len(streams)
	start := make([]uint32, n)

	// Mini-Stream für kleine Ströme
	var mini bytes.Buffer
	var miniFAT []uint32
	for i, s := range streams {
		if len(s.data) >= cutoff || len(s.data) == 0 {
			continue
		}
		first := uint32(len(miniFAT))
		cnt := (len(s.data) + miniSize - 1) / miniSize
		for k := 0; k < cnt; k++ {
			if k == cnt-1 {
				miniFAT = append(miniFAT, endChain)
			} else {
				miniFAT = append(miniFAT, first+uint32(k)+1)
			}
		}
		start[i] = first
		mini.Write(s.data)
		for mini.Len()%miniSize != 0 {
			mini.WriteByte(0)
		}
	}

	var sectors [][]byte
	var fat []uint32
	alloc := func(data []byte) uint32 {
		if len(data) == 0 {
			return endChain
		}
		first := uint32(len(sectors))
		cnt := (len(data) + secSize - 1) / secSize
		for k := 0; k < cnt; k++ {
			sec := make([]byte, secSize)
			copy(sec, data[k*secSize:])
			sectors = append(sectors, sec)
			if k == cnt-1 {
				fat = append(fat, endChain)
			} else {
				fat = append(fat, first+uint32(k)+1)
			}
		}
		return first
	}
	for i, s := range streams {
		if len(s.data) >= cutoff {
			start[i] = alloc(s.data)
		} else if len(s.data) == 0 {
			start[i] = endChain
		}
	}
	miniStart := alloc(mini.Bytes())
	var mf bytes.Buffer
	binary.Write(&mf, binary.LittleEndian, miniFAT)
	for mf.Len()%secSize != 0 {
		binary.Write(&mf, binary.LittleEndian, uint32(freeSect))
	}
	miniFATStart := alloc(mf.Bytes())
	miniFATCount := mf.Len() / secSize
	if len(miniFAT) == 0 {
		miniFATStart, miniFATCount = endChain, 0
	}

	// Verzeichnis: Root + Ströme als ausgewogener Binärbaum (alle schwarz)
	left := make([]uint32, n+1)
	right := make([]uint32, n+1)
	for i := range left {
		left[i], right[i] = noStream, noStream
	}
	var build func(lo, hi int) uint32
	build = func(lo, hi int) uint32 {
		if lo > hi {
			return noStream
		}
		mid := (lo + hi) / 2
		left[mid+1] = build(lo, mid-1)
		right[mid+1] = build(mid+1, hi)
		return uint32(mid + 1)
	}
	rootChild := build(0, n-1)
	entries := n + 1
	dirSectors := (entries*entrySize + secSize - 1) / secSize
	dir := make([]byte, dirSectors*secSize)
	writeEntry := func(idx int, name string, typ byte, l, r, child, startSec uint32, size uint64, clsid []byte) {
		e := dir[idx*entrySize : (idx+1)*entrySize]
		u := utf16.Encode([]rune(name))
		for k, c := range u {
			binary.LittleEndian.PutUint16(e[k*2:], c)
		}
		binary.LittleEndian.PutUint16(e[64:], uint16((len(u)+1)*2))
		e[66] = typ
		e[67] = 1 // schwarz
		binary.LittleEndian.PutUint32(e[68:], l)
		binary.LittleEndian.PutUint32(e[72:], r)
		binary.LittleEndian.PutUint32(e[76:], child)
		copy(e[80:96], clsid)
		binary.LittleEndian.PutUint32(e[116:], startSec)
		binary.LittleEndian.PutUint64(e[120:], size)
	}
	msiCLSID := []byte{0x84, 0x10, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}
	miniStreamSize := uint64(mini.Len())
	if mini.Len() == 0 {
		miniStart = endChain
	}
	writeEntry(0, "Root Entry", 5, noStream, noStream, rootChild, miniStart, miniStreamSize, msiCLSID)
	for i, s := range streams {
		writeEntry(i+1, s.name, 2, left[i+1], right[i+1], noStream, start[i], uint64(len(s.data)), nil)
	}
	for idx := entries; idx < dirSectors*secSize/entrySize; idx++ {
		e := dir[idx*entrySize : (idx+1)*entrySize]
		binary.LittleEndian.PutUint32(e[68:], noStream)
		binary.LittleEndian.PutUint32(e[72:], noStream)
		binary.LittleEndian.PutUint32(e[76:], noStream)
	}
	dirStart := alloc(dir)

	// FAT- und DIFAT-Sektoren
	base := len(sectors)
	nFAT, nDIF := 0, 0
	for {
		total := base + nFAT + nDIF
		needFAT := (total + 127) / 128
		needDIF := 0
		if needFAT > 109 {
			needDIF = (needFAT - 109 + 126) / 127
		}
		if needFAT == nFAT && needDIF == nDIF {
			break
		}
		nFAT, nDIF = needFAT, needDIF
	}
	fatStart := uint32(base)
	difStart := uint32(base + nFAT)
	for k := 0; k < nFAT; k++ {
		fat = append(fat, fatSect)
	}
	for k := 0; k < nDIF; k++ {
		fat = append(fat, difSect)
	}
	for len(fat) < nFAT*128 {
		fat = append(fat, freeSect)
	}
	var fatBytes bytes.Buffer
	binary.Write(&fatBytes, binary.LittleEndian, fat)
	fb := fatBytes.Bytes()
	for k := 0; k < nFAT; k++ {
		sectors = append(sectors, fb[k*secSize:(k+1)*secSize])
	}
	fatLocs := make([]uint32, nFAT)
	for k := range fatLocs {
		fatLocs[k] = fatStart + uint32(k)
	}
	for k := 0; k < nDIF; k++ {
		sec := make([]byte, secSize)
		for j := 0; j < 127; j++ {
			idx := 109 + k*127 + j
			v := uint32(freeSect)
			if idx < nFAT {
				v = fatLocs[idx]
			}
			binary.LittleEndian.PutUint32(sec[j*4:], v)
		}
		next := uint32(endChain)
		if k+1 < nDIF {
			next = difStart + uint32(k+1)
		}
		binary.LittleEndian.PutUint32(sec[508:], next)
		sectors = append(sectors, sec)
	}

	// Kopf
	h := make([]byte, secSize)
	copy(h, []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1})
	binary.LittleEndian.PutUint16(h[24:], 0x003E)
	binary.LittleEndian.PutUint16(h[26:], 0x0003)
	binary.LittleEndian.PutUint16(h[28:], 0xFFFE)
	binary.LittleEndian.PutUint16(h[30:], 9)
	binary.LittleEndian.PutUint16(h[32:], 6)
	binary.LittleEndian.PutUint32(h[44:], uint32(nFAT))
	binary.LittleEndian.PutUint32(h[48:], dirStart)
	binary.LittleEndian.PutUint32(h[56:], cutoff)
	binary.LittleEndian.PutUint32(h[60:], miniFATStart)
	binary.LittleEndian.PutUint32(h[64:], uint32(miniFATCount))
	if nDIF > 0 {
		binary.LittleEndian.PutUint32(h[68:], difStart)
	} else {
		binary.LittleEndian.PutUint32(h[68:], endChain)
	}
	binary.LittleEndian.PutUint32(h[72:], uint32(nDIF))
	for k := 0; k < 109; k++ {
		v := uint32(freeSect)
		if k < nFAT {
			v = fatLocs[k]
		}
		binary.LittleEndian.PutUint32(h[76+k*4:], v)
	}
	var out bytes.Buffer
	out.Write(h)
	for _, sec := range sectors {
		out.Write(sec)
	}
	return out.Bytes()
}
