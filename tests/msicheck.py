# Unabhängiger Leser für MSI-Dateien (CFB + MSI-Tabellen + CAB), zum Prüfen von mkmsi.
import struct, sys, zlib
f = open(sys.argv[1], 'rb').read()
exe = open(sys.argv[2], 'rb').read() if len(sys.argv) > 2 else None
assert f[:8] == bytes.fromhex('D0CF11E0A1B11AE1'), 'Signatur'
minor, major, bo, ss, mss = struct.unpack_from('<HHHHH', f, 24)
assert (major, bo, ss, mss) == (3, 0xFFFE, 9, 6), (major, bo, ss, mss)
nfat, dirstart, _, cutoff, mfstart, nmf, difstart, ndif = struct.unpack_from('<IIIIIIII', f, 44)
SEC = 512
def sec(n): return f[512 + n*SEC: 512 + (n+1)*SEC]
fatlocs = [x for x in struct.unpack_from('<109I', f, 76)][:nfat]
d = difstart
while len(fatlocs) < nfat:
    s = sec(d); fatlocs += list(struct.unpack_from('<127I', s))[:nfat-len(fatlocs)]; d = struct.unpack_from('<I', s, 508)[0]
fat = []
for loc in fatlocs: fat += struct.unpack('<128I', sec(loc))
def chain(start):
    out, seen = [], set()
    while start != 0xFFFFFFFE:
        assert start not in seen and start < len(fat), 'Kette defekt'
        seen.add(start); out.append(start); start = fat[start]
    return out
def read(start, size): return b''.join(sec(c) for c in chain(start))[:size]
dirdata = b''.join(sec(c) for c in chain(dirstart))
ents = []
for i in range(len(dirdata)//128):
    e = dirdata[i*128:(i+1)*128]
    nl = struct.unpack_from('<H', e, 64)[0]
    name = e[:max(nl-2,0)].decode('utf-16le')
    typ, color = e[66], e[67]
    l, r, c = struct.unpack_from('<III', e, 68)
    start, size = struct.unpack_from('<IQ', e, 116)
    ents.append(dict(name=name, typ=typ, l=l, r=r, c=c, start=start, size=size, clsid=e[80:96]))
root = ents[0]; assert root['typ'] == 5
print('Root-CLSID:', root['clsid'].hex(), '(MSI)' if root['clsid'].hex() == '84100c0000000000c000000000000046' else '(?)')
ministream = read(root['start'], root['size']) if root['size'] else b''
minifat = []
if nmf: 
    for c in chain(mfstart): minifat += struct.unpack('<128I', sec(c))
def readmini(start, size):
    out = b''; s = start
    while s != 0xFFFFFFFE: out += ministream[s*64:(s+1)*64]; s = minifat[s]
    return out[:size]
# Baum durchlaufen + BST-Ordnung prüfen
def key(n): u = n.encode('utf-16le'); return (len(u), n.upper())
names = []
def walk(i, lo=None, hi=None):
    if i == 0xFFFFFFFF: return
    e = ents[i]; k = key(e['name'])
    assert (lo is None or lo < k) and (hi is None or k < hi), 'Baumordnung verletzt bei ' + repr(e['name'])
    walk(e['l'], lo, k); names.append(i); walk(e['r'], k, hi)
walk(root['c'])
def demangle(n):
    out = ''; tbl = False
    for ch in n:
        o = ord(ch)
        cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._'
        if o == 0x4840: tbl = True; continue
        if 0x3800 <= o < 0x4800: o -= 0x3800; out += cs[o & 63] + cs[o >> 6]
        elif 0x4800 <= o < 0x4840: out += cs[o - 0x4800]
        else: out += ch
    return ('T:' if tbl else '') + out
streams = {}
for i in names:
    e = ents[i]
    data = readmini(e['start'], e['size']) if e['size'] < cutoff else read(e['start'], e['size'])
    streams[demangle(e['name'])] = data
print('Streams:', ', '.join(f"{k}({len(v)})" for k, v in streams.items()))
pool = streams['T:_StringPool']; sdata = streams['T:_StringData']
cp = struct.unpack_from('<I', pool)[0] & 0x7fffffff
strs = [None]; off = 0
for i in range(1, len(pool)//4):
    ln, refs = struct.unpack_from('<HH', pool, i*4)
    strs.append(sdata[off:off+ln].decode('cp1252')); off += ln
assert off == len(sdata), 'Stringdaten-Länge'
print('Codepage', cp, '| Strings', len(strs)-1)
tables = [strs[v] for v in struct.unpack(f"<{len(streams['T:_Tables'])//2}H", streams['T:_Tables'])]
cb = streams['T:_Columns']; n = len(cb)//8
cols = list(zip(*[struct.unpack_from(f'<{n}H', cb, k*n*2) for k in range(4)]))
schema = {}
for t, num, name, typ in cols:
    schema.setdefault(strs[t], []).append((num-0x8000, strs[name], typ-0x8000))
ok = True
for t in tables:
    sc = sorted(schema[t])
    widths = [2 if (ty & 0x800) or (ty & 0xff) <= 2 else 4 for _, _, ty in sc]
    data = streams['T:' + t]
    rowsize = sum(widths); nrows = len(data)//rowsize
    assert nrows*rowsize == len(data), t + ' Länge'
    colvals = []; o = 0
    for (num, cname, ty), w in zip(sc, widths):
        vals = struct.unpack_from(f"<{nrows}{'H' if w == 2 else 'I'}", data, o); o += w*nrows
        if ty & 0x800: colvals.append([strs[v] if v else None for v in vals])
        elif w == 2: colvals.append([v - 0x8000 if v else None for v in vals])
        else: colvals.append([(v ^ 0x80000000) - (1<<32 if v ^ 0x80000000 >= 1<<31 else 0) if v else None for v in vals])
    print(f'\n[{t}]  ' + ' | '.join(f"{c}:{'s' if ty&0x800 else 'i'}{ty&0xff}{'K' if ty&0x2000 else ''}{'?' if ty&0x1000 else ''}" for _, c, ty in sc))
    for r in range(nrows): print('   ', [cv[r] for cv in colvals])
# CAB prüfen
cab = streams['athan.cab']
sig, _, cbcab, _, cofffiles, _, vmin, vmaj, nfold, nfiles, flags, setid, icab = struct.unpack_from('<4sIIIIIBBHHHHH', cab)
assert sig == b'MSCF' and cbcab == len(cab), 'CAB-Kopf'
cstart, ndata, comp = struct.unpack_from('<IHH', cab, 36)
o = cofffiles
size, uoff, ifold, date, tm, attr = struct.unpack_from('<IIHHHH', cab, o); o += 16
fname = cab[o:cab.index(b'\0', o)].decode()
o = cstart; out = b''; hist = b''
for i in range(ndata):
    csum, cb_, cu = struct.unpack_from('<IHH', cab, o); blk = cab[o+8:o+8+cb_]; o += 8 + cb_
    if comp == 0: u = blk
    else:
        assert blk[:2] == b'CK'
        dobj = zlib.decompressobj(-15, zdict=hist[-32768:]) if hist else zlib.decompressobj(-15)
        u = dobj.decompress(blk[2:])
    assert len(u) == cu, 'Blockgröße'
    out += u; hist += u
print(f'\nCAB: Datei "{fname}" {size} Bytes, {ndata} Blöcke ({"MSZIP" if comp else "unkomprimiert"}), entpackt {len(out)} Bytes')
if exe is not None: print('Identisch mit EXE:', out == exe)
