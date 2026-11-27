// mksyso erzeugt eine COFF-Ressourcendatei (.syso) mit Programm-Icon und Versionsinfo für Windows.
// Go bindet *.syso-Dateien im Paketordner beim Bauen automatisch ein.
//
//	go run ./tools/mksyso -ico windows/athan.ico -version 1.0.0 -out windows/rsrc_windows_amd64.syso
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

type res struct {
	typ, id, lang uint16
	data          []byte
}

func main() {
	ico := flag.String("ico", "athan.ico", "Icon-Datei")
	ver := flag.String("version", "1.0.0", "Version")
	out := flag.String("out", "rsrc_windows_amd64.syso", "Ausgabe")
	arch := flag.String("arch", "amd64", "amd64 oder arm64")
	flag.Parse()

	b, err := os.ReadFile(*ico)
	if err != nil {
		log.Fatal(err)
	}
	var resources []res
	count := int(binary.LittleEndian.Uint16(b[4:]))
	var group bytes.Buffer
	binary.Write(&group, binary.LittleEndian, []uint16{0, 1, uint16(count)})
	for i := 0; i < count; i++ {
		e := b[6+16*i : 6+16*(i+1)]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		resources = append(resources, res{3, uint16(i + 1), 0x0409, b[off : off+size]})
		group.Write(e[:12])                                    // width … bytesInRes
		binary.Write(&group, binary.LittleEndian, uint16(i+1)) // nID
	}
	resources = append(resources, res{14, 1, 0x0409, group.Bytes()})
	resources = append(resources, res{16, 1, 0x0409, versionInfo(*ver)})

	syso := coff(resources, *arch)
	if err := os.WriteFile(*out, syso, 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s: %d Icons, Version %s, %d Bytes\n", *out, count, *ver, len(syso))
}

// ---------- VS_VERSIONINFO ----------

func wstr(s string) []byte {
	u := utf16.Encode([]rune(s + "\x00"))
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, u)
	return b.Bytes()
}
func pad4(b *bytes.Buffer) {
	for b.Len()%4 != 0 {
		b.WriteByte(0)
	}
}

// node baut einen Versions-Block: wLength, wValueLength, wType, szKey, Wert, Kinder.
func node(key string, value []byte, valueLen uint16, typ uint16, children ...[]byte) []byte {
	var b bytes.Buffer
	b.Write([]byte{0, 0})
	binary.Write(&b, binary.LittleEndian, valueLen)
	binary.Write(&b, binary.LittleEndian, typ)
	b.Write(wstr(key))
	pad4(&b)
	b.Write(value)
	for _, c := range children {
		pad4(&b)
		b.Write(c)
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint16(out, uint16(len(out)))
	return out
}

func versionInfo(v string) []byte {
	parts := [4]uint16{}
	for i, p := range strings.SplitN(v, ".", 4) {
		n, _ := strconv.Atoi(p)
		parts[i] = uint16(n)
	}
	ms := uint32(parts[0])<<16 | uint32(parts[1])
	ls := uint32(parts[2])<<16 | uint32(parts[3])
	var fixed bytes.Buffer
	binary.Write(&fixed, binary.LittleEndian, []uint32{0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x00040004, 1, 0, 0, 0})
	str := func(k, val string) []byte {
		w := wstr(val)
		return node(k, w, uint16(len(w)/2), 1)
	}
	full := fmt.Sprintf("%d.%d.%d.%d", parts[0], parts[1], parts[2], parts[3])
	table := node("040904B0", nil, 0, 1,
		str("CompanyName", "Athan"),
		str("FileDescription", "Athan"),
		str("FileVersion", full),
		str("InternalName", "Athan"),
		str("LegalCopyright", "Frei, ohne Werbung"),
		str("OriginalFilename", "Athan.exe"),
		str("ProductName", "Athan – Gebetszeiten"),
		str("ProductVersion", full),
	)
	sfi := node("StringFileInfo", nil, 0, 1, table)
	trans := []byte{0x09, 0x04, 0xB0, 0x04}
	vfi := node("VarFileInfo", nil, 0, 1, node("Translation", trans, 4, 0))
	return node("VS_VERSION_INFO", fixed.Bytes(), uint16(fixed.Len()), 0, sfi, vfi)
}

// ---------- COFF mit .rsrc-Abschnitt ----------

func coff(rs []res, arch string) []byte {
	sort.Slice(rs, func(i, j int) bool {
		if rs[i].typ != rs[j].typ {
			return rs[i].typ < rs[j].typ
		}
		return rs[i].id < rs[j].id
	})
	types := []uint16{}
	byType := map[uint16][]int{}
	for i, r := range rs {
		if _, ok := byType[r.typ]; !ok {
			types = append(types, r.typ)
		}
		byType[r.typ] = append(byType[r.typ], i)
	}
	// Größen: Wurzel + Typ-Verzeichnisse + Sprach-Verzeichnisse + Datenbeschreibungen
	dirSize := func(n int) int { return 16 + 8*n }
	rootSize := dirSize(len(types))
	typeDirs := 0
	for _, t := range types {
		typeDirs += dirSize(len(byType[t]))
	}
	langDirs := len(rs) * dirSize(1)
	dataEntries := len(rs) * 16
	dataStart := rootSize + typeDirs + langDirs + dataEntries
	dataStart = (dataStart + 7) &^ 7

	sec := make([]byte, dataStart)
	put16 := func(o int, v uint16) { binary.LittleEndian.PutUint16(sec[o:], v) }
	put32 := func(o int, v uint32) { binary.LittleEndian.PutUint32(sec[o:], v) }
	dirHdr := func(o, n int) { put16(o+14, uint16(n)) }

	var relocs []uint32
	dirHdr(0, len(types))
	typeOff := rootSize
	langOff := rootSize + typeDirs
	entryOff := langOff + langDirs
	var blobs bytes.Buffer
	for ti, t := range types {
		put32(16+8*ti, uint32(t))
		put32(16+8*ti+4, 0x80000000|uint32(typeOff))
		idx := byType[t]
		dirHdr(typeOff, len(idx))
		for k, i := range idx {
			put32(typeOff+16+8*k, uint32(rs[i].id))
			put32(typeOff+16+8*k+4, 0x80000000|uint32(langOff))
			dirHdr(langOff, 1)
			put32(langOff+16, uint32(rs[i].lang))
			put32(langOff+20, uint32(entryOff))
			// Datenbeschreibung: RVA (per Relokation), Größe
			put32(entryOff, uint32(dataStart+blobs.Len()))
			put32(entryOff+4, uint32(len(rs[i].data)))
			relocs = append(relocs, uint32(entryOff))
			blobs.Write(rs[i].data)
			for blobs.Len()%8 != 0 {
				blobs.WriteByte(0)
			}
			langOff += dirSize(1)
			entryOff += 16
		}
		typeOff += dirSize(len(idx))
	}
	sec = append(sec, blobs.Bytes()...)

	machine, relType := uint16(0x8664), uint16(3) // IMAGE_REL_AMD64_ADDR32NB
	if arch == "arm64" {
		machine, relType = 0xAA64, 2 // IMAGE_REL_ARM64_ADDR32NB
	}
	var f bytes.Buffer
	w := func(v any) { binary.Write(&f, binary.LittleEndian, v) }
	const hdr, shdr = 20, 40
	rawPtr := uint32(hdr + shdr)
	relPtr := rawPtr + uint32(len(sec))
	symPtr := relPtr + uint32(10*len(relocs))
	// Dateikopf
	w(machine)
	w(uint16(1))
	w(uint32(0))
	w(symPtr)
	w(uint32(1))
	w(uint16(0))
	w(uint16(0))
	// Abschnittskopf
	f.WriteString(".rsrc\x00\x00\x00")
	w(uint32(0))
	w(uint32(0))
	w(uint32(len(sec)))
	w(rawPtr)
	w(relPtr)
	w(uint32(0))
	w(uint16(len(relocs)))
	w(uint16(0))
	w(uint32(0x40000040)) // INITIALIZED_DATA | MEM_READ
	f.Write(sec)
	for _, r := range relocs {
		w(r)
		w(uint32(0))
		w(relType)
	}
	// Symbol ".rsrc" (statisch, Abschnitt 1) + leere Stringtabelle
	f.WriteString(".rsrc\x00\x00\x00")
	w(uint32(0))
	w(int16(1))
	w(uint16(0))
	f.WriteByte(3)
	f.WriteByte(0)
	w(uint32(4))
	return f.Bytes()
}
