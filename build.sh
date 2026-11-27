#!/usr/bin/env bash
# Baut Athan.exe und Athan-Setup-<Version>.msi (läuft unter Linux, macOS und Git-Bash auf Windows).
# Voraussetzung: Go 1.22 oder neuer.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-$(grep -oE "VERSION = '[0-9.]+'" web/js/app.js | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")}"
mkdir -p dist

echo "→ Web-App in die Windows-App einbetten"
rm -rf windows/web && cp -r web windows/web

echo "→ Tests (Gebetszeiten JS = Go)"
if command -v node >/dev/null; then node tests/make-fixtures.mjs >/dev/null; fi
if [ -f windows/testdata/fixtures.json ]; then (cd windows && go test ./... >/dev/null); fi

echo "→ Icon und Versionsinfo"
(cd tools && go run ./mksyso -ico ../windows/athan.ico -version "$VERSION" -out ../windows/rsrc_windows_amd64.syso >/dev/null)

echo "→ Athan.exe (Windows x64)"
(cd windows && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-H windowsgui -s -w -X main.version=$VERSION" -o ../dist/Athan.exe .)

echo "→ MSI"
(cd tools && go run ./mkmsi -exe ../dist/Athan.exe -version "$VERSION" -out "../dist/Athan-Setup-$VERSION.msi")

(cd dist && sha256sum Athan.exe "Athan-Setup-$VERSION.msi" > SHA256SUMS.txt 2>/dev/null || shasum -a 256 Athan.exe "Athan-Setup-$VERSION.msi" > SHA256SUMS.txt)
echo "✓ Fertig: dist/"
ls -la dist
