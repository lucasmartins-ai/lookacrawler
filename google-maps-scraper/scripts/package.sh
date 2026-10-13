#!/usr/bin/env sh
set -eu
version=${1:?version required}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dist="$root/dist"
rm -rf "$dist"; mkdir -p "$dist"
for target in linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64; do
  os=${target%/*}; arch=${target#*/}; ext=''; [ "$os" = windows ] && ext=.exe
  name="google-maps-scraper_${version}_${os}_${arch}${ext}"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags='-s -w' -o "$dist/$name" .
done
(cd "$dist" && sha256sum google-maps-scraper_* > SHA256SUMS)
